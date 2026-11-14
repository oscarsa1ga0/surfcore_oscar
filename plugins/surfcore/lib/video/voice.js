/**
 * 视频配音：共享音色解析 + 逐句合成 + WAV 校验（阶段一）。
 *
 * 与方案 §5.3 的约定：
 *   · 音色解析与桥接/桌宠同源（socialV2.voice.tts），只读配置、不复用
 *     QQ 的语音发送接口；这里提成可复用的 resolveVoiceSettings()。
 *   · 每句生成 WAV 后验证 RIFF/WAVE 并探测时长，计划与字幕用同一时间轴。
 *   · 每次渲染固定音色快照（voiceFingerprint），旁白改变只重合成受影响的句子。
 *   · 哈希只用文本/音色/采样约定/生成器版本，不含明文密钥。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { synthesizeToFile, wavDurationMs } from '../../../../src/voice-tts.js';
import { GENERATOR_VERSION } from './project-store.js';
import { readQqConfig } from '../store.js';

/** 从 QQ 配置归一化音色（与 src/bridge.js voiceCfg() 同一套语义）。 */
export function resolveVoiceSettings(qqConfig = null) {
  const cfg = qqConfig ?? (() => { try { return readQqConfig().config; } catch { return {}; } })();
  const v = cfg?.socialV2?.voice ?? {};
  const t = v?.tts ?? {};
  const provider = String(t.provider) === 'breeze' ? 'breeze' : 'voxd';
  const route = ['local', 'cloud'].includes(String(t.route)) ? String(t.route) : 'local';
  const endpoints = {
    local: String(t.endpoints?.local || 'http://127.0.0.1:8765'),
    cloud: String(t.endpoints?.cloud || 'http://127.0.0.1:8767'),
  };
  return {
    enabled: t.enabled === true,
    provider,
    baseUrl: endpoints[route] || String(t.baseUrl || 'http://127.0.0.1:8765'),
    route,
    timeoutMs: Number(t.timeoutMs) > 0 ? Number(t.timeoutMs) : 60_000,
    character: String(t.character || ''),
    voice: String(t.voice || ''),
    style: t.style && typeof t.style === 'object' ? t.style : null,
    breeze: {
      apiKey: String(process.env.BREEZE_API_KEY || t.breeze?.apiKey || ''),
      baseUrl: String(t.breeze?.baseUrl || 'https://api.breeze.blue').replace(/\/+$/, ''),
      voiceId: String(t.breeze?.voiceId || ''),
      modelId: String(t.breeze?.modelId || 'breeze-tts-2'),
      instructions: String(t.breeze?.instructions || ''),
      outputFormat: String(t.breeze?.outputFormat || 'wav_24000'),
      guidanceScale: Number(t.breeze?.guidanceScale) > 0 ? Number(t.breeze.guidanceScale) : null,
    },
    cacheVersion: Number(t.cacheVersion) || 0,
  };
}

/** 渲染用的音色快照指纹（不含密钥）。 */
export function voiceFingerprint(settings) {
  return crypto.createHash('sha256').update(JSON.stringify({
    generatorVersion: GENERATOR_VERSION,
    provider: settings.provider,
    baseUrl: settings.provider === 'voxd' ? settings.baseUrl : settings.breeze.baseUrl,
    character: settings.character,
    voice: settings.voice,
    style: settings.style,
    voiceId: settings.breeze.voiceId,
    modelId: settings.breeze.modelId,
    instructions: settings.breeze.instructions,
    outputFormat: settings.breeze.outputFormat,
    guidanceScale: settings.breeze.guidanceScale,
    cacheVersion: settings.cacheVersion,
  })).digest('hex');
}

/**
 * 逐句合成旁白，写进版本目录的 tts/ 下（内容寻址）。
 * @param {Array<{lineId:string, speech:string}>} lines
 * @param {object} settings resolveVoiceSettings() 的结果
 * @param {string} outDir 版本目录下的 tts 子目录（会创建）
 * @param {{ onProgress?: (done:number,total:number,lineId:string)=>void, fetchImpl?: Function, abortSignal?: AbortSignal }} options
 * @returns {Promise<Record<string, {file:string, durationMs:number, sha256:string}>>}
 */
