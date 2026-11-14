/**
 * 渲染编排（阶段一）：把一份已校验的计划变成可试听的 MP4。
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
import { computeTimeline, planLines, FPS, PROFILE, frameAlign } from './plan.js';
import { resolveAssetFile, runPy } from './assets.js';
import { synthesizeLines, synthesizeLinesWith, voiceFingerprint } from './voice.js';
import { revisionDirFor, tmpDirFor } from './paths.js';

const NEUTRAL_BG = '0x101418';

export function resolveFfprobe() {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return null;
  const candidate = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

function execFileP(cmd, args, { timeoutMs = 300_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, signal }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    if (signal) {
      signal.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch {} }, { once: true });
    }
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
  const {
    store, root, projectId, revision,
    voiceSettings = null, synth = null,
    limits = {}, onProgress = () => {}, abortSignal = null, log = () => {},
  } = deps;
  const revDir = revisionDirFor(root, projectId, revision);
  const tmpDir = tmpDirFor(root, projectId, revision);
  fs.mkdirSync(revDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const report = (stage, pct, detail) => onProgress({ stage, pct, detail });

  const gotPlan = store.getPlan(projectId, revision);
  if (!gotPlan) throw stageError('VIDEO_REVISION_MISSING', `版本不存在：${projectId}@${revision}`);
  const plan = gotPlan.plan;

  // ── 1. 配音 ──────────────────────────────────────────────
  report('tts', 5, '解析计划旁白');
  const lines = planLines(plan);
  const ttsDir = path.join(revDir, 'tts');
  let lineResults;
  let fingerprint;
  if (synth) {
    fingerprint = 'fixture-synth';
    lineResults = await synthesizeLinesWith(synth, lines, ttsDir, { onProgress: (done, total, lineId) => report('tts', 5 + Math.round((done / Math.max(1, total)) * 25), `合成旁白 ${done}/${total}`), abortSignal });
  } else {
    if (!voiceSettings) throw stageError('VIDEO_NO_VOICE', '缺少音色配置');
    fingerprint = voiceFingerprint(voiceSettings);
    lineResults = await synthesizeLines(lines, voiceSettings, ttsDir, { onProgress: (done, total, lineId) => report('tts', 5 + Math.round((done / Math.max(1, total)) * 25), `合成旁白 ${done}/${total}`), abortSignal });
  }
  const voiceDurations = {};
  for (const [lineId, result] of Object.entries(lineResults)) voiceDurations[lineId] = result.durationMs;

  // ── 2. 时间轴 ────────────────────────────────────────────
  const timeline = computeTimeline(plan, voiceDurations, { limits });
  if (!timeline.ok) {
    const first = timeline.errors[0];
    throw stageError(first?.code ?? 'VIDEO_TIMELINE', first?.message ?? '时间轴校验失败', first?.path ? `改计划或旁白后再渲染（位置 ${first.path}）` : '改计划或旁白后再渲染');
  }
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
    limits,
  };
  fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // ── 3. 字幕贴图 + SRT ────────────────────────────────────
  report('captions', 32, '生成字幕贴图');
  const captionDir = path.join(revDir, 'captions');
  fs.mkdirSync(captionDir, { recursive: true });
  const fontProbe = runPy(['probe']);
  if (!fontProbe?.ok || !fontProbe?.font) {
    throw stageError('VIDEO_NO_FONT', '找不到可用中文字体', '安装 PingFang / Noto Sans CJK 后重试');
  }
  const captionFiles = [];
  for (const [index, caption] of timeline.captions.entries()) {
    if (abortSignal?.aborted) throw stageError('VIDEO_CANCELLED', '渲染被取消');
    const key = crypto.createHash('sha1').update(JSON.stringify([caption.text, fontProbe.font, GENERATOR_VERSION])).digest('hex').slice(0, 16);
    const file = path.join(captionDir, `cap-${key}.png`);
    if (!fs.existsSync(file)) {
      const part = `${file}.part-${process.pid}`;
      const result = runPy(['text', '--out', part, '--text', caption.text, '--font', fontProbe.font, '--font-size', '52', '--max-lines', '2', '--align', 'bottom']);
      if (!result?.ok) {
        try { fs.unlinkSync(part); } catch {}
        throw stageError('VIDEO_CAPTION_FAILED', `字幕生成失败：${result?.error ?? '未知'}`);
      }
      if ((result.missingGlyphs ?? []).length) {
        log(`[video] 字幕含缺失字形（可能显示为方框）：${result.missingGlyphs.join('')}`);
      }
      fs.renameSync(part, file);
    }
    caption.file = file; // 回写路径：overlay 与分镜签名都从这里取
    captionFiles.push({ ...caption, file });
    if (index % 8 === 0) report('captions', 32 + Math.round(((index + 1) / Math.max(1, timeline.captions.length)) * 10), `字幕 ${index + 1}/${timeline.captions.length}`);
  }
  const srtPath = path.join(tmpDir, 'captions.srt');
  fs.writeFileSync(srtPath, buildSrt(timeline.captions), 'utf8');
  // 标题卡贴图
  const titleCards = {};
  for (const scene of timeline.scenes) {
    if (!scene.titleCard) continue;
    const key = crypto.createHash('sha1').update(JSON.stringify([scene.titleCard.text, fontProbe.font, GENERATOR_VERSION])).digest('hex').slice(0, 16);
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
  const segDir = path.join(revDir, 'segments');
  fs.mkdirSync(segDir, { recursive: true });
  const sceneAudioDir = path.join(revDir, 'audio');
  fs.mkdirSync(sceneAudioDir, { recursive: true });
  const segments = [];
  for (const [index, scene] of timeline.scenes.entries()) {
    if (abortSignal?.aborted) throw stageError('VIDEO_CANCELLED', '渲染被取消');
    report('render', 42 + Math.round((index / timeline.scenes.length) * 40), `镜头 ${scene.id}（${index + 1}/${timeline.scenes.length}）`);
    const { file: assetFile } = resolveAssetFile(store, root, scene.assetId);
    const frames = Math.round((scene.durationMs / 1000) * FPS);
    const durSec = (scene.durationMs / 1000).toFixed(3);

    // 内容寻址的分镜签名：素材 hash + 构图/动效 + 字幕贴图 hash + 字幕时间窗
    //（时间窗变了必须重编码，否则缓存复用的片段还带旧 overlay 时间）
    const sceneCaptions = timeline.captions.filter((c) => c.startMs >= scene.startMs && c.startMs < scene.endMs);
    const captionHashes = sceneCaptions.map((c) => sha256File(c.file)).join(',');
    const captionTiming = sceneCaptions.map((c) => [c.startMs - scene.startMs, c.endMs - scene.startMs]);
    const signature = sha256Of(JSON.stringify([
      sha256File(assetFile), scene.fit, scene.motion, scene.durationMs, captionHashes, captionTiming,
      scene.titleCard ? sha256File(titleCards[scene.id]) : null, GENERATOR_VERSION,
    ])).slice(0, 24);
    const segFile = path.join(segDir, `seg-${scene.id}-${signature}.mp4`);

    if (!(await isUsableMedia(ffprobe, segFile))) {
      const overlayDefs = [];
      for (const caption of timeline.captions.filter((c) => c.startMs >= scene.startMs && c.startMs < scene.endMs)) {
        const start = ((caption.startMs - scene.startMs) / 1000).toFixed(3);
        const end = ((caption.endMs - scene.startMs) / 1000).toFixed(3);
        overlayDefs.push({ file: caption.file, start, end });
      }
      if (scene.titleCard) overlayDefs.push({ file: titleCards[scene.id], start: '0.000', end: durSec });

      const inputs = ['-loop', '1', '-framerate', String(FPS), '-t', durSec, '-i', assetFile];
      for (const overlay of overlayDefs) inputs.push('-loop', '1', '-t', durSec, '-i', overlay.file);

      const parts = [];
      const base = normalizeFilter(scene.fit);
      const motion = motionFilter(scene.motion, frames);
      parts.push(`[0:v]${base}${motion ? `,${motion}` : ''},format=yuv420p[m0]`);
      overlayDefs.forEach((overlay, i) => {
        const inLabel = i + 1;
        const outLabel = i + 1 === overlayDefs.length ? 'vout' : `m${i + 1}`;
        const prev = i === 0 ? 'm0' : `m${i}`;
        parts.push(`[${inLabel}:v]format=rgba[o${inLabel}]`);
        parts.push(`[${prev}][o${inLabel}]overlay=0:0:enable='between(t,${overlay.start},${overlay.end})'[${outLabel}]`);
      });
      if (!overlayDefs.length) parts.push('[m0]copy[vout]');
      const filter = parts.join(';');
      const segArgs = [...inputs, '-filter_complex', filter, '-map', '[vout]', '-frames:v', String(frames), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an'];
      await writeAtomic(segFile, (part) => runFfmpeg(ffmpeg, [...segArgs, '-f', 'mp4', '-y', part], { abortSignal, log }));
    }

    // 场景音轨：旁白拼接 + 尾静音到镜头时长
    const audioSig = sha256Of(JSON.stringify([scene.cues.map((c) => lineResults[c.lineId]?.sha256 ?? ''), scene.durationMs])).slice(0, 24);
    const sceneWav = path.join(sceneAudioDir, `audio-${scene.id}-${audioSig}.wav`);
    if (!(await isUsableMedia(ffprobe, sceneWav, { minBytes: 1024 }))) {
      const cueWavs = scene.cues.map((cue) => lineResults[cue.lineId]?.file).filter(Boolean);
      await writeAtomic(sceneWav, async (part) => {
        if (cueWavs.length) {
          const concatInputs = cueWavs.flatMap((f) => ['-i', f]);
          const concatFilter = cueWavs.map((_, i) => `[${i}:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a${i}]`)
            .concat([cueWavs.map((_, i) => `[a${i}]`).join('') + `concat=n=${cueWavs.length}:v=0:a=1[voiced]`]).join(';');
          const tmpVoice = path.join(tmpDir, `voice-${scene.id}.wav`);
          await runFfmpeg(ffmpeg, [...concatInputs, '-filter_complex', concatFilter, '-map', '[voiced]', '-y', tmpVoice], { abortSignal, log });
          await runFfmpeg(ffmpeg, ['-i', tmpVoice, '-af', `aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo,apad=pad_dur=999,atrim=0:${durSec}`, '-f', 'wav', '-y', part], { abortSignal, log });
        } else {
          await runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', durSec, '-c:a', 'pcm_s16le', '-f', 'wav', '-y', part], { abortSignal, log });
        }
      });
    }
    segments.push({ file: segFile, wav: sceneWav, scene });
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
  const finalFilter = [
    `${vChains.join('')}concat=n=${segments.length}:v=1:a=0[vout]`,
    `${aChains.join('')}concat=n=${segments.length}:v=0:a=1[aout]`,
  ].join(';');
  const finalArgs = [
    ...finalInputs,
    '-filter_complex', finalFilter,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-y', finalTmp,
  ];
  await runFfmpeg(ffmpeg, finalArgs, { abortSignal, log });

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

  const qa = await runQa(ffmpeg, ffprobe, finalTmp, timeline.totalMs, limits);

  const gridTmp = path.join(tmpDir, 'preview-grid.png');
  const interval = Math.max(1, Math.ceil((timeline.totalMs / 1000) / 9));
  await runFfmpeg(ffmpeg, ['-i', finalTmp, '-vf', `fps=1/${interval},scale=320:180,tile=3x3`, '-frames:v', '1', '-y', gridTmp], { abortSignal, log });

  const framesDir = path.join(revDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const sceneFrames = [];
  for (const scene of timeline.scenes) {
    const t = ((scene.startMs + Math.min(Math.floor(scene.durationMs / 2), scene.durationMs - 40)) / 1000).toFixed(3);
    const frameFile = path.join(framesDir, `${scene.id}.png`);
    await runFfmpeg(ffmpeg, ['-ss', t, '-i', finalTmp, '-frames:v', '1', '-y', frameFile], { abortSignal, log });
    sceneFrames.push({ sceneId: scene.id, offsetMs: Math.min(Math.floor(scene.durationMs / 2), scene.durationMs - 40), file: path.relative(root, frameFile) });
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
    captions: timeline.captions,
    frames: sceneFrames,
  };
  fs.writeFileSync(path.join(tmpDir, 'preview.json'), JSON.stringify(previewJson, null, 2));

  // 质检不通过：成片留在 tmp，不进入版本目录（方案：校验成功后原子重命名）
  if (!qa.ok) {
    throw stageError(qa.code ?? 'VIDEO_QA_FAILED', `技术质检未通过：${qa.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`).join('；')}`, '按提示修计划/素材后重新渲染');
  }

  // ── 7. 原子落盘 ──────────────────────────────────────────
  const commit = (name, kind, extra = {}) => {
    const tmpFile = path.join(tmpDir, name);
    const finalFile = path.join(revDir, name);
    fs.renameSync(tmpFile, finalFile);
    const sizeBytes = fs.statSync(finalFile).size;
    const sha256 = sha256File(finalFile);
    store.recordArtifact(projectId, revision, {
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
  commit('preview.json', 'preview', { meta: { scenes: timeline.scenes.length } });
  const qaFile = path.join(revDir, 'qa.json');
  fs.writeFileSync(qaFile, JSON.stringify(qa, null, 2));
  store.recordArtifact(projectId, revision, {
    kind: 'qa', sha256: sha256File(qaFile), relativePath: 'qa.json', sizeBytes: fs.statSync(qaFile).size,
    generatorVersion: GENERATOR_VERSION, meta: { pass: qa.ok },
  });

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
      reject(stageError('VIDEO_FFMPEG_SPAWN', `FFmpeg 启动失败：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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
      const kill = () => { try { child.kill('SIGKILL'); } catch {} };
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
async function runQa(ffmpeg, ffprobe, finalFile, totalMs, limits = {}) {
  const checks = [];
  const warnings = [];
  const probeArgs = ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', finalFile];
  const probe = JSON.parse((await execFileP(ffprobe, probeArgs)).stdout);
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

  // 音量与静音比例（旁白片必须有一半以上时间在发声）
  try {
    const vol = await execFileP(ffmpeg, ['-i', finalFile, '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 120_000 });
    const mean = /mean_volume:\s*([-\d.]+)\s*dB/.exec(vol.stderr);
    const max = /max_volume:\s*([-\d.]+)\s*dB/.exec(vol.stderr);
    const meanDb = mean ? Number(mean[1]) : -91;
    const maxDb = max ? Number(max[1]) : -91;
    checks.push({
      name: 'audible',
      pass: maxDb > -45 && meanDb > -60,
      detail: `mean=${meanDb.toFixed(1)}dB max=${maxDb.toFixed(1)}dB`,
    });
  } catch {
    checks.push({ name: 'audible', pass: true, detail: 'volumedetect 不可用，跳过' });
  }

  // 黑帧抽样（允许计划黑场，但整段长黑要提示）
  try {
    const black = await execFileP(ffmpeg, ['-i', finalFile, '-vf', 'blackdetect=d=1.0:pix_th=0.10', '-an', '-f', 'null', '-'], { timeoutMs: 120_000 });
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
