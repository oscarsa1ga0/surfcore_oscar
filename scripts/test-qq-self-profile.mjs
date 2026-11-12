import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const id = '123456';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';
let fetchedUrl;
let failFetch = false;
const h = await bridgeHarness({
  config: { snowluma: { provider: 'onebot' }, greetings: { enabled: true, morning: { uin: '123', time: '08:00' } } },
  globals: { safeFetchBuffer: async (url) => {
    fetchedUrl = url;
    if (failFetch) throw new Error('avatar unavailable');
    return { buffer: Buffer.from(png, 'base64') };
  } },
});
let server;
try {
  h.setSelfIdentity('旧昵称', id);
  let profile = { user_id: id, nickname: '新昵称' };
  let profileQueries = 0;
  h.bot.request = async (action, params) => {
    assert.equal(action, 'get_stranger_info');
    assert.equal(params.user_id, Number(id));
    assert.equal(params.no_cache, true);
    profileQueries++;
    return { retcode: 0, data: profile };
  };
  await h.refreshQqSelfProfile();
  assert.match(h.selfIdentityTextV2(), /新昵称/);
  const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'self-identity.json'), 'utf8'));
  assert.equal(saved.nickname, '新昵称');
  // 2026-11-12 掉线修复：资料查询走缓存，不再被每分钟探活反复打到 QQ 服务端。
  profile = { user_id: '123457', nickname: '其他帐号' };
  await h.refreshQqSelfProfile();
  assert.equal(profileQueries, 1, '缓存期内重复调用不应再查资料接口');
  assert.match(h.selfIdentityTextV2(), /新昵称/);

  h.setSnowlumaHealth({ connected: true, accountOnline: true, good: true });
  let profileOk = true;
  let friends = [{ user_id: 123 }];
  let friendQueries = 0;
  let sessionProfileQueries = 0;
  h.bot.raw = async () => friends;
  h.bot.request = async (action, params) => {
    if (action === 'get_friend_list') {
      friendQueries++;
      assert.equal(params.no_cache, undefined, '探活读本地好友列表，不应强制刷新');
      return { retcode: 0, data: friends };
    }
    assert.equal(action, 'get_stranger_info');
    assert.equal(params.no_cache, true);
    sessionProfileQueries++;
    return profileOk ? { retcode: 0, data: { user_id: id, nickname: '新昵称' } } : { retcode: 1200, data: null };
  };
  for (let i = 0; i < 3; i += 1) await h.checkOneBotSession();
  assert.equal(sessionProfileQueries, 0, '健康时探活不应触碰 QQ 资料接口');
  assert.equal(h.snowlumaHealthSnapshot().sessionFailure, null);
  assert.equal((await h.greetingFriendCheck('123', { refresh: true })).checked, true);
  // 名单变空：连续两次后再做一次资料交叉核对；资料也失败才算会话异常。
  friends = [];
  await h.checkOneBotSession();
  assert.equal(sessionProfileQueries, 0, '单次空名单不足以判定会话异常');
  profileOk = false;
  await h.checkOneBotSession();
  assert.equal(sessionProfileQueries, 1);
  const unhealthy = h.snowlumaHealthSnapshot();
  assert.equal(unhealthy.accountOnline, true);
  assert.equal(unhealthy.degraded, true);
  assert.equal(unhealthy.sessionFailure.code, 'ONEBOT_QQ_SESSION_UNAVAILABLE');
  assert.match(unhealthy.sessionFailure.hint, /重新登录/);
  const purposeCheck = await h.greetingFriendCheck('123', { refresh: true });
  assert.equal(purposeCheck.checked, false, '网关异常不能当成目标不在好友列表');
  assert.equal(purposeCheck.sessionFailure.code, unhealthy.sessionFailure.code);
  server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-console-token': 'fixture-console-token' };
  h.setMode('reserved2');
  h.setReady(true);
  for (const [route, status] of [['purpose/run', 409], ['greeting/test', 503]]) {
    const response = await fetch(`${base}/api/${route}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, status, route);
    const failure = await response.json();
    assert.equal(failure.code, unhealthy.sessionFailure.code, route);
    assert.equal(failure.hint, unhealthy.sessionFailure.hint, route);
  }
  profileOk = true;
  friends = [{ user_id: 123 }];
  await h.checkOneBotSession();
  assert.equal(h.snowlumaHealthSnapshot().degraded, false);
  assert.equal((await h.greetingFriendCheck('123', { refresh: true })).ok, true);

  const url = `${base}/api/socialV2/self-image?key=private:123`;
  const read = () => fetch(url, { headers });
  const avatar = await read().then((r) => r.json());
  assert.equal(avatar.source, 'qq-avatar');
  assert.equal(avatar.image.data, png);
  assert.equal(new URL(fetchedUrl).searchParams.get('nk'), id);
  failFetch = true;
  const unavailable = await read();
  assert.equal(unavailable.status, 502);
  assert.equal((await unavailable.json()).code, 'QQ_AVATAR_UNAVAILABLE');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await h.close();
}
console.log('QQ 昵称刷新、帐号校验和头像读取通过');