export async function synthesizeLines(lines, settings, outDir, options = {}) {
  const { onProgress, fetchImpl = fetch, abortSignal, charge = () => {} } = options;
  if (!settings.enabled && !options.force) {
    const error = new Error('语音合成未开启（socialV2.voice.tts.enabled）');
    error.code = 'VIDEO_TTS_DISABLED';
    error.hint = '设置 → SurfCore → 语音 → TTS：打开合成，或改用测试注入的合成器';
    throw error;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const results = Object.create(null);
  let done = 0;
  for (const line of lines) {
    if (abortSignal?.aborted) {
      const error = new Error('渲染被取消');
      error.code = 'VIDEO_CANCELLED';
      throw error;
    }
    const text = String(line.speech ?? '').trim();
    if (!text) {
      const error = new Error(`旁白行 ${line.lineId} 的 speech 为空`);
      error.code = 'VIDEO_TTS_EMPTY';
      throw error;
    }
    // 原合成器自己检查缓存，仅网络合成时在 fetch 包装层记账。
    const key = voiceFingerprint(settings);
    const providerCache = path.join(outDir, key);
    let blocked;
    const request = (url, init) => {
      if (abortSignal?.aborted) throw abortSignal.reason;
      try { charge([...text].length); } catch (error) { blocked = error; throw error; }
      return fetchImpl(url, { ...init, signal: abortSignal ? AbortSignal.any([abortSignal, init.signal]) : init.signal });
    };
    let durationMs;
    const synthesized = await synthesizeToFile({
      text,
      provider: settings.provider,
      character: settings.character,
      voice: settings.voice,
      style: settings.style,
      baseUrl: settings.baseUrl,
      timeoutMs: settings.timeoutMs,
      cacheVersion: settings.cacheVersion,
      breeze: settings.breeze,
      outDir: providerCache,
      fetchImpl: request,
    }).catch((error) => { throw blocked ?? error; });
    // 校验 RIFF/WAVE + 时长（方案 §5.3：坏文件直接报错，不进入时间轴）。
    const buf = fs.readFileSync(synthesized.path);
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      const error = new Error(`旁白行 ${line.lineId} 合成结果不是合法 WAV`);
      error.code = 'VIDEO_TTS_BAD_WAV';
      throw error;
    }
    durationMs = wavDurationMs(buf);
    if (durationMs <= 0) {
      const error = new Error(`旁白行 ${line.lineId} 的 WAV 时长探测失败（文件可能损坏）`);
      error.code = 'VIDEO_TTS_BAD_DURATION';
      throw error;
    }
    results[line.lineId] = { file: synthesized.path, durationMs, sha256: sha256File(synthesized.path) };
    done += 1;
    onProgress?.(done, lines.length, line.lineId);
  }
  return results;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 给 worker/测试用的“本地假声”合成器：不碰云端，生成等时长正弦音频 WAV。 */
export function makeSilentSynth() {
  const sr = 24000;
  const wavHeader = (dataBytes) => {
    const buf = Buffer.alloc(44);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataBytes, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);       // fmt chunk size
    buf.writeUInt16LE(1, 20);        // PCM
    buf.writeUInt16LE(1, 22);        // mono
    buf.writeUInt32LE(sr, 24);
    buf.writeUInt32LE(sr * 2, 28);   // byte rate (16bit mono)
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataBytes, 40);
    return buf;
  };
  return async ({ text }) => {
    const durMs = Math.max(600, Math.min(9000, Math.round(String(text).length * 210)));
    const samples = Math.floor((durMs / 1000) * sr);
    const data = Buffer.alloc(samples * 2);
    // 轻柔的正弦波，方便后续 volumedetect 质检
    for (let i = 0; i < samples; i += 1) {
      const v = Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 900);
      data.writeInt16LE(v, i * 2);
    }
    return { wav: Buffer.concat([wavHeader(data.length), data]), durationMs: durMs };
  };
}

/**
 * 用注入的合成器写 WAV 到版本目录（测试/fixture 用；产线上走 synthesizeLines）。
 * @param {(line:{lineId, speech})=>Promise<{wav:Buffer, durationMs:number}>} synth
 */
export async function synthesizeLinesWith(synth, lines, outDir, options = {}) {
  const { onProgress, abortSignal } = options;
  fs.mkdirSync(outDir, { recursive: true });
  const results = Object.create(null);
  let done = 0;
  for (const line of lines) {
    if (abortSignal?.aborted) {
      const error = new Error('渲染被取消');
      error.code = 'VIDEO_CANCELLED';
      throw error;
    }
    const text = String(line.speech ?? '').trim();
    const key = crypto.createHash('sha1').update(JSON.stringify(['fixture', text])).digest('hex');
    const file = path.join(outDir, `${key}.wav`);
    let durationMs = 0;
    if (fs.existsSync(file) && fs.statSync(file).size > 44) {
      durationMs = wavDurationMs(fs.readFileSync(file));
      if (durationMs > 0) {
        results[line.lineId] = { file, durationMs, sha256: sha256File(file) };
        done += 1;
        onProgress?.(done, lines.length, line.lineId);
        continue;
      }
    }
    const { wav, durationMs: reported } = await synth({ lineId: line.lineId, speech: text, text });
    durationMs = wavDurationMs(wav) || reported || 0;
    if (durationMs <= 0) {
      const error = new Error(`旁白行 ${line.lineId} 合成结果时长无效`);
      error.code = 'VIDEO_TTS_BAD_DURATION';
      throw error;
    }
    fs.writeFileSync(file, wav);
    results[line.lineId] = { file, durationMs, sha256: sha256File(file) };
    done += 1;
    onProgress?.(done, lines.length, line.lineId);
  }
  return results;
}
