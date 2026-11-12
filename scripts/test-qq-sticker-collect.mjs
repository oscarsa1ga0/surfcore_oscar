// Exercise collection through the actual bridge route using a local NapCat protocol fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
const md5 = createHash('md5').update(png).digest('hex');
const sha256 = createHash('sha256').update(png).digest('hex');
const favorite = { resId: 'qq-favorite', md5, url: 'https://public.invalid/cat.png' };
const h = await bridgeHarness({ config: { snowluma: { provider: 'onebot' } } });
const ok = (data) => ({ status: 'ok', retcode: 0, data });
let server;
try {
  const key = 'private:123';
  h.setMode('reserved2');
  h.appendSocialV2Message(key, 'owner', '[表情]', '[表情]', false, true, '1001',
    [{ kind: 'sticker', file: 'cat.png' }], '123', []);
  h.bot.getImage = async () => ({ base64: png.toString('base64') });
  let file;
  let added = false;
  let addCount = 0;
  let revealFavorite = false;
  h.bot.request = async (action, params) => {
    if (action === 'get_version_info') return ok({ app_name: 'NapCat.Onebot' });
    if (action === 'fetch_custom_face_detail') return ok(added && revealFavorite ? [favorite] : []);
    if (action === 'upload_file_stream') {
      if (params.is_complete) {
        return ok({ status: 'file_complete', stream_id: params.stream_id, file_path: file, sha256, file_size: png.length });
      }
      assert.deepEqual(Buffer.from(params.chunk_data, 'base64'), png);
      assert.equal(params.expected_sha256, sha256);
      file = `/container/NapCat/temp/${params.filename}`;
      return ok({ status: 'chunk_received', stream_id: params.stream_id });
    }
    if (action === 'add_custom_face') {
      assert.equal(params.file, file);
      added = true;
      addCount++;
      return ok({ result: true, isExist: false });
    }
    assert.fail(`unexpected action: ${action}`);
  };
  server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const collect = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/collect-sticker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
        'x-agent-token': h.getSocialV2State(key).agentToken },
      body: JSON.stringify({ key, messageId: '1001', remark: '橘猫', content: '猫在笑' }),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  const unverified = await collect();
  assert.equal(unverified.status, 502);
  assert.equal(unverified.body.code, 'STICKER_COLLECT_UNVERIFIED');
  assert.ok(unverified.body.hint);
  assert.equal(addCount, 1);

  added = false;
  revealFavorite = true;
  const collected = await collect();
  assert.equal(collected.status, 200, JSON.stringify(collected.body));
  assert.equal(collected.body.emojiId, favorite.resId);
  assert.equal(collected.body.alreadyCollected, false);
  assert.equal(collected.body.sticker.content, '猫在笑');
  assert.equal(collected.body.remarkStored, 'local');
  assert.equal(addCount, 2);

  const repeated = await collect();
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.alreadyCollected, true);
  assert.equal(addCount, 2);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await h.close();
}
console.log('✅ NapCat 收藏表情已验证上传、QQ 列表回读和重复收藏');
