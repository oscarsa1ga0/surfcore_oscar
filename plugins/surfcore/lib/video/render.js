/**
 * 渲染编排：把一份已校验的计划变成可试听的 MP4。
 *
 * 阶段顺序：plan → tts → captions → segments → final → cover → preview → qa
 *   · 所有子进程用参数数组 spawn，不经过 shell；滤镜表达式只由
 *     “校验过的计划数值”拼出来，计划内容不进入滤镜字符串（方案 §5.4）。
 *   · 字幕经受控 Pillow 脚本生成透明 PNG 后由 FFmpeg 按 cue 叠加，同时导出 SRT。
 *   · 镜头/字幕/配音按内容寻址缓存：打断重跑时已完成的部分直接复用（方案 §3）。
 *   · 最终工件先在 .tmp 里生成，ffprobe 校验通过后同盘原子重命名。
 *   · 输出 H.264 + AAC、yuv420p、faststart。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { ffmpegPath } from '../../tools/lib/ffmpeg.mjs';
import { GENERATOR_VERSION, sha256Of } from './project-store.js';
import { computeTimeline, planLines, FPS, PROFILE, validatePlan } from './plan.js';
import { validatePlanAssets, runPy } from './assets.js';
import { assertVideoDiskBudget, reserveDailyUsage } from './budget.js';
import { buildAudioMix, clipAudioFilter, resolveFfprobe, LOCAL_MEDIA_FORMATS } from './media.js';
import { assertOutboundIdentitySafe } from '../../tools/lib/outbound-guard.mjs';
import { synthesizeLines, synthesizeLinesWith, voiceFingerprint } from './voice.js';
import { projectDirFor, revisionDirFor, tmpDirFor } from './paths.js';

const NEUTRAL_BG = '0x101418';

export { resolveFfprobe } from './media.js';

function execFileP(cmd, args, { timeoutMs = 300_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, signal }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function stageError(code, message, hint = '') {
  const error = new Error(message);
  error.code = code;
  if (hint) error.hint = hint;
  return error;
}

const pad2 = (n) => String(n).padStart(2, '0');

export function srtTimestamp(ms) {
  const total = Math.max(0, Math.round(Number(ms)));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const milli = total % 1000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(milli).padStart(3, '0')}`;
}

export function buildSrt(captions) {
  const blocks = captions.map((caption, index) => [
    String(index + 1),
    `${srtTimestamp(caption.startMs)} --> ${srtTimestamp(caption.endMs)}`,
    caption.text,
  ].join('\n'));
  return `${blocks.join('\n\n')}\n`;
}

/** 归一化画幅（cover 裁满 / contain 衬底），返回滤镜片段。 */
function normalizeFilter(fit) {
  if (fit === 'contain') {
    return `scale=${PROFILE.width}:${PROFILE.height}:force_original_aspect_ratio=decrease,pad=${PROFILE.width}:${PROFILE.height}:(ow-iw)/2:(oh-ih)/2:color=${NEUTRAL_BG}`;
  }
  return `scale=${PROFILE.width}:${PROFILE.height}:force_original_aspect_ratio=increase,crop=${PROFILE.width}:${PROFILE.height}`;
}

function motionFilter(motion, frames) {
  // 注意：FFmpeg 9 的 zoompan 里旧文档的 `z`（上一帧缩放）变量已失效，
  // 要用 `zoom` 自增（zoom = 上一帧计算出的缩放值，会跨帧累积）。
  if (motion === 'zoom_in') {
    return `zoompan=z='min(zoom+0.0012,1.18)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${PROFILE.width}x${PROFILE.height}:fps=${FPS}`;
  }
  if (motion === 'pan') {
    return `zoompan=z=1.15:d=1:x='(iw-iw/zoom)*min(in/${Math.max(1, frames)},1)':y='ih/2-(ih/zoom/2)':s=${PROFILE.width}x${PROFILE.height}:fps=${FPS}`;
  }
  return null;
}

/**
 * 渲染某个版本（幂等：已完成的子工件按内容寻址复用）。
 * @param {object} deps
 *   store, root, projectId, revision,
 *   voiceSettings, synth (可选：测试注入合成器，优先于 voiceSettings),
 *   limits { maxTotalMs, maxOutputBytes, maxSceneMs },
 *   onProgress({stage, pct, detail}), abortSignal, log
 * @returns {Promise<{ok:boolean, summary:object, artifacts:Array}>}
 */
