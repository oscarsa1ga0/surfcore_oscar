// 本地 TTS 客户端：把一段文字变成「能交给 sendVoiceV2 的本地音频文件」。
//
// 只做一件事，且失败要**可读**——桥接那层会把它翻译成 502 交给模型，
// 模型据此决定「改回打字」而不是编一句「我发了语音」。
//
// 与 voxd 的契约见 ../voice/README.md：POST /v1/speak/file → wav 字节，
// X-Duration-Ms 是时长（毫秒），X-Cached 表示是否命中服务端缓存。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8765';

/** 按内容寻址：同一句话重复发不会在磁盘上堆文件（voxd 端也有缓存）。 */
export function ttsKey({ baseUrl, text, character, voice, style, cacheVersion, provider = 'voxd', breeze = {} }) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify([
      provider, baseUrl, cacheVersion ?? null, text, character ?? null, voice ?? null, style ?? null,
      provider === 'breeze' ? {
        voiceId: breeze.voiceId ?? '', modelId: breeze.modelId ?? '', instructions: breeze.instructions ?? '',
        outputFormat: breeze.outputFormat ?? '', baseUrl: breeze.baseUrl ?? '',
      } : null,
    ]))
    .digest('hex');
}

/** 从 wav 头算时长（本地命中缓存时没有响应头可用）。坏文件返回 0，不抛。 */
export function wavDurationMs(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return 0;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 20 <= buf.length) byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') {
      if (!byteRate || !size) return 0;
      return Math.round((size / byteRate) * 1000);
    }
    off += 8 + size + (size % 2);
  }
  return 0;
}

const BREEZE_DEFAULT_BASE = 'https://api.breeze.blue';
const BREEZE_DEFAULT_MODEL = 'breeze-tts-2';

/**
 * BreezeBlue 云端 TTS：POST /v1/text-to-speech/{voice_id}?output_format=wav_24000
 * 认证用 xi-api-key；返回音频二进制。默认请求 wav，便于桥接直接发 QQ 语音条。
 */
