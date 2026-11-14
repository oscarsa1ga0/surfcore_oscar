// BreezeBlue TTS 客户端契约：不联网，用本地 HTTP server 冒充 api.breeze.blue。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { synthesizeBreezeToFile } from '../src/voice-tts.js'

function wavBytes(seconds = 0.1) {
  const sampleRate = 24000
  const dataSize = Math.max(2, Math.round(sampleRate * seconds) * 2)
  const b = Buffer.alloc(44 + dataSize)
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataSize, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(dataSize, 40)
  return b
}

test('Breeze：请求头/URL/body 正确，落 wav 并缓存', async () => {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body) })
      const wav = wavBytes(0.2)
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length })
      res.end(wav)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-tts-'))
  try {
    const out = await synthesizeBreezeToFile({
      text: '你好，鱼姬', apiKey: 'brz_test', voiceId: 'voc_test', modelId: 'breeze-tts-2',
      instructions: '温柔一点', baseUrl: `http://127.0.0.1:${port}`, outDir: dir,
    })
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /^\/v1\/text-to-speech\/voc_test\?output_format=wav_24000$/)
    assert.equal(calls[0].headers['xi-api-key'], 'brz_test')
    assert.equal(calls[0].body.text, '你好，鱼姬')
    assert.equal(calls[0].body.model_id, 'breeze-tts-2')
    assert.equal(calls[0].body.instructions, '温柔一点')
    assert.ok(fs.existsSync(out.path))
    assert.ok(out.durationMs > 0)
    const again = await synthesizeBreezeToFile({
      text: '你好，鱼姬', apiKey: 'brz_test', voiceId: 'voc_test', modelId: 'breeze-tts-2',
      instructions: '温柔一点', baseUrl: `http://127.0.0.1:${port}`, outDir: dir,
    })
    assert.equal(again.cached, true)
    assert.equal(calls.length, 1)
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Breeze：缺 key/voice 直接给出配置错误', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-tts-'))
  try {
    await assert.rejects(() => synthesizeBreezeToFile({ text: 'x', outDir: dir, voiceId: 'v' }), /API Key/)
    await assert.rejects(() => synthesizeBreezeToFile({ text: 'x', outDir: dir, apiKey: 'k' }), /Voice ID/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