export async function renderRevision(deps) {
  const tmpDir = path.join(tmpDirFor(deps.root, deps.projectId, deps.revision), crypto.randomUUID());
  try {
    return await renderInScratch(deps, tmpDir);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function renderInScratch(deps, tmpDir) {
  const {
    store, root, projectId, revision,
    voiceSettings = null, synth = null,
    limits = {}, onProgress = () => {}, abortSignal = null, canCommit = () => true, log = () => {},
  } = deps;
  const revDir = revisionDirFor(root, projectId, revision);
  fs.mkdirSync(tmpDir, { recursive: true });
  const report = (stage, pct, detail) => onProgress({ stage, pct, detail });

  const gotPlan = store.getPlan(projectId, revision);
  if (!gotPlan) throw stageError('VIDEO_REVISION_MISSING', `版本不存在：${projectId}@${revision}`);
  const plan = gotPlan.plan;
  const validation = validatePlan(plan, { limits });
  if (!validation.ok) throw stageError('VIDEO_PLAN_INVALID', validation.errors[0].message, validation.errors[0].path);
  const sources = validatePlanAssets(store, root, plan);
  const textFields = [plan.title, plan.cover?.headline, plan.submission?.description, ...(plan.submission?.tags ?? [])];
  for (const scene of plan.scenes) {
    textFields.push(scene.titleCard, ...((scene.lines ?? []).flatMap((line) => [line.speech, line.caption])));
  }
  for (const { asset } of sources.values()) {
    textFields.push(asset.authorization?.credit, asset.authorization?.cardText);
  }
  try {
    assertOutboundIdentitySafe(textFields.filter(Boolean).join('\n'), { surface: 'B站 视频草稿' });
  } catch {
    throw stageError('VIDEO_PRIVATE_CONTENT', '草稿包含账号或私人身份信息', '清理旁白、字幕、标题、简介或素材署名后重试');
  }
  const cacheDir = path.join(projectDirFor(root, projectId), 'render-cache');
  const checkDisk = () => assertVideoDiskBudget(root, limits.videoDirMaxBytes);
  checkDisk();

  // ── 1. 配音 ──────────────────────────────────────────────
  report('tts', 5, '解析计划旁白');
  const lines = planLines(plan);
  const ttsDir = path.join(cacheDir, 'tts');
  let lineResults;
  let fingerprint;
  if (!lines.length) {
    fingerprint = 'no-narration';
    lineResults = {};
  } else if (synth) {
    fingerprint = 'fixture-synth';
    lineResults = await synthesizeLinesWith(synth, lines, ttsDir, { onProgress: (done, total, lineId) => report('tts', 5 + Math.round((done / Math.max(1, total)) * 25), `合成旁白 ${done}/${total}`), abortSignal });
  } else {
    if (!voiceSettings) throw stageError('VIDEO_NO_VOICE', '缺少音色配置');
    fingerprint = voiceFingerprint(voiceSettings);
    lineResults = await synthesizeLines(lines, voiceSettings, ttsDir, {
      charge: (units) => reserveDailyUsage(store.db, 'tts', units, limits.dailyTtsChars),
      onProgress: (done, total, lineId) => report('tts', 5 + Math.round((done / Math.max(1, total)) * 25), `合成旁白 ${done}/${total}`), abortSignal });
  }
  const voiceDurations = Object.create(null);
  for (const [lineId, result] of Object.entries(lineResults)) voiceDurations[lineId] = result.durationMs;

  // ── 2. 时间轴 ────────────────────────────────────────────
  const timeline = computeTimeline(plan, voiceDurations, { limits });
  if (!timeline.ok) {
    const first = timeline.errors[0];
    throw stageError(first?.code ?? 'VIDEO_TIMELINE', first?.message ?? '时间轴校验失败', first?.path ? `改计划或旁白后再渲染（位置 ${first.path}）` : '改计划或旁白后再渲染');
  }
  checkDisk();
  report('tts', 30, `时间轴 ${(timeline.totalMs / 1000).toFixed(1)}s / ${timeline.scenes.length} 镜头`);

  const manifest = {
    schemaVersion: 1,
    generatorVersion: GENERATOR_VERSION,
    voiceFingerprint: fingerprint,
    planHash: gotPlan.planHash,
    totalMs: timeline.totalMs,
    createdAt: new Date().toISOString(),
    scenes: timeline.scenes.map((s) => ({ id: s.id, startMs: s.startMs, durationMs: s.durationMs, mode: s.mode, assetId: s.assetId })),
    lineDurations: voiceDurations,
    captionCount: timeline.captions.length,
    assets: [...sources.values()].map(({ asset }) => ({
      id: asset.id, kind: asset.kind, sha256: asset.sha256, source: asset.source,
      authorization: asset.authorization,
    })),
    limits,
  };
  fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // ── 3. 字幕贴图 + SRT ────────────────────────────────────
  report('captions', 32, '生成字幕贴图');
  const captionDir = path.join(cacheDir, 'captions');
  fs.mkdirSync(captionDir, { recursive: true });
  const fontProbe = runPy(['probe']);
  if (!fontProbe?.ok || !fontProbe?.font) {
    throw stageError('VIDEO_NO_FONT', '找不到可用中文字体', '安装 PingFang / Noto Sans CJK 后重试');
  }
  const layoutWarnings = [];
  for (const [index, caption] of timeline.captions.entries()) {
    if (abortSignal?.aborted) throw stageError('VIDEO_CANCELLED', '渲染被取消');
    const key = sha256Of(JSON.stringify([caption.text, fontProbe.font, GENERATOR_VERSION])).slice(0, 24);
    const file = path.join(captionDir, `cap-${key}.png`);
    if (!fs.existsSync(file) || !fs.existsSync(`${file}.json`)) {
      const part = `${file}.part-${process.pid}`;
      const result = runPy(['text', '--out', part, '--text', caption.text, '--font', fontProbe.font, '--font-size', '52', '--max-lines', '2', '--align', 'bottom']);
      if (!result?.ok) {
        try { fs.unlinkSync(part); } catch {}
        throw stageError('VIDEO_CAPTION_FAILED', `字幕生成失败：${result?.error ?? '未知'}`);
      }
      fs.renameSync(part, file);
      fs.writeFileSync(`${file}.json`, JSON.stringify({ fitted: result.fitted, missingGlyphs: result.missingGlyphs }));
    }
    const layout = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
    if (!layout.fitted || layout.missingGlyphs?.length || caption.endMs - caption.startMs < 350) {
      layoutWarnings.push({
        name: 'caption-layout', detail: `${caption.sceneId} · ${caption.startMs}ms：${!layout.fitted ? '字幕过长或被截断' : layout.missingGlyphs?.length ? '字体缺字' : '字幕显示不足 350ms'}`,
      });
    }
    caption.file = file;
    if (index % 8 === 0) report('captions', 32 + Math.round(((index + 1) / Math.max(1, timeline.captions.length)) * 10), `字幕 ${index + 1}/${timeline.captions.length}`);
  }
  const srtPath = path.join(tmpDir, 'captions.srt');
  fs.writeFileSync(srtPath, buildSrt(timeline.captions), 'utf8');
  // 标题卡贴图
  const titleCards = {};
  for (const scene of timeline.scenes) {
    if (!scene.titleCard) continue;
    const key = sha256Of(JSON.stringify([scene.titleCard.text, fontProbe.font, GENERATOR_VERSION])).slice(0, 24);
    const file = path.join(captionDir, `title-${key}.png`);
    if (!fs.existsSync(file)) {
      const part = `${file}.part-${process.pid}`;
      const result = runPy(['text', '--out', part, '--text', scene.titleCard.text, '--font', fontProbe.font, '--font-size', '76', '--max-lines', '2', '--align', 'center']);
      if (!result?.ok) {
        try { fs.unlinkSync(part); } catch {}
        throw stageError('VIDEO_CAPTION_FAILED', `标题卡生成失败：${result?.error ?? '未知'}`);
      }
      fs.renameSync(part, file);
    }
    titleCards[scene.id] = file;
  }

  // ── 4. 分镜渲染 ──────────────────────────────────────────
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) throw stageError('VIDEO_NO_FFMPEG', '找不到 ffmpeg', 'brew install ffmpeg 或设置 FFMPEG 环境变量');
  const ffprobe = resolveFfprobe();
  if (!ffprobe) throw stageError('VIDEO_NO_FFPROBE', '找不到 ffprobe（和 ffmpeg 同目录）', 'brew install ffmpeg 后重试');
  const segDir = path.join(cacheDir, 'segments');
  fs.mkdirSync(segDir, { recursive: true });
  const sceneAudioDir = path.join(cacheDir, 'audio');
  fs.mkdirSync(sceneAudioDir, { recursive: true });
  const segments = [];
  let reservedRender = false;
  const reserveRender = () => {
    if (reservedRender) return;
    reserveDailyUsage(store.db, 'render', Math.ceil(timeline.totalMs / 1000), limits.dailyRenderSeconds);
    reservedRender = true;
  };
  for (const [index, scene] of timeline.scenes.entries()) {
    if (abortSignal?.aborted) throw stageError('VIDEO_CANCELLED', '渲染被取消');
    report('render', 42 + Math.round((index / timeline.scenes.length) * 40), `镜头 ${scene.id}（${index + 1}/${timeline.scenes.length}）`);
    const { asset, file: assetFile } = sources.get(scene.assetId);
    const clip = asset.kind === 'clip';
    const frames = Math.round((scene.durationMs / 1000) * FPS);
    const durSec = (scene.durationMs / 1000).toFixed(3);

    // 内容寻址的分镜签名：素材 hash + 构图/动效 + 字幕贴图 hash + 字幕时间窗
    //（时间窗变了必须重编码，否则缓存复用的片段还带旧 overlay 时间）
    const sceneCaptions = timeline.captions.filter((c) => c.sceneId === scene.id);
    const captionKeys = sceneCaptions.map((c) => [path.basename(c.file), c.startMs - scene.startMs, c.endMs - scene.startMs]);
    const signature = sha256Of(JSON.stringify([
      asset.sha256, scene.fit, scene.motion, scene.durationMs, captionKeys,
      scene.inMs, scene.outMs, scene.fadeInMs, scene.fadeOutMs,
      scene.titleCard ? sha256File(titleCards[scene.id]) : null, GENERATOR_VERSION,
    ])).slice(0, 24);
    const segFile = path.join(segDir, `seg-${signature}.mp4`);
    const reusedVideo = await isUsableMedia(ffprobe, segFile);

    if (!reusedVideo) {
      reserveRender();
      const overlayDefs = [];
      for (const caption of sceneCaptions) {
        const start = ((caption.startMs - scene.startMs) / 1000).toFixed(3);
        const end = ((caption.endMs - scene.startMs) / 1000).toFixed(3);
        overlayDefs.push({ file: caption.file, start, end });
      }
      if (scene.titleCard) overlayDefs.push({ file: titleCards[scene.id], start: '0.000', end: durSec });

      const clipStart = ((scene.inMs ?? 0) / 1000).toFixed(3);
      const clipLength = (((scene.outMs ?? 0) - (scene.inMs ?? 0)) / 1000).toFixed(3);
      const inputs = clip
        ? ['-protocol_whitelist', 'file', '-format_whitelist', LOCAL_MEDIA_FORMATS, '-ss', clipStart, '-t', clipLength, '-i', assetFile]
        : ['-loop', '1', '-framerate', String(FPS), '-t', durSec, '-i', assetFile];
      for (const overlay of overlayDefs) inputs.push('-loop', '1', '-t', durSec, '-i', overlay.file);

      const parts = [];
      const base = normalizeFilter(scene.fit);
      const motion = motionFilter(scene.motion, frames);
      const clipFilter = clip ? `fps=${FPS},tpad=stop_mode=clone:stop_duration=0.067,` : '';
      parts.push(`[0:v:0]${clipFilter}${base},setsar=1${motion ? `,${motion}` : ''},format=yuv420p[m0]`);
      overlayDefs.forEach((overlay, i) => {
        const inLabel = i + 1;
        const outLabel = i + 1 === overlayDefs.length ? 'overlaid' : `m${i + 1}`;
        const prev = i === 0 ? 'm0' : `m${i}`;
        parts.push(`[${inLabel}:v]format=rgba[o${inLabel}]`);
        parts.push(`[${prev}][o${inLabel}]overlay=0:0:enable='gte(t,${overlay.start})*lt(t,${overlay.end})'[${outLabel}]`);
      });
      const fades = [];
      if (scene.fadeInMs) fades.push(`fade=t=in:st=0:d=${scene.fadeInMs / 1000}`);
      if (scene.fadeOutMs) fades.push(`fade=t=out:st=${(scene.durationMs - scene.fadeOutMs) / 1000}:d=${scene.fadeOutMs / 1000}`);
      parts.push(`[${overlayDefs.length ? 'overlaid' : 'm0'}]${fades.join(',') || 'null'}[vout]`);
      const filter = parts.join(';');
      const segArgs = [...inputs, '-filter_complex', filter, '-map', '[vout]', '-frames:v', String(frames), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an'];
      await writeAtomic(segFile, (part) => runFfmpeg(ffmpeg, [...segArgs, '-f', 'mp4', '-y', part], { abortSignal, log }));
    }

    // 场景音轨：旁白拼接 + 尾静音到镜头时长
    const audioSig = sha256Of(JSON.stringify([scene.cues.map((c) => [lineResults[c.lineId]?.sha256 ?? '', c.startMs]), scene.durationMs])).slice(0, 24);
    const sceneWav = path.join(sceneAudioDir, `audio-${audioSig}.wav`);
    const reusedAudio = await isUsableMedia(ffprobe, sceneWav, { minBytes: 1024 });
    if (!reusedAudio) {
      const cueWavs = scene.cues.map((cue) => lineResults[cue.lineId]?.file).filter(Boolean);
      await writeAtomic(sceneWav, async (part) => {
        if (cueWavs.length) {
          const concatInputs = cueWavs.flatMap((f) => ['-i', f]);
          // 句间停顿：按 cue 起始时刻对每句 adelay（静音垫到位置），再 amix 叠加
          const offsets = scene.cues.map((cue) => Math.max(0, Math.round(cue.startMs)));
          const delayed = cueWavs.map((_, i) => `[${i}:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo${offsets[i] > 0 ? `,adelay=${offsets[i]}:all=1` : ''}[a${i}]`);
          const mix = `${cueWavs.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cueWavs.length}:duration=longest:normalize=0,atrim=0:${durSec}[voiced]`;
          const concatFilter = [...delayed, mix].join(';');
          const tmpVoice = path.join(tmpDir, `voice-${scene.id}.wav`);
          await runFfmpeg(ffmpeg, [...concatInputs, '-filter_complex', concatFilter, '-map', '[voiced]', '-y', tmpVoice], { abortSignal, log });
          await runFfmpeg(ffmpeg, ['-i', tmpVoice, '-af', `aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo,apad=pad_dur=999,atrim=0:${durSec}`, '-f', 'wav', '-y', part], { abortSignal, log });
        } else {
          await runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', durSec, '-c:a', 'pcm_s16le', '-f', 'wav', '-y', part], { abortSignal, log });
        }
      });
    }
    let originalWav = null;
    if (clip && scene.audio === 'mix') {
      const key = sha256Of(JSON.stringify([asset.sha256, scene.inMs, scene.outMs, scene.durationMs, GENERATOR_VERSION])).slice(0, 24);
      originalWav = path.join(sceneAudioDir, `original-${key}.wav`);
      if (!(await isUsableMedia(ffprobe, originalWav, { minBytes: 1024 }))) {
        await writeAtomic(originalWav, (part) => runFfmpeg(ffmpeg, [
          '-protocol_whitelist', 'file', '-format_whitelist', LOCAL_MEDIA_FORMATS, '-i', assetFile, '-filter_complex', clipAudioFilter(0, scene, scene.durationMs, 'clipAudio'),
          '-map', '[clipAudio]', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', part,
        ], { abortSignal, log }));
      }
    }
    segments.push({ file: segFile, wav: sceneWav, originalWav, scene, reusedVideo, reusedAudio });
  }

  // ── 5. 合成成片 ──────────────────────────────────────────
  report('render', 82, '合成成片');
  const finalTmp = path.join(tmpDir, 'final.mp4');
  const finalInputs = [];
  const vChains = [];
  const aChains = [];
  segments.forEach((segment, i) => {
    finalInputs.push('-i', segment.file, '-i', segment.wav);
    vChains.push(`[${i * 2}:v]`);
    aChains.push(`[${i * 2 + 1}:a]`);
  });
  const filter = [
    `${vChains.join('')}concat=n=${segments.length}:v=1:a=0[vout]`,
    `${aChains.join('')}concat=n=${segments.length}:v=0:a=1[narration]`,
  ];
  const hasOriginal = segments.some((segment) => segment.originalWav);
  let silenceIndex = 0;
  if (hasOriginal) {
    const originalChains = segments.map((segment) => {
      if (!segment.originalWav) {
        const label = `origSilent${silenceIndex++}`;
        filter.push(`anullsrc=r=44100:cl=stereo,atrim=end=${segment.scene.durationMs / 1000}[${label}]`);
        return `[${label}]`;
      }
      const index = finalInputs.length / 2;
      finalInputs.push('-i', segment.originalWav);
      return `[${index}:a]`;
    });
    filter.push(`${originalChains.join('')}concat=n=${segments.length}:v=0:a=1[original]`);
  }
  const narrationTmp = path.join(tmpDir, 'narration.wav');
  const narrationKey = sha256Of(JSON.stringify(segments.map((segment) => path.basename(segment.wav))));
  const cachedNarration = path.join(sceneAudioDir, `narration-${narrationKey}.wav`);
  if (lines.length && !(await isUsableMedia(ffprobe, cachedNarration, { minBytes: 1024 }))) {
    await writeAtomic(cachedNarration, (part) => runFfmpeg(ffmpeg, [
      ...segments.flatMap((segment) => ['-i', segment.wav]),
      '-filter_complex', `${segments.map((_, i) => `[${i}:a]`).join('')}concat=n=${segments.length}:v=0:a=1[voice]`,
      '-map', '[voice]', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', part,
    ], { abortSignal, log }));
  }
  if (lines.length) fs.linkSync(cachedNarration, narrationTmp);
  if (abortSignal?.aborted) throw stageError('VIDEO_CANCELLED', '渲染被取消');
  if (lines.length) {
    const speechDuration = await execFileP(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', narrationTmp], { signal: abortSignal });
    if (!(Math.abs(Number(speechDuration.stdout.trim()) * 1000 - timeline.totalMs) <= 100)) {
      throw stageError('VIDEO_NARRATION_DURATION', '旁白试听的时长与成片不一致');
    }
  }
  const tracks = timeline.audioTracks.map((track) => ({ ...track, file: sources.get(track.assetId).file }));
  const mix = buildAudioMix(tracks, finalInputs.length / 2, timeline.totalMs, { spoken: Boolean(lines.length), original: hasOriginal });
  const mediaKey = sha256Of(JSON.stringify([
    GENERATOR_VERSION, segments.map((segment) => [segment.file, segment.wav, segment.originalWav]).map((files) => files.map((file) => file && path.basename(file))),
    tracks.map(({ file, ...track }) => [sources.get(track.assetId).asset.sha256, track]),
  ]));
  const renderedDir = path.join(cacheDir, 'final');
  fs.mkdirSync(renderedDir, { recursive: true });
  const cachedFinal = path.join(renderedDir, `${mediaKey}.mp4`);
  const reusedFinal = await isUsableMedia(ffprobe, cachedFinal);
  if (!reusedFinal) {
    reserveRender();
    checkDisk();
    const finalArgs = [
      ...finalInputs, ...mix.inputs, '-filter_complex', [...filter, ...mix.filters].join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
    ];
    await writeAtomic(cachedFinal, (part) => runFfmpeg(ffmpeg, [...finalArgs, '-f', 'mp4', '-y', part], { abortSignal, log }));
  }
  fs.linkSync(cachedFinal, finalTmp);

  // ── 6. 封面 / 预览 / 质检 ─────────────────────────────────
  report('qa', 92, '封面与预览');
  const coverTmp = path.join(tmpDir, 'cover.png');
  const coverBase = path.join(tmpDir, 'cover-base.png');
  if (timeline.cover) {
    const scene = timeline.scenes.find((s) => s.id === timeline.cover.sceneId) ?? timeline.scenes[0];
    const t = ((scene.startMs + Math.min(timeline.cover.offsetMs, scene.durationMs - 40)) / 1000).toFixed(3);
    await runFfmpeg(ffmpeg, ['-ss', t, '-i', finalTmp, '-frames:v', '1', '-y', coverBase], { abortSignal, log });
    const coverResult = runPy(['cover', '--base', coverBase, '--headline', timeline.cover.headline, '--font', fontProbe.font, '--out', coverTmp]);
    if (!coverResult?.ok) throw stageError('VIDEO_COVER_FAILED', `封面生成失败：${coverResult?.error ?? '未知'}`);
  } else {
    await runFfmpeg(ffmpeg, ['-i', finalTmp, '-frames:v', '1', '-y', coverTmp], { abortSignal, log });
  }

  const hasSound = Boolean(lines.length || tracks.length || hasOriginal);
  const qa = await runQa(ffmpeg, ffprobe, finalTmp, timeline.totalMs, limits, { hasSound, signal: abortSignal });
  qa.warnings.push(...layoutWarnings);
  if (lines.length) {
    const narrationQa = await audioLevel(ffmpeg, narrationTmp, abortSignal);
    qa.checks.push({ name: 'narration', pass: narrationQa.peak > -45, detail: `旁白峰值 ${narrationQa.peak} dBFS` });
    qa.ok = qa.checks.every((check) => check.pass);
  }

  if (!qa.ok) {
    throw stageError(qa.code ?? 'VIDEO_QA_FAILED', `技术质检未通过：${qa.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`).join('；')}`, '按提示修计划/素材后重新渲染');
  }
  const gridTmp = path.join(tmpDir, 'preview-grid.png');
  const interval = Math.max(1, Math.ceil((timeline.totalMs / 1000) / 9));
  await runFfmpeg(ffmpeg, ['-i', finalTmp, '-vf', `fps=1/${interval},scale=320:180,tile=3x3`, '-frames:v', '1', '-y', gridTmp], { abortSignal, log });

  const framesDir = path.join(tmpDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const sceneFrames = [];
  for (const scene of timeline.scenes) {
    const t = ((scene.startMs + Math.min(Math.floor(scene.durationMs / 2), scene.durationMs - 40)) / 1000).toFixed(3);
    const frameFile = path.join(framesDir, `${scene.id}.png`);
    await runFfmpeg(ffmpeg, ['-ss', t, '-i', finalTmp, '-frames:v', '1', '-y', frameFile], { abortSignal, log });
    const offsetMs = Math.min(Math.floor(scene.durationMs / 2), scene.durationMs - 40);
    sceneFrames.push({ sceneId: scene.id, offsetMs, atMs: scene.startMs + offsetMs,
      file: path.relative(root, path.join(revDir, 'frames', `${scene.id}.png`)) });

  }
  const previewJson = {
    generatorVersion: GENERATOR_VERSION,
    totalMs: timeline.totalMs,
    intervalSec: interval,
    scenes: timeline.scenes.map((s) => ({
      id: s.id, startMs: s.startMs, endMs: s.endMs, durationMs: s.durationMs,
      mode: s.mode, assetId: s.assetId, fit: s.fit, motion: s.motion,
      cues: s.cues.map((c) => ({ lineId: c.lineId, startMs: s.startMs + c.startMs, endMs: s.startMs + c.endMs, text: c.text })),
      titleCard: s.titleCard?.text ?? null,
    })),
    narration: lines.map((line) => ({ ...line, durationMs: voiceDurations[line.lineId] })),
    audioTracks: timeline.audioTracks,
    captions: timeline.captions.map(({ file, ...cue }) => cue),
    frames: sceneFrames,
  };
  fs.writeFileSync(path.join(tmpDir, 'preview.json'), JSON.stringify(previewJson, null, 2));

  // ── 7. 原子落盘 ──────────────────────────────────────────
  if (abortSignal?.aborted) throw stageError('VIDEO_CANCELLED', '渲染任务已取消');
  if (!canCommit()) throw stageError('VIDEO_CANCELLED', '渲染任务已被取消或接管');
  validatePlanAssets(store, root, plan);
  checkDisk();
  fs.mkdirSync(path.join(revDir, 'frames'), { recursive: true });
  const records = [];
  const commit = (name, kind, extra = {}) => {
    const tmpFile = path.join(tmpDir, name);
    const finalFile = path.join(revDir, name);
    fs.renameSync(tmpFile, finalFile);
    const sizeBytes = fs.statSync(finalFile).size;
    const sha256 = sha256File(finalFile);
    records.push({
      kind, sha256, relativePath: name, sizeBytes,
      generatorVersion: GENERATOR_VERSION,
      ...extra,
    });
    return { kind, file: finalFile, sha256, sizeBytes };
  };
  commit('manifest.json', 'manifest', { meta: { totalMs: timeline.totalMs } });
  commit('final.mp4', 'mp4', { durationMs: timeline.totalMs });
  commit('captions.srt', 'srt', { durationMs: timeline.totalMs });
  commit('cover.png', 'cover');
  commit('preview-grid.png', 'preview-grid');
  for (const frame of sceneFrames) commit(`frames/${frame.sceneId}.png`, `frame-${frame.sceneId}`, { meta: { atMs: frame.atMs } });
  if (lines.length) commit('narration.wav', 'narration', { durationMs: timeline.totalMs });
  fs.writeFileSync(path.join(tmpDir, 'qa.json'), JSON.stringify(qa, null, 2));
  commit('qa.json', 'qa', { meta: { pass: qa.ok, warnings: qa.warnings } });
  commit('preview.json', 'preview', { meta: {
    scenes: timeline.scenes.length, timeline: { totalMs: timeline.totalMs, scenes: timeline.scenes.map((scene) => ({
      id: scene.id, startMs: scene.startMs, endMs: scene.endMs, durationMs: scene.durationMs,
    })) }, reusedFinal, reusedScenes: segments.filter((segment) => segment.reusedVideo).map((segment) => segment.scene.id),
    reusedNarrationScenes: segments.filter((segment) => segment.reusedAudio).map((segment) => segment.scene.id),
  } });
  store.recordArtifacts(projectId, revision, records);

  return {
    ok: true,
    summary: {
      totalMs: timeline.totalMs,
      scenes: timeline.scenes.length,
      captions: timeline.captions.length,
      voiceFingerprint: fingerprint,
      qa,
    },
    artifacts: store.listArtifacts(projectId, revision),
  };
}

/** 跑 FFmpeg：参数数组、超时、取消；失败时把 stderr 尾部带进错误。 */
async function runFfmpeg(ffmpeg, args, { abortSignal = null, log = () => {}, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const kill = () => { try { child.kill('SIGKILL'); } catch {} };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(stageError('VIDEO_FFMPEG_TIMEOUT', `FFmpeg 超过 ${Math.round(timeoutMs / 1000)}s 未完成`, '检查磁盘空间和输入素材，重新渲染'));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 32 * 1024) stderr = stderr.slice(-16 * 1024);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', kill);
      reject(stageError('VIDEO_FFMPEG_SPAWN', `FFmpeg 启动失败：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', kill);
      if (code === 0) {
        resolve();
      } else if (abortSignal?.aborted) {
        reject(stageError('VIDEO_CANCELLED', '渲染被取消'));
      } else {
        log(`[video] ffmpeg 失败（code=${code}）：${stderr.slice(-600)}`);
        reject(stageError('VIDEO_FFMPEG_FAILED', `FFmpeg 失败（code=${code}）：${stderr.slice(-240).trim()}`));
      }
    });
    if (abortSignal) {
      if (abortSignal.aborted) kill();
      else abortSignal.addEventListener('abort', kill, { once: true });
    }
  });
}

