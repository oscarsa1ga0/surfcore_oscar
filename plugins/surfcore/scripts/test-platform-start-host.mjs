/**
 * 平台启动开关的宿主接线（mock ctx，不启动 DSH / 不启停真实桥接）。
 *
 * 钉住：
 *   · 开关关闭时插件加载不会启动生物钟（scheduler.running=false / disabled=true）；
 *   · /overview 暴露 platformStart；
 *   · /bridge 的 start-qq / start-bili / start-all 在开关关闭时不会偷偷拉起平台。
 *   · 单次唤醒按需创建 B站工作区和会话，保留排程文件与自动启动状态。
 *
 * 用临时 DSH_HOME，不读写真实 ~/.dsh。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-platform-host-'));
const stateDir = path.join(tmp, 'surfcore');
const fakeRoot = path.join(tmp, 'qq-bridge');
fs.mkdirSync(path.join(fakeRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(fakeRoot, 'src', 'bridge.js'), '// fixture\n');
fs.writeFileSync(path.join(fakeRoot, 'config.json'), JSON.stringify({ consolePort: 1, consoleToken: 'fixture-console-token' }));
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'config.json'), `${JSON.stringify({
  version: 1,
  bridge: { autoStart: true },
  platforms: { start: { qq: false, bili: false } },
}, null, 2)}\n`, 'utf8');

process.env.SURFCORE_ROOT = fakeRoot;
process.env.DSH_HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.SURFCORE_SKIP_AUTOSTART = '1';
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1';
process.env.SURFCORE_DISABLE_MEMORY_TIMER = '1';

const { apply } = await import('../lib/index.js');
const { characterPaths, readCurrentCharacter } = await import('../../../src/character-persona.js');
const { dialogueEmotionScope, enqueueEmotionEvent } = await import('../../../src/emotion-events.js');
const hostEvents = new Map();
let emotionProvider;

const routes = [];
const effects = [];
const workspaces = [];
const workspaceTitles = [];
const sessions = [];
const prompts = [];
let promptResult = async () => ({ accepted: true });
const ctx = {
  webServer: { register(route) { routes.push(route); return () => {}; } },
  get(name) {
    if (name === 'connection') return { requestRejection: () => false };
    if (name === 'systemPrompt') return { context(provider) { emotionProvider = provider; return () => {}; } };
    if (name === 'workingDirectory') return { get: (session) => session.directory };
    return null;
  },
  effect(fn) { effects.push(fn); return () => {}; },
  on(name, callback) { hostEvents.set(name, callback); return () => hostEvents.delete(name); },
  workspaceController: {
    create: async (params) => {
      workspaces.push(params);
      return { created: true, workspace: { workspaceId: 'ws-bili' } };
    },
    rename: async (params) => { workspaceTitles.push(params); },
  },
  sessionController: {
    list: async () => ({ items: [] }),
    state: async () => ({ active: true, running: false, queue: [], pendingInput: [] }),
    wait: async () => ({ reason: 'idle', state: { active: true, running: false, queue: [], pendingInput: [] } }),
    resolveAgent: async (sessionId) => sessions.some((session) => session.sessionId === sessionId)
      ? { agent: { id: sessionId } }
      : { error: { code: 'session/not-found' } },
    create: async (params) => { sessions.push(params); return { sessionId: params.sessionId }; },
    prompt: async (args, signal) => {
      prompts.push({ args, signal });
      return promptResult();
    },
  },
  settings: null,
};

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {}; },
    end(body = '') { this.body += body; },
  };
}
function fakeReq(method, url, body, headers) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:58750', ...(body ? { 'content-type': 'application/json' } : {}), ...headers };
  if (body) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  }
  return req;
}
async function invoke(route, method, url, body, headers) {
  const res = fakeRes();
  await route.handler(fakeReq(method, url, body, headers), res);
  return { status: res.statusCode, data: JSON.parse(res.body || '{}') };
}

try {
  apply(ctx);
  const api = routes.find((route) => route.path === '/dsh-surfcore/api');
  assert.ok(api, 'API 路由没有注册');

  const overview = await invoke(api, 'GET', '/dsh-surfcore/api/overview');
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.data.platformStart, { qq: false, bili: false },
    '/overview 的 platformStart 应反映开关');
  assert.ok(overview.data.launch?.qq && overview.data.launch?.bili && overview.data.launch?.pet && overview.data.launch?.voice, 'overview 必须带统一 launch 状态');
  assert.equal(overview.data.scheduler.running, false, 'B站 开关关闭时生物钟不应运行');
  assert.equal(overview.data.scheduler.disabled, true, 'B站 开关关闭时 scheduler.disabled 应为 true');

  for (const action of ['start-qq', 'start-bili']) {
    const res = await invoke(api, 'POST', '/dsh-surfcore/api/bridge', { action });
    assert.equal(res.status, 409, `${action} 在开关关闭时应拒绝`);
    assert.match(String(res.data.error ?? ''), /启动开关/, `${action} 的错误文案应说明开关关闭`);
  }

  // 新的一键启动：多选 + 每项结构化结果；平台开关关闭时不允许偷偷拉起。
  const selected = await invoke(api, 'POST', '/dsh-surfcore/api/bridge', {
    action: 'start-selected', components: ['qq', 'bili'], voicePack: 'voice-local',
  });
  assert.equal(selected.status, 200);
  assert.equal(selected.data.ok, false, '平台开关关闭时一键启动不能报成功');
  assert.equal(selected.data.items?.length, 2, '每个勾选项都要有独立结果');
  for (const item of selected.data.items) {
    assert.equal(item.ok, false, `${item.id} 应失败`);
    assert.ok(item.code && item.hint, `${item.id} 失败必须有 code/hint`);
  }
  const empty = await invoke(api, 'POST', '/dsh-surfcore/api/bridge', { action: 'start-selected', components: [] });
  assert.equal(empty.data.code, 'NO_COMPONENTS', '空选择必须结构化拒绝');
  assert.ok(empty.data.hint, '空选择必须给下一步');

  const stopped = await invoke(api, 'POST', '/dsh-surfcore/api/bridge', {
    action: 'stop-selected', components: ['qq', 'bili', 'pet', 'voice'],
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.items?.length, 4, '一键停止要覆盖四项');
  assert.ok(stopped.data.items.every((x) => x.ok), '未运行的服务停止应幂等成功');

  // 一键启动：两个都关 → 跳过两边，不启动任何进程。
  const all = await invoke(api, 'POST', '/dsh-surfcore/api/bridge', { action: 'start-all' });
  assert.equal(all.status, 200);
  assert.equal(all.data.bridge?.skipped, true, 'QQ 关闭时一键启动应跳过桥接');
  assert.equal(all.data.scheduler?.disabled, true, 'B站 关闭时一键启动应跳过生物钟');
  assert.equal(all.data.snowluma?.skipped, true, 'QQ 关闭时一键启动不应打开 SnowLuma');

  const wakePath = '/dsh-surfcore/api/bili/wake-now';
  const needsLogin = await invoke(api, 'POST', wakePath, {});
  assert.equal(needsLogin.status, 409);
  assert.equal(needsLogin.data.code, 'BILI_WAKE_LOGIN');
  assert.ok(needsLogin.data.hint);
  assert.equal(sessions.length, 0);

  const biliDir = path.join(stateDir, 'bili');
  const credentials = path.join(biliDir, 'credentials.json');
  const schedule = path.join(biliDir, 'whale-night.json');
  fs.mkdirSync(biliDir, { recursive: true });
  fs.writeFileSync(credentials, JSON.stringify({ sessdata: 'fixture', bili_jct: 'fixture' }));
  const plan = '{"date":"2026-11-12","action":"done","wakes":12,"watchWakes":10}\n';
  fs.writeFileSync(schedule, plan);
  const originalConfig = fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8');
  let markPromptEntered;
  let completePrompt;
  const promptEntered = new Promise((resolve) => { markPromptEntered = resolve; });
  promptResult = () => new Promise((resolve) => {
    completePrompt = resolve;
    markPromptEntered();
  });
  const firstWake = await invoke(api, 'POST', wakePath, {});
  const waitEntered = await Promise.race([promptEntered.then(() => true), delay(5000, false, { ref: false })]);
  assert.equal(waitEntered, true, '手动唤醒必须绕过已结束的自动计划');
  assert.equal(prompts.length, 1);
  const duplicate = await invoke(api, 'POST', wakePath, {});
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, 'BILI_WAKE_BUSY');
  assert.ok(duplicate.data.hint);
  assert.deepEqual(firstWake, { status: 202, data: { ok: true, queued: true, sessionId: 'bili-whale' } });

  const dispatchPath = '/dsh-surfcore/api/role-dispatch';
  const qqPath = `${dispatchPath}/qq`;
  const headers = { 'x-console-token': 'fixture-console-token' };
  const qq = { id: randomUUID(), role: { characterId: 'default', epoch: 0 }, action: 'reserve', priority: 'manual' };
  assert.equal((await invoke(api, 'POST', qqPath, qq)).status, 403);
  assert.equal((await invoke(api, 'POST', qqPath, qq, { ...headers, origin: 'http://127.0.0.1:58750' })).status, 403);
  assert.equal((await invoke(api, 'POST', qqPath, qq, headers)).data.state, 'queued');
  const duringWake = await invoke(api, 'GET', dispatchPath);
  assert.equal(duringWake.data.active.source, 'bili');
  assert.deepEqual(duringWake.data.waiting, [{ source: 'qq', count: 1 }]);
  assert.ok(!JSON.stringify(duringWake.data).includes('fixture-console-token'));
  await invoke(api, 'POST', qqPath, { ...qq, action: 'release' }, headers);
  assert.equal(prompts[0].signal.aborted, false);
  completePrompt({ accepted: true });
  await delay(30);
  assert.deepEqual(workspaces, [{ path: path.join(stateDir, 'state', 'bili-agents') }]);
  assert.deepEqual(workspaceTitles, [{ workspaceId: 'ws-bili', title: 'B站生物钟' }]);
  assert.deepEqual(sessions, [{ sessionId: 'bili-whale', workspaceId: 'ws-bili' }]);
  assert.equal(prompts[0].args.mode, 'queue');
  assert.match(prompts[0].args.content[0].text, /【手动唤醒】.*逛一轮 B 站/);
  assert.equal(fs.readFileSync(schedule, 'utf8'), plan);
  assert.equal(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'), originalConfig);
  const afterWake = await invoke(api, 'GET', '/dsh-surfcore/api/overview');
  assert.equal(afterWake.data.scheduler.running, false);
  assert.equal(afterWake.data.platformStart.bili, false);

  promptResult = async () => ({ accepted: false });
  const rejected = await invoke(api, 'POST', wakePath, {});
  assert.equal(rejected.status, 202);
  let failure;
  for (let attempt = 0; attempt < 60 && !failure; attempt += 1) {
    await delay(75);
    failure = (await invoke(api, 'GET', dispatchPath)).data.lastError;
  }
  assert.equal(failure?.source, 'bili');
  assert.match(failure?.error ?? '', /唤醒失败/);
  assert.ok(failure?.hint);
  assert.equal(sessions.length, 1, '再次唤醒复用现有会话');
  assert.equal(fs.readFileSync(schedule, 'utf8'), plan);

  // 保存配置时把开关打开（跳过真实进程，只验证配置落盘与返回值）。
  const saved = await invoke(api, 'POST', '/dsh-surfcore/api/config', {
    unified: { platforms: { start: { qq: true, bili: true } } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.platformStart?.qq, true);
  assert.equal(saved.data.platformStart?.bili, true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
  assert.deepEqual(onDisk.platforms.start, { qq: true, bili: true });

  const started = await invoke(api, 'POST', '/dsh-surfcore/api/bridge', { action: 'start-bili' });
  assert.equal(started.data.scheduler.running, true);
  promptResult = async () => ({ accepted: true });
  assert.deepEqual(await invoke(api, 'POST', wakePath, {}), { status: 202, data: { ok: true, queued: true, sessionId: 'bili-whale' } });
  for (let attempt = 0; attempt < 60 && prompts.length < 3; attempt += 1) await delay(75);
  const whileRunning = await invoke(api, 'GET', '/dsh-surfcore/api/overview');
  assert.deepEqual(whileRunning.data.scheduler, started.data.scheduler, '手动唤醒不能重启自动调度器');
  assert.equal(sessions.length, 1);
  assert.equal(workspaces.length, 1);
  assert.equal(prompts.length, 3);
  assert.equal(new Set(prompts.map(({ args }) => args.requestId)).size, 3);
  assert.equal(fs.readFileSync(schedule, 'utf8'), plan);

  const emotionUrl = '/dsh-surfcore/api/emotion';
  const roleDir = characterPaths('test-emotion');
  fs.mkdirSync(roleDir.dir, { recursive: true });
  fs.writeFileSync(roleDir.manifest, '{}');
  fs.writeFileSync(path.join(stateDir, 'characters', 'current.json'), JSON.stringify({ id: roleDir.id, name: '测试角色', epoch: 2 }));
  const role = readCurrentCharacter();
  const emotionPage = await invoke(api, 'GET', emotionUrl);
  assert.equal(emotionPage.data.character.id, role.id);
  assert.equal(Object.keys(emotionPage.data.dimensions).length, 9);
  assert.equal(emotionProvider.text({ agent: { session: { id: 'unrelated' } } }), '');
  const native = { session: { id: 'native-test', directory: role.dir } };
  assert.match(emotionProvider.text({ agent: native }), /【当下心境】/);
  const user = { source: { kind: 'user' }, content: [{ type: 'text', text: '你真棒' }] };
  await hostEvents.get('agent/pre-step')({ agent: native, turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [user] }));
  assert.equal((await invoke(api, 'GET', emotionUrl)).data.recent[0].source, 'native');

  const scope = dialogueEmotionScope('qq-private', 'private:123', '123');
  const roleRef = { characterId: role.id, epoch: role.epoch };
  const reservation = { action: 'reserve', id: randomUUID(), role: roleRef, priority: 'manual' };
  let reserved;
  for (let n = 0; n < 40 && reserved?.data.state !== 'granted'; n++) {
    reserved = await invoke(api, 'POST', qqPath, reservation, headers);
    if (reserved.data.state !== 'granted') await delay(50);
  }
  assert.equal(reserved?.data.state, 'granted');
  const affectPrompt = { sessionId: 'qq-emotion', content: [{ type: 'text', text: '角色卡' }], emotion: scope };
  const submitted = await invoke(api, 'POST', qqPath, { ...reservation, action: 'submit', prompt: affectPrompt }, headers);
  assert.equal(submitted.status, 200);
  assert.equal(Object.hasOwn(prompts.at(-1).args, 'emotion'), false, '只把允许的 DSH prompt 参数交给宿主');
  const qqAgent = { session: { id: affectPrompt.sessionId } };
  assert.doesNotMatch(emotionProvider.text({ agent: qqAgent }), /生气/);
  enqueueEmotionEvent({ ...scope, kind: 'blameHard', key: 'first-qq' }, role);
  enqueueEmotionEvent({ ...scope, kind: 'blameHard', key: 'second-qq' }, role);
  assert.match(emotionProvider.text({ agent: qqAgent }), /生气/, '请求真正准备时读取排队期间的最新心境');
  const disabled = await invoke(api, 'POST', emotionUrl, { ...roleRef, settings: { enabled: false } });
  assert.equal(disabled.status, 200);
  assert.equal(emotionProvider.text({ agent: qqAgent }), '');

  console.log('platform-start host wiring OK');
} finally {
  for (const fn of effects) {
    try {
      const dispose = fn();
      if (typeof dispose === 'function') dispose();
    } catch {}
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
