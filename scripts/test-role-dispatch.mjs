import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createRoleDispatch, roleRef, validQqDispatchRequest } from '../plugins/surfcore/lib/role-dispatch.js';
import { createQqRoleDispatch } from '../src/qq-role-dispatch.js';

const character = { id: 'char-fish', epoch: 1 };
const role = roleRef(character);
const empty = { active: true, running: false, queue: [], pendingInput: [] };
const prompt = (sessionId) => ({ sessionId, content: [{ type: 'text', text: 'fixture' }] });

function fixture(t, { load, recovery = [], overrides } = {}) {
  let time = Date.now();
  let currentRole = role;
  let journal = null;
  const calls = [];
  const states = new Map();
  const controller = {
    async prompt({ sessionId, requestId, mode }) {
      assert.equal(mode, 'queue');
      assert.equal(journal.id, requestId, '持久化必须早于 prompt');
      assert.equal(journal.sessionId, sessionId);
      assert.equal(states.size, 0, '不同工作区不能并发');
      calls.push(sessionId);
      states.set(sessionId, { ...empty, running: true });
      return { accepted: true };
    },
    async state({ sessionId }) { return states.get(sessionId) ?? empty; },
    async wait({ sessionId }) {
      const state = states.get(sessionId) ?? empty;
      return { reason: state.running ? 'timeout' : 'idle', state };
    },
    async cancel({ sessionId }) { calls.push(`cancel:${sessionId}`); },
    async updateQueue({ sessionId, itemId }) {
      calls.push(`remove:${itemId}`);
      const state = states.get(sessionId);
      states.set(sessionId, { ...state, queue: state.queue.filter((item) => item.id !== itemId) });
    },
  };
  Object.assign(controller, overrides);
  const dispatch = createRoleDispatch({
    controller, getRole: () => currentRole, load: load ?? (() => journal),
    save: (record) => {
      if (record) assert.equal(Object.hasOwn(record, 'content'), false);
      journal = record;
    },
    startupSessions: async () => recovery, pollMs: 5, now: () => time,
  });
  dispatch.start();
  t.after(() => dispatch.dispose());
  return {
    dispatch, states, calls, controller,
    enqueue: (source, priority = 'scheduled', deadline) => dispatch.enqueue({ id: source, source, role, priority, deadline },
      (submit) => submit(prompt(source))),
    finish(sessionId) { states.delete(sessionId); dispatch.onTurnEnd(sessionId); },
    advance: (ms) => { time += ms; },
    switchRole: () => { currentRole = roleRef({ ...character, epoch: 2 }); },
  };
}

async function until(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('等待调度状态超时');
}

test('手动任务优先，接受回执和旧 turn/end 均不能放行其它平台', async (t) => {
  const h = fixture(t);
  await h.enqueue('bili');
  const diary = h.enqueue('diary');
  const qq = h.enqueue('qq', 'manual');
  h.dispatch.onTurnEnd('bili');
  await delay(25);
  assert.deepEqual(h.calls, ['bili']);
  assert.equal(h.dispatch.status().waitingCount, 2);
  h.finish('bili');
  await qq;
  assert.deepEqual(h.calls, ['bili', 'qq']);
  h.finish('qq');
  await diary;
  assert.deepEqual(h.calls, ['bili', 'qq', 'diary']);
});

test('准备中的回合和已在 DSH inbox 的回合均保留名额', async (t) => {
  const h = fixture(t);
  const id = randomUUID();
  assert.equal((await h.dispatch.qq({ action: 'reserve', id, role, priority: 'manual' })).state, 'queued');
  await until(() => h.dispatch.status().active?.source === 'qq');
  const diary = h.enqueue('diary');
  await delay(20);
  assert.deepEqual(h.calls, []);
  assert.equal((await h.dispatch.qq({ action: 'submit', id, role, prompt: prompt('qq') })).result.result.value.accepted, true);
  h.states.set('qq', { ...empty, queue: [{ id: 'pending', rpcId: id }] });
  await delay(20);
  assert.deepEqual(h.calls, ['qq']);
  await h.dispatch.stopTurn(id);
  assert.deepEqual(h.calls, ['qq', 'remove:pending', 'cancel:qq']);
  h.finish('qq');
  await diary;
});