/**
 * 原子写：内容先生成到 `final` 旁边的临时文件，成功后 rename。
 * 被打断的渲染只可能留下 .part 残片，绝不会污染内容寻址缓存（方案 §3）。
 */
async function writeAtomic(finalFile, producer) {
  const part = `${finalFile}.part-${process.pid}-${Date.now()}`;
  try {
    await producer(part);
    fs.renameSync(part, finalFile);
  } catch (error) {
    try { fs.unlinkSync(part); } catch {}
    throw error;
  }
}

/** 复用缓存前校验：半成品/损坏文件绝不进合成链。 */
async function isUsableMedia(ffprobe, file, { minBytes = 4096 } = {}) {
  try {
    if (!fs.existsSync(file)) return false;
    if (fs.statSync(file).size < minBytes) return false;
    await execFileP(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', file], { timeoutMs: 30_000 });
    return true;
  } catch {
    try { fs.unlinkSync(file); } catch {}
    return false;
  }
}

/** 技术质检（方案 §5.5）：ffprobe 两流/画幅/时长/体积 + 音量 + 黑帧抽样。 */
async function audioLevel(ffmpeg, file, signal) {
  const { stderr } = await execFileP(ffmpeg, ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 120_000, signal });
  return {
    mean: Number(/mean_volume:\s*([-\d.]+)/.exec(stderr)?.[1] ?? -91),
    peak: Number(/max_volume:\s*([-\d.]+)/.exec(stderr)?.[1] ?? -91),
  };
}

