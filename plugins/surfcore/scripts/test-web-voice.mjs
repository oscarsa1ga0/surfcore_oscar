import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synthesizeWith, toneInstruction } from '../lib/web-chat/voice.js';

const wav = Buffer.alloc(48);
wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(40, 4); wav.write('WAVE', 8, 'ascii');
wav.write('fmt ', 12, 'ascii'); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36, 'ascii'); wav.writeUInt32LE(4, 40);

const settings = {
  enabled: true, maxChars: 120, provider: 'breeze', character: '', baseUrl: '', timeoutMs: 5000, cacheVersion: 0,
  breeze: { apiKey: 'k', voiceId: 'v', baseUrl: 'https://example.invalid', modelId: 'm', instructions: '', outputFormat: 'wav_24000', guidanceScale: null },
};
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-voice-'));
try {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, arrayBuffer: async () => wav }; };
  assert.equal(toneInstruction('温柔'), '语气柔和，语速稍慢，像在耳边说话');
  assert.match(toneInstruction('开心', 0.9), /语气再明显一点/);
  assert.equal(toneInstruction('不存在'), '');
  let captured;
  const captureFetch = async (url, init) => { captured = JSON.parse(init.body); return { ok: true, arrayBuffer: async () => wav }; };
  await synthesizeWith(settings, '你好呀', { outDir, fetchImpl: captureFetch, tone: '温柔' });
  assert.equal(captured.text, '你好呀');
  assert.match(captured.instructions ?? '', /语气柔和/);
  const first = await synthesizeWith(settings, '你好呀', { outDir, fetchImpl });
  assert.equal(first.type, 'audio/wav');
  assert.equal(first.bytes.length, wav.length);
  const second = await synthesizeWith(settings, '你好呀', { outDir, fetchImpl });
  assert.equal(second.bytes.length, wav.length);
  assert.equal(calls, 1, '同一句话第二次应命中内容缓存，不再请求');
  await assert.rejects(() => synthesizeWith({ ...settings, enabled: false }, 'x', { outDir, fetchImpl }), /未开启/);
  console.log('✓ 语音：合成、wav 识别、内容缓存、开关');
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