test('提交回执丢失时等待 DSH，读取失败期间禁止新回合', async (t) => {
  const h = fixture(t);
  const send = h.controller.prompt;
  h.controller.prompt = async (args) => {
    await send(args);
    if (args.sessionId === 'bili') throw new Error('连接中断');
    return { accepted: true };
  };
  await assert.rejects(h.enqueue('bili'), /连接中断/);
  const read = h.controller.wait;
  h.controller.wait = async () => { throw new Error('连接未恢复'); };
  const qq = h.enqueue('qq');
  await until(() => h.dispatch.status().lastError?.code === 'ROLE_DISPATCH_CHECK_FAILED');
  assert.deepEqual(h.calls, ['bili']);
  h.controller.wait = read;
  h.finish('bili');
  await qq;
  assert.deepEqual(h.calls, ['bili', 'qq']);
});

test('重启先核对持久化名额和启动前已入队的旧会话', async (t) => {
  const saved = { id: 'old-bili', sessionId: 'old-bili', source: 'bili', role, startedAt: Date.now() };
  const h = fixture(t, { load: () => saved, recovery: ['old-qq'] });
  h.states.set('old-bili', { ...empty, running: true });
  h.states.set('old-qq', { ...empty, queue: [{ id: 'inbox' }] });
  const diary = h.enqueue('diary');
  await delay(20);
  assert.deepEqual(h.calls, []);
  h.finish('old-bili');
  await delay(20);
  assert.deepEqual(h.calls, []);
  h.finish('old-qq');
  await diary;
  assert.deepEqual(h.calls, ['diary']);
});

test('定时任务等待后提升优先级，切角色和任务到期均使待办失效', async (t) => {
  const h = fixture(t);
  await h.enqueue('bili');
  const diary = h.enqueue('diary');
  h.advance(125_000);
  const qq = h.enqueue('qq', 'manual');
  h.finish('bili');
  await diary;
  assert.deepEqual(h.calls, ['bili', 'diary']);
  h.switchRole();
  await assert.rejects(qq, { code: 'ROLE_DISPATCH_ROLE_CHANGED' });
  const old = { ...role, epoch: 2 };
  const expires = h.dispatch.enqueue({ id: 'deadline', source: 'bili', role: old, priority: 'scheduled', deadline: Date.now() + 130_000 },
    () => assert.fail('过期任务不能运行'));
  h.advance(10_000);
  await assert.rejects(expires, (error) => error.code === 'ROLE_DISPATCH_EXPIRED' && Boolean(error.hint));
});

test('桥接只在获得名额后构建 QQ 快照，插件不可用时不走旁路', async (t) => {
  const h = fixture(t);
  await h.enqueue('bili');
  const requests = [];
  let unavailable = true;
  const withDispatch = createQqRoleDispatch({
    api: {
      sessions: { prompt() { assert.fail('桥接不能直接发 prompt'); } },
      async doFetch(url, init) {
        const body = JSON.parse(init.body);
        requests.push(body);
        assert.equal(url.hostname, '127.0.0.1');
        assert.equal(init.headers['x-console-token'], 'fixture-console-token');
        assert.equal(validQqDispatchRequest(body), true);
        if (unavailable) {
          unavailable = false;
          throw new Error('插件重载中');
        }
        const reply = await h.dispatch.qq(body);
        if (body.action === 'submit') throw new Error('回执丢失');
        return Response.json({ ok: true, ...reply });
      },
    },
    getBaseUrl: () => 'http://127.0.0.1:19300', getToken: () => 'fixture-console-token',
    getCharacter: () => character, enabled: true,
  });
  const unread = ['第一条'];
  const handle = withDispatch({ id: randomUUID(), priority: 'manual' }, (submit) =>
    submit({ sessionId: 'qq', content: [{ type: 'text', text: unread.join(' ') }] }));
  await until(() => requests.length === 1);
  assert.deepEqual(h.calls, ['bili']);
  assert.equal(h.dispatch.status().waitingCount, 0);
  await delay(1550);
  assert.deepEqual(requests.map((request) => request.action), ['reserve', 'reserve']);
  assert.equal(h.dispatch.status().waitingCount, 1);
  unread.push('第二条');
  h.finish('bili');
  assert.equal((await handle).result.value.accepted, true);
  assert.deepEqual(requests.map((request) => request.action), ['reserve', 'reserve', 'reserve', 'submit', 'receipt']);
  assert.equal(requests.find((request) => request.action === 'submit').prompt.content[0].text, '第一条 第二条');
  assert.deepEqual(h.calls, ['bili', 'qq']);
});