async function runQa(ffmpeg, ffprobe, finalFile, totalMs, limits, { hasSound, signal }) {
  const checks = [];
  const warnings = [];
  const probeArgs = ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', finalFile];
  const probe = JSON.parse((await execFileP(ffprobe, probeArgs, { signal })).stdout);
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = probe.format ?? {};

  checks.push({
    name: 'video-stream', pass: Boolean(video),
    detail: video ? `codec=${video.codec_name} ${video.width}x${video.height}@${video.r_frame_rate}` : '没有视频流',
  });
  checks.push({ name: 'audio-stream', pass: Boolean(audio), detail: audio ? `codec=${audio.codec_name}` : '没有音轨' });
  checks.push({
    name: 'resolution',
    pass: Boolean(video && Number(video.width) === PROFILE.width && Number(video.height) === PROFILE.height),
    detail: video ? `${video.width}x${video.height}` : '无',
  });
  const durationMs = Number(format.duration) * 1000;
  const drift = Math.abs(durationMs - totalMs);
  checks.push({
    name: 'duration',
    pass: drift <= 500,
    detail: `成片 ${(durationMs / 1000).toFixed(2)}s vs 时间轴 ${(totalMs / 1000).toFixed(2)}s（差 ${Math.round(drift)}ms）`,
  });
  const sizeBytes = Number(format.size);
  const maxBytes = Number(limits.maxOutputBytes) > 0 ? Number(limits.maxOutputBytes) : 100 * 1024 * 1024;
  checks.push({
    name: 'size',
    pass: sizeBytes > 0 && sizeBytes <= maxBytes,
    detail: `${(sizeBytes / 1024 / 1024).toFixed(1)}MB（上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB）`,
  });
  checks.push({
    name: 'h264',
    pass: Boolean(video && video.codec_name === 'h264'),
    detail: video?.codec_name ?? '无',
  });

  if (hasSound) {
    const level = await audioLevel(ffmpeg, finalFile, signal);
    checks.push({ name: 'audible', pass: level.peak > -45 && level.mean > -60,
      detail: `mean=${level.mean.toFixed(1)}dB max=${level.peak.toFixed(1)}dB` });
    const measured = await execFileP(ffmpeg, ['-i', finalFile, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
      '-vn', '-f', 'null', '-'], { timeoutMs: 120_000, signal });
    const metrics = /\{\s*"input_i"[\s\S]*?\}/.exec(measured.stderr);
    if (metrics) {
      const values = JSON.parse(metrics[0]);
      const integrated = Number(values.input_i);
      const peak = Number(values.input_tp);
      checks.push({ name: 'true-peak', pass: Number.isFinite(peak) && peak <= -1,
        detail: `${peak} dBTP（上限 −1 dBTP）` });
      if (!Number.isFinite(integrated) || Math.abs(integrated + 16) > 3) {
        warnings.push({ name: 'loudness', detail: `综合响度 ${integrated} LUFS，目标约 −16 LUFS` });
      }
    } else {
      warnings.push({ name: 'loudness', detail: '未读到响度测量值' });
    }
  }

  // 黑帧抽样（允许计划黑场，但整段长黑要提示）
  try {
    const black = await execFileP(ffmpeg, ['-i', finalFile, '-vf', 'blackdetect=d=1.0:pix_th=0.10', '-an', '-f', 'null', '-'], { timeoutMs: 120_000, signal });
    const count = (black.stderr.match(/black_start/g) ?? []).length;
    if (count > 0) warnings.push({ name: 'black-frames', detail: `检测到 ${count} 段 ≥1s 黑帧（如有计划黑场可忽略）` });
  } catch {}

  return {
    ok: checks.every((c) => c.pass),
    checks,
    warnings,
    durationMs: Math.round(durationMs),
    sizeBytes,
  };
}
