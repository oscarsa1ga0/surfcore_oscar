/**
 * 剪辑计划的强校验与时间轴计算（阶段一，schemaVersion 1）。
 *
 * 契约（方案 §4）：
 *   · 阶段一固定 16:9 / 720p30，默认 15–90 秒、最多 12 个场景。
 *   · 镜头视觉只能引用素材库 assetId；动效只允许 none / zoom_in / pan；构图 contain / cover。
 *   · 按旁白定长：取实测语音 + 尾留白，再按 30fps 帧对齐；
 *     固定时长镜头里旁白超出 → VIDEO_SCENE_TOO_SHORT（报镜头和缺的时长）。
 *   · 每个字幕 cue 对应一句实际合成的旁白；过长按句意拆分并保留正确时间戳。
 *   · 时间轴是纯函数：同样的 plan + voiceDurations 永远得到同样的结果。
 */
import crypto from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const FPS = 30;
export const PROFILE = { aspect: '16:9', width: 1280, height: 720, fps: FPS };
export const DEFAULTS = {
  minTotalMs: 15_000,
  maxTotalMs: 90_000,
  maxScenes: 12,
  voiceTailMs: 400,
  lineGapMs: 800, // 相邻旁白句之间的停顿（听感自然的默认值）
  maxLineGapMs: 3000,
  defaultFixedMs: 3000,
  maxCaptionChars: 28, // 超过就按句意拆分
};

const MOTIONS = ['none', 'zoom_in', 'pan'];
const FITS = ['contain', 'cover'];
const TRANSITIONS = ['cut'];
const SENTENCE_SPLIT = /(?<=[。！？!?；;…])|(?<=[，,])/u;

export function frameAlign(ms, fps = FPS) {
  const step = 1000 / fps;
  return Math.round(Math.ceil(Number(ms) / step) * step);
}

