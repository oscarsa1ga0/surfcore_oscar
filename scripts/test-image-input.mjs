// QQ 图片回归：夹具 DSH 目录 + OneBot 图片 + 真实桥接只读端点。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { downloadOneBotImageStream } from '../src/onebot-image-stream.js';

const provider = 'deepseek-account';
const model = 'deepseek-flash';
const key = 'private:123';
const file = 'fixture.png';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');

function napCatResponse({ size = png.length, complete = true } = {}) {
  const frames = [
    { type: 'stream', data_type: 'file_info', file_size: size },
    { type: 'stream', data_type: 'file_chunk', index: 0, size: png.length, data: png.toString('base64') },
    ...(complete ? [{ type: 'response', data_type: 'file_complete', total_chunks: 1, total_bytes: png.length }] : []),
  ];
  const wire = Buffer.from(frames.map((data) => JSON.stringify({ status: 'ok', retcode: 0, data })).join('\r\n\r\n'));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < wire.length; i += 17) controller.enqueue(wire.subarray(i, i + 17));
    controller.close();
  } }));
}

async function readImage({ modalities, imageInput = 'auto', broken = false, container = false } = {}) {
  const selection = { provider, model };
  let streamRequests = 0;
  const h = await bridgeHarness({ config: {
    dsh: { authToken: 'fixture-only', provider: 'deepseek-official', model, followDefaultModel: true },
    snowluma: { provider: 'onebot', httpUrl: 'http://127.0.0.1:3000' },
    socialV2: { vision: { imageInput } },
  }, globals: {
    downloadOneBotImageStream: (options) => downloadOneBotImageStream({ ...options, request: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:3000/download_file_image_stream');
      assert.equal(JSON.parse(init.body).file, file, '传 OneBot 文件引用，不能传容器路径');
      streamRequests++;
      return broken ? new Response(null, { status: 404 }) : napCatResponse();
    } }),
  } });
  let server;
  try {
    h.setMode('reserved2');
    h.api.callUnary = async (method) => {
      assert.equal(method, 'session.modelCatalog');
      return { result: { ok: true, value: {
        default: selection,
        routableProviders: [provider],
        groups: [{ id: provider, models: [{ id: model, inputModalities: modalities }] }],
      } } };
    };
    h.api.sessions.selectModel = async ({ provider: requested }) => {
      assert.equal(requested, provider, '应该使用 DSH 默认模型的 provider');
      return { result: { ok: true, value: { selected: selection } } };
    };
    await h.ensureSession(key);
    h.appendSocialV2Message(key, 'fixture', '[图片]', '[图片]', false, false, '1001', [{ kind: 'image', file }], '123', []);
    if (container) h.bot.getImage = async () => ({ file: '/container/cache/fixture.png' });
    if (broken) h.bot.getImage = async () => { throw new Error('fixture gateway unavailable'); };
    server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/images/message?key=${key}&messageId=1001`, {
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': h.getSocialV2State(key).agentToken },
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json(), downloads: h.calls.images, streamRequests };
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

const unknown = await readImage();
assert.equal(unknown.status, 200, JSON.stringify(unknown.body));
assert.equal(unknown.body.images[0].mimeType, 'image/png');
assert.equal(Buffer.from(unknown.body.images[0].data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
assert.deepEqual(unknown.downloads, [file]);
assert.equal(unknown.streamRequests, 0, '标准 get_image 已返回原图时无需再请求');

const container = await readImage({ container: true });
assert.equal(container.status, 200, JSON.stringify(container.body));
assert.deepEqual(Buffer.from(container.body.images[0].data, 'base64'), png);
assert.equal(container.streamRequests, 1);

for (const options of [{ modalities: ['text'] }, { modalities: ['text', 'image'], imageInput: 'false' }]) {
  const result = await readImage(options);
  assert.equal(result.status, 409);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, 'IMAGE_INPUT_DISABLED');
  assert.ok(result.body.hint);
  assert.deepEqual(result.downloads, []);
  assert.equal(result.streamRequests, 0);
}

const broken = await readImage({ modalities: ['text', 'image'], broken: true });
assert.equal(broken.status, 502);
assert.equal(broken.body.ok, false);
assert.equal(broken.body.code, 'IMAGE_FETCH_FAILED');
assert.ok(broken.body.hint);
const options = { httpUrl: 'http://127.0.0.1:3000', file, maxBytes: 1024 };
await assert.rejects(downloadOneBotImageStream({ ...options, request: async () => napCatResponse({ complete: false }) }), /未完整接收/);
await assert.rejects(downloadOneBotImageStream({ ...options, request: async () => napCatResponse({ size: 1025 }) }), /超限/);
await assert.rejects(downloadOneBotImageStream({ ...options, file: '../private.png', request: async () => assert.fail('不应请求网关') }), /无效/);
console.log('✅ QQ 图片端点返回有效 PNG；禁用或下载失败时给出原因和下一步');
