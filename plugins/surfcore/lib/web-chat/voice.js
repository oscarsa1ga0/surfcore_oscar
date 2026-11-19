// 网页私聊的语音：复用 SurfCore 的 TTS 配置（socialV2.voice.tts）和 src/voice-tts.js 的内容寻址缓存。
// 合成结果按 wav 字节存进聊天附件，页面用 <audio> 播放；不依赖 QQ 桥接进程。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readQqConfig } from '../store.js';
import { synthesizeToFile, wavDurationMs } from '../../../../src/voice-tts.js';

/** 语音语气：和 QQ 桥接的 VOICE_TONES 完全一致（8 个名字 + intensity 0~1）。 */
export const VOICE_TONES = {
  开心: '语气轻快，尾音微微上扬，带一点笑意',
  温柔: '语气柔和，语速稍慢，像在耳边说话',
  委屈: '语气低一点，语速慢，句尾往下沉',
  生气: '语气硬，语速稍快，不拖泥带水',
  疲惫: '声音有点懒，语速偏慢，不用力',
  撒娇: '带点笑意和黏糊，尾音软下来',
  平静: '平稳、干净，不带明显情绪',
  兴奋: '语速快一点，情绪外放，声音亮',
};

export function toneInstruction(tone, intensity, custom = {}) {
  const name = String(tone ?? '').trim();
  const preset = name ? String(custom[name] || VOICE_TONES[name] || '') : '';
  if (!preset) return '';
  const k = Number(intensity);
  const adjust = Number.isFinite(k)
    ? (k >= 0.75 ? '语气再明显一点' : k <= 0.3 ? '收着一点，不要过' : '')
    : '';
  return [preset, adjust].filter(Boolean).join('；');
}

const clampInt = (value, fallback, min, max) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function voiceSettings(config = readQqConfig()?.config ?? {}) {
  const v = config?.socialV2?.voice ?? {};
  const t = v?.tts ?? {};
  const route = ['local', 'cloud'].includes(String(t.route)) ? String(t.route) : 'local';
  const endpoints = {
    local: String(t.endpoints?.local || 'http://127.0.0.1:8765'),
    cloud: String(t.endpoints?.cloud || 'http://127.0.0.1:8767'),
  };
  return {
    enabled: t.enabled === true,
    provider: String(t.provider) === 'breeze' ? 'breeze' : 'voxd',
    maxChars: clampInt(t.maxChars, 120, 20, 300),
    route,
    baseUrl: endpoints[route] || String(t.baseUrl || 'http://127.0.0.1:8765'),
    timeoutMs: clampInt(t.timeoutMs, 60000, 3000, 180000),
    character: String(t.character || ''),
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
    tonePresets: v.tonePresets && typeof v.tonePresets === 'object' ? v.tonePresets : {},
  };
}

const AUDIO_TYPE = [
  { type: 'audio/wav', test: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' },
  { type: 'audio/mpeg', test: (b) => b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 6) !== 0) },
  { type: 'audio/ogg', test: (b) => b.toString('ascii', 0, 4) === 'OggS' },
  { type: 'audio/mp4', test: (b) => b.toString('ascii', 4, 8) === 'ftyp' },
  { type: 'audio/flac', test: (b) => b.toString('ascii', 0, 4) === 'fLaC' },
  { type: 'audio/webm', test: (b) => b.subarray(0, 4096).includes(Buffer.from('A_OPUS')) },
  { type: 'audio/aac', test: (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0 },
];

export function audioTypeOf(bytes) {
  return AUDIO_TYPE.find((item) => item.test(bytes))?.type ?? 'audio/wav';
}

/** 用给定配置合成（测试用）；返回 { type, bytes, durationMs, text }。 */
export async function synthesizeWith(settings, text, { outDir, fetchImpl, tone, intensity } = {}) {
  if (!settings?.enabled) throw new Error('语音合成未开启');
  const spoken = String(text ?? '').trim().slice(0, settings.maxChars);
  if (!spoken) throw new Error('没有可念的内容');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const base = String(settings.breeze.instructions || '');
  const extra = toneInstruction(tone, intensity, settings.tonePresets || {});
  const instructions = [base, extra].filter(Boolean).join('；').slice(0, 300);
  const result = await synthesizeToFile({
    text: spoken,
    provider: settings.provider,
    breeze: { ...settings.breeze, instructions },
    character: settings.character,
    baseUrl: settings.baseUrl,
    timeoutMs: settings.timeoutMs,
    cacheVersion: settings.cacheVersion,
    outDir,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const bytes = fs.readFileSync(result.path);
  return { type: audioTypeOf(bytes), bytes, durationMs: result.durationMs ?? 0, text: spoken };
}

export function synthesizeVoice(text, options = {}) {
  return synthesizeWith(voiceSettings(), text, options);
}

export function voiceDirFor(stateDir) {
  return path.join(stateDir, 'web-chat', 'voice');
}

const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'];

/** 语音库：列出目录里的音频文件（相对路径）。 */
export function listVoiceFiles(dir) {
  const out = [];
  const walk = (base, depth) => {
    if (depth > 2) return;
    let entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(base, entry.name);
      if (entry.isDirectory()) { if (!entry.name.startsWith('.')) walk(full, depth + 1); continue; }
      if (entry.isFile() && AUDIO_EXTS.includes(path.extname(entry.name).toLowerCase())) {
        try { out.push({ path: path.relative(dir, full), bytes: fs.statSync(full).size }); } catch {}
      }
    }
  };
  walk(dir, 0);
  return out.slice(0, 50);
}

/** 从语音库读音频：只允许库目录内的文件。 */
export function readVoiceFile(dir, name) {
  const root = fs.realpathSync(dir);
  const file = fs.realpathSync(path.resolve(root, String(name ?? '')));
  if (!file.startsWith(root + path.sep)) throw new Error('路径不在语音库内');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('语音文件必须小于 8 MB。');
  const bytes = fs.readFileSync(file);
  return { type: audioTypeOf(bytes), bytes };
}


const run = promisify(execFile);

/** 可选的本地 Whisper，语音和转写均留在本机。 */
export async function transcribeWebAudio(audio, config, signal) {
  const { executable, model } = config.transcription ?? {};
  if (!executable || !model) return { text: '', clipped: false };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'surfcore-web-asr-'));
  try {
    const input = path.join(dir, 'source');
    const wav = path.join(dir, 'speech.wav');
    const output = path.join(dir, 'transcript');
    await fsp.writeFile(input, audio.bytes, { mode: 0o600 });
    await run(config.ffmpeg || 'ffmpeg', ['-nostdin', '-v', 'error', '-i', input,
      '-map', '0:a:0', '-t', '90', '-ac', '1', '-ar', '16000', wav], { timeout: 12_000, signal });
    await run(executable, ['-m', model, '-f', wav, '-l', 'zh', '-otxt', '-of', output], { timeout: 45_000, signal });
    const transcript = (await fsp.readFile(output + '.txt', 'utf8')).trim();
    return { text: transcript.slice(0, 2000), clipped: wavDurationMs(await fsp.readFile(wav)) >= 90_000 || transcript.length > 2000 };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