export function planHash(plan) {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function err(path, message, code = 'VIDEO_PLAN_INVALID') {
  return { code, path, message };
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

function intMs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** 纯校验：结构、枚举、时长与引用关系。返回 { ok, errors, warnings }。 */
export function validatePlan(input, options = {}) {
  const limits = { ...DEFAULTS, ...(options.limits ?? {}) };
  const errors = [];
  const warnings = [];
  const plan = input && typeof input === 'object' ? input : {};

  if (plan.schemaVersion !== SCHEMA_VERSION) {
    errors.push(err('schemaVersion', `schemaVersion 必须是 ${SCHEMA_VERSION}`));
  }
  const title = str(plan.title).trim();
  if (!title) errors.push(err('title', '计划缺少标题'));
  if (title.length > 120) errors.push(err('title', `标题最长 120 字（现在 ${title.length}）`));

  const format = plan.format ?? {};
  if (String(format.aspect ?? '16:9') !== '16:9') errors.push(err('format.aspect', '阶段一只支持 16:9'));
  if (String(format.profile ?? '720p30') !== '720p30') errors.push(err('format.profile', '阶段一只支持 720p30'));

  const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];
  if (!scenes.length) errors.push(err('scenes', '至少需要一个场景'));
  if (scenes.length > limits.maxScenes) {
    errors.push(err('scenes', `场景最多 ${limits.maxScenes} 个（现在 ${scenes.length}）`));
  }
  const sceneIds = new Set();
  const lineIds = new Set();
  const sceneMap = new Map();
  for (const scene of scenes) {
    const prefix = `scenes[${sceneIds.size}]`;
    const id = str(scene?.id).trim();
    if (!id) errors.push(err(`${prefix}.id`, '场景缺少 id'));
    else if (sceneIds.has(id)) errors.push(err(`${prefix}.id`, `场景 id 重复：${id}`));
    else sceneIds.add(id);
    sceneMap.set(id, scene);

    const visual = scene?.visual ?? {};
    if (!str(visual.assetId).trim()) errors.push(err(`${prefix}.visual.assetId`, '场景缺少素材 assetId'));
    if (!FITS.includes(visual.fit)) errors.push(err(`${prefix}.visual.fit`, `fit 只能是 ${FITS.join('/')}`));
    if (!MOTIONS.includes(visual.motion)) errors.push(err(`${prefix}.visual.motion`, `motion 只能是 ${MOTIONS.join('/')}`));

    const duration = scene?.duration ?? {};
    const mode = String(duration.mode ?? '');
    if (!['voice', 'fixed'].includes(mode)) errors.push(err(`${prefix}.duration.mode`, 'duration.mode 只能是 voice/fixed'));
    if (mode === 'fixed' && intMs(duration.ms) == null) errors.push(err(`${prefix}.duration.ms`, 'fixed 镜头必须给整数毫秒 ms'));
    if (intMs(duration.minMs) != null && intMs(duration.minMs) < 500) {
      errors.push(err(`${prefix}.duration.minMs`, 'minMs 至少 500'));
    }
    if (intMs(duration.gapMs) != null && intMs(duration.gapMs) > limits.maxLineGapMs) {
      errors.push(err(`${prefix}.duration.gapMs`, `gapMs（句间停顿）最大 ${limits.maxLineGapMs}ms`));
    }

    const lines = Array.isArray(scene?.lines) ? scene.lines : [];
    for (const line of lines) {
      const lprefix = `${prefix}.lines[${lines.indexOf(line)}]`;
      const lid = str(line?.id).trim();
      if (!lid) errors.push(err(`${lprefix}.id`, '旁白行缺少 id'));
      else if (lineIds.has(lid)) errors.push(err(`${lprefix}.id`, `旁白行 id 重复：${lid}`));
      else lineIds.add(lid);
      if (!str(line?.speech).trim()) errors.push(err(`${lprefix}.speech`, '旁白行缺少 speech'));
      if (mode === 'fixed' && !str(line?.speech).trim()) {
        errors.push(err(`${lprefix}.speech`, 'fixed 镜头不需要旁白，去掉 lines 或给 speech'));
      }
    }
    if (mode === 'voice' && !lines.some((l) => str(l?.speech).trim())) {
      errors.push(err(`${prefix}.lines`, 'voice 镜头至少需要一行旁白（或改回 fixed）'));
    }

    if (scene?.titleCard != null && !str(scene.titleCard).trim()) {
      errors.push(err(`${prefix}.titleCard`, 'titleCard 不能是空字符串（不需要就去掉该字段）'));
    }
    const trans = scene?.transitionOut ?? { kind: 'cut', durationMs: 0 };
    if (!TRANSITIONS.includes(trans.kind)) errors.push(err(`${prefix}.transitionOut.kind`, `阶段一转场只支持 ${TRANSITIONS.join('/')}`));
    if (intMs(trans.durationMs) != null && intMs(trans.durationMs) > 2000) {
      errors.push(err(`${prefix}.transitionOut.durationMs`, '转场时长不超过 2000ms'));
    }
  }

  const cover = plan.cover ?? {};
  if (cover == null || typeof cover !== 'object' || String(cover.kind ?? 'scene_frame') !== 'scene_frame') {
    errors.push(err('cover.kind', '封面只支持 kind=scene_frame（选镜头的一帧）'));
  } else {
    if (!sceneMap.has(str(cover.sceneId))) errors.push(err('cover.sceneId', `封面引用的场景不存在：${cover.sceneId}`));
  }

  const submission = plan.submission ?? {};
  if (!str(submission.description).trim()) errors.push(err('submission.description', '投稿简介不能为空'));
  const tags = Array.isArray(submission.tags) ? submission.tags : [];
  for (const tag of tags) {
    if (typeof tag !== 'string' || !tag.trim() || tag.length > 40) {
      errors.push(err('submission.tags', '标签必须是非空字符串（每个 ≤40 字）'));
      break;
    }
  }
  if (tags.length > 20) errors.push(err('submission.tags', '标签最多 20 个'));

  // 标题/简介/字幕/旁白里的隐私风险词只做提示（正式拦截在出片前统一走隐私检查）。
  return { ok: errors.length === 0, errors, warnings, plan };
}

/**
 * 拆分过长字幕：按句意断点拆成若干段（每段 ≤ maxChars 尽量），
 * 保留原句顺序。返回 string[]。
 */
export function splitCaption(text, maxChars = DEFAULTS.maxCaptionChars) {
  const say = String(text ?? '').trim();
  if (!say) return [];
  const parts = say.split(SENTENCE_SPLIT).filter(Boolean);
  const out = [];
  let bucket = '';
  for (const part of parts) {
    if (!bucket) {
      bucket = part;
    } else if (bucket.length + part.length <= maxChars) {
      bucket += part;
    } else {
      out.push(bucket);
      bucket = part;
    }
    if (bucket.length >= maxChars) {
      out.push(bucket);
      bucket = '';
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

/**
 * 计算时间轴。
 * @param {object} plan 已通过 validatePlan 的计划
 * @param {Record<string, number>} voiceDurationsMs lineId → 实测语音毫秒
 * @param {object} options { limits }
 * @returns {{
 *   ok: boolean, totalMs: number, scenes: Array<{
 *     id, startMs, endMs, durationMs, mode, cues: Array<{lineId, startMs, endMs, text, segments}>,
 *     titleCard: {startMs, endMs, text} | null,
 *   }>, captions: Array<{startMs, endMs, text}>, cover: {sceneId, offsetMs, headline} | null,
 *   errors: Array
 * }}
 */
export function computeTimeline(plan, voiceDurationsMs = {}, options = {}) {
  const limits = { ...DEFAULTS, ...(options.limits ?? {}) };
  const validation = validatePlan(plan, options);
  const errors = [...validation.errors];
  if (!validation.ok) {
    return { ok: false, totalMs: 0, scenes: [], captions: [], cover: null, errors };
  }
  const voice = voiceDurationsMs && typeof voiceDurationsMs === 'object' ? voiceDurationsMs : {};
  const scenes = [];
  let cursor = 0;
  for (const scene of plan.scenes) {
    const mode = scene.duration.mode;
    const lines = Array.isArray(scene.lines) ? scene.lines : [];
    const gap = intMs(scene.duration.gapMs) ?? limits.lineGapMs;
    let durationMs;
    const cues = [];
    if (mode === 'voice') {
      const spoken = lines.map((l) => Number(voice[l.id]) || 0);
      const missing = lines.filter((l) => !Number.isFinite(Number(voice[l.id]))).map((l) => l.id);
      if (missing.length) {
        errors.push(err(`scenes[${scene.id}]`, `旁白行缺少实测时长：${missing.join(', ')}（合成后重算）`));
      }
      const min = intMs(scene.duration.minMs) ?? 0;
      const tail = intMs(scene.duration.tailMs) ?? limits.voiceTailMs;
      const gaps = Math.max(0, lines.length - 1) * gap;
      durationMs = frameAlign(Math.max(min, spoken.reduce((a, b) => a + b, 0) + gaps + tail));
      // 逐行排 cue：每句之间留句间停顿（gapMs），尾留白挂在最后
      let lineCursor = 0;
      for (const [index, line] of lines.entries()) {
        const d = Math.max(0, Number(voice[line.id]) || 0);
        const text = str(line.caption).trim() || str(line.speech).trim();
        cues.push({
          lineId: line.id,
          startMs: lineCursor,
          endMs: lineCursor + Math.max(d, 0),
          text,
          segments: splitCaption(text, limits.maxCaptionChars),
        });
        lineCursor += Math.max(d, 0) + (index < lines.length - 1 ? gap : 0);
      }
    } else {
      durationMs = frameAlign(intMs(scene.duration.ms) ?? limits.defaultFixedMs);
      // fixed 镜头带旁白：cue 均分在镜头内（预留尾留白，句间也有停顿）
      const tail = Math.min(intMs(scene.duration.tailMs) ?? limits.voiceTailMs, Math.floor(durationMs / 4));
      const usable = durationMs - tail;
      const spoken = lines.map((l) => Number(voice[l.id]) || 0);
      const gaps = Math.max(0, lines.length - 1) * gap;
      const need = spoken.reduce((a, b) => a + b, 0) + gaps;
      if (need > usable) {
        errors.push(err(
          `scenes[${scene.id}].duration`,
          `旁白超出镜头时长：需要 ${need}ms（含句间停顿），镜头只留了 ${usable}ms（缺 ${need - usable}ms）`,
          'VIDEO_SCENE_TOO_SHORT',
        ));
      }
      let lineCursor = 0;
      for (const [index, line] of lines.entries()) {
        const d = Math.max(0, Number(voice[line.id]) || 0);
        const text = str(line.caption).trim() || str(line.speech).trim();
        cues.push({
          lineId: line.id,
          startMs: lineCursor,
          endMs: lineCursor + Math.max(d, 0),
          text,
          segments: splitCaption(text, limits.maxCaptionChars),
        });
        lineCursor += Math.max(d, 0) + (index < lines.length - 1 ? gap : 0);
      }
    }
    const startMs = cursor;
    const endMs = startMs + durationMs;
    const titleCard = str(scene.titleCard).trim()
      ? { startMs, endMs, text: str(scene.titleCard).trim() }
      : null;
    scenes.push({
      id: scene.id,
      startMs,
      endMs,
      durationMs,
      mode,
      assetId: str(scene.visual.assetId),
      fit: scene.visual.fit ?? 'contain',
      motion: scene.visual.motion ?? 'none',
      transitionOut: scene.transitionOut ?? { kind: 'cut', durationMs: 0 },
      cues,
      titleCard,
    });
    cursor = endMs;
  }

  const captions = [];
  for (const scene of scenes) {
    for (const cue of scene.cues) {
      // 拆分段按字数占比切分整句时长，首尾相接、互不重叠
      const weights = cue.segments.map((segment) => segment.length / Math.max(1, cue.text.length));
      const starts = [];
      let acc = 0;
      for (const weight of weights) {
        starts.push(acc);
        acc += weight;
      }
      cue.segments.forEach((segment, index) => {
        const cueStart = cue.startMs + Math.round((cue.endMs - cue.startMs) * starts[index]);
        const cueEnd = cue.startMs + (index + 1 < cue.segments.length
          ? Math.round((cue.endMs - cue.startMs) * starts[index + 1])
          : cue.endMs - cue.startMs);
        captions.push({ startMs: scene.startMs + cueStart, endMs: scene.startMs + cueEnd, text: segment });
      });
    }
  }

  let cover = null;
  if (plan.cover?.kind === 'scene_frame') {
    cover = {
      sceneId: str(plan.cover.sceneId),
      offsetMs: Math.min(Math.max(intMs(plan.cover.offsetMs) ?? 0, 0), 90_000),
      headline: str(plan.cover.headline).trim(),
    };
  }

  const totalMs = cursor;
  if (totalMs < limits.minTotalMs) {
    errors.push(err('scenes', `总时长 ${totalMs}ms 短于最低 ${limits.minTotalMs}ms`, 'VIDEO_TOO_SHORT'));
  }
  if (totalMs > limits.maxTotalMs) {
    errors.push(err('scenes', `总时长 ${totalMs}ms 超过上限 ${limits.maxTotalMs}ms`, 'VIDEO_TOO_LONG'));
  }

  return {
    ok: errors.length === 0,
    totalMs,
    scenes,
    captions,
    cover,
    errors,
  };
}

/** 把计划里全部旁白行拍平成 [sceneId, line] 列表，给 TTS 阶段逐句合成。 */
export function planLines(plan) {
  const out = [];
  for (const scene of Array.isArray(plan.scenes) ? plan.scenes : []) {
    for (const line of Array.isArray(scene.lines) ? scene.lines : []) {
      out.push({ sceneId: scene.id, lineId: line.id, speech: str(line.speech).trim(), caption: str(line.caption).trim() });
    }
  }
  return out;
}