export async function synthesizeBreezeToFile({
  text,
  apiKey = '',
  voiceId = '',
  modelId = BREEZE_DEFAULT_MODEL,
  instructions = '',
  outputFormat = 'wav_24000',
  guidanceScale = null,
  baseUrl = BREEZE_DEFAULT_BASE,
  timeoutMs = 60000,
  cacheVersion = null,
  outDir,
  fetchImpl = fetch,
} = {}) {
  const say = String(text ?? '').trim();
  if (!say) throw new Error('要合成的内容是空的');
  if (!outDir) throw new Error('缺少 outDir（TTS 缓存目录）');
  if (!apiKey) throw new Error('BreezeBlue API Key 未配置（设置 → SurfCore → 语音 → BreezeBlue）');
  if (!voiceId) throw new Error('BreezeBlue Voice ID 未配置（设置 → SurfCore → 语音 → BreezeBlue）');
  const base = String(baseUrl || BREEZE_DEFAULT_BASE).replace(/\/+$/, '');
  const format = String(outputFormat || 'wav_24000').replace(/[^a-z0-9_]/gi, '') || 'wav_24000';
  const voice = String(voiceId).trim();
  fs.mkdirSync(outDir, { recursive: true });
  const key = ttsKey({
    provider: 'breeze', baseUrl: base, cacheVersion, text: say,
    breeze: { voiceId: voice, modelId, instructions, outputFormat: format },
  });
  const file = path.join(outDir, `${key}.wav`);
  if (fs.existsSync(file)) {
    const st = fs.statSync(file);
    if (st.size > 44) return { path: file, durationMs: wavDurationMs(fs.readFileSync(file)), cached: true };
  }

  const body = { text: say, model_id: String(modelId || BREEZE_DEFAULT_MODEL) };
  if (instructions) body.instructions = String(instructions);
  if (Number.isFinite(Number(guidanceScale)) && Number(guidanceScale) > 0) {
    body.voice_settings = { guidance_scale: Number(guidanceScale) };
  }
  let res;
  try {
    res = await fetchImpl(`${base}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${encodeURIComponent(format)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': String(apiKey),
        'content-type': 'application/json',
        accept: 'audio/*',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const hint = error?.name === 'TimeoutError'
      ? `BreezeBlue 合成超时（>${Math.round(timeoutMs / 1000)}s）`
      : '连不上 BreezeBlue（检查网络/代理）';
    throw new Error(`${hint}：${error?.message ?? error}`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.detail ?? j?.error ?? j?.message ?? '';
    } catch {}
    throw new Error(`BreezeBlue 返回 ${res.status}${detail ? `：${String(detail).slice(0, 240)}` : ''}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length <= 44) throw new Error('BreezeBlue 返回了空音频');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  pruneCache(outDir);
  return { path: file, durationMs: wavDurationMs(buf), cached: false };
}

/**
 * @returns {Promise<{path:string,durationMs:number,cached:boolean}>}
 * @throws  Error（message 已可直接展示给模型/操作者）
 */
export async function synthesizeToFile({
  text,
  character = '',
  voice = '',
  style = null,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 60000,
  cacheVersion = null,
  outDir,
  provider = 'voxd',
  breeze = {},
  fetchImpl = fetch
} = {}) {
  const say = String(text ?? '').trim();
  if (provider === 'breeze') {
    return synthesizeBreezeToFile({
      text: say, outDir, timeoutMs, cacheVersion,
      apiKey: breeze.apiKey, voiceId: breeze.voiceId, modelId: breeze.modelId,
      instructions: breeze.instructions, outputFormat: breeze.outputFormat,
      guidanceScale: breeze.guidanceScale, baseUrl: breeze.baseUrl, fetchImpl,
    });
  }
  if (!say) throw new Error('要合成的内容是空的');
  if (!outDir) throw new Error('缺少 outDir（TTS 缓存目录）');
  fs.mkdirSync(outDir, { recursive: true });

  const url = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const key = ttsKey({ baseUrl: url, text: say, character, voice, style, cacheVersion, provider, breeze });
  const file = path.join(outDir, `${key}.wav`);
  if (fs.existsSync(file)) {
    const st = fs.statSync(file);
    if (st.size > 44) return { path: file, durationMs: wavDurationMs(fs.readFileSync(file)), cached: true };
  }

  const body = { text: say, format: 'wav', sr: 24000, cache: true };
  if (character) body.character = String(character);
  if (voice) body.voice = String(voice);
  if (style && typeof style === 'object') body.style = style;

  let res;
  try {
    res = await fetchImpl(`${url}/v1/speak/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const hint =
      error?.name === 'TimeoutError'
        ? `合成超时（>${Math.round(timeoutMs / 1000)}s）`
        : 'TTS 服务没起来（voxd 是否在运行？）';
    throw new Error(`${hint}：${error?.message ?? error}`);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.detail ?? j?.error ?? '';
    } catch {}
    throw new Error(`TTS 服务返回 ${res.status}${detail ? `：${detail}` : ''}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length <= 44) throw new Error('TTS 返回了空音频');

  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  pruneCache(outDir);

  const dur = Number(res.headers.get('x-duration-ms')) || 0;
  return { path: file, durationMs: dur, cached: res.headers.get('x-cached') === '1' };
}

/**
 * 合成缓存是有上限的：按字节数寻址意味着**每句新话都多一个文件**，长期跑会长到几万个。
 * 这里按 mtime 从旧到新删，直到回到水位以下（默认 400 个 / 150MB）。
 * 失败一律吞掉——缓存清理绝不能影响"这条语音能不能发出去"。
 */
export function pruneCache(dir, { maxFiles = 400, maxBytes = 150 * 1024 * 1024 } = {}) {
  let entries;
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.wav'))
      .map((e) => {
        const p = path.join(dir, e.name);
        try {
          const st = fs.statSync(p);
          return { p, size: st.size, at: st.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return { removed: 0, files: 0, bytes: 0 };
  }
  let total = entries.reduce((n, e) => n + e.size, 0);
  let count = entries.length;
  if (count <= maxFiles && total <= maxBytes) return { removed: 0, files: count, bytes: total };

  entries.sort((a, b) => a.at - b.at);
  let removed = 0;
  for (const e of entries) {
    if (count <= maxFiles && total <= maxBytes) break;
    try {
      fs.unlinkSync(e.p);
      count -= 1;
      total -= e.size;
      removed += 1;
    } catch {}
  }
  return { removed, files: count, bytes: total };
}
