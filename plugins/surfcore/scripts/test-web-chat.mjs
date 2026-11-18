import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWebChatGateway } from '../lib/web-chat/gateway.js';
import { openWebChatStore } from '../lib/web-chat/store.js';
import { webSessionId } from '../lib/web-chat/dsh.js';
import { createRoleDispatch } from '../lib/role-dispatch.js';
import { WEB_CHAT_API } from '../lib/web-chat/port.js';


import { createEmptyCard, ingestInboxLines, renderMemoryCard } from '../../../src/memory-card.js';
import { recordsFromInboxLines, rankVectorMemories } from '../../../src/vector-memory.js';

const origin = 'http://127.0.0.1:17632';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-web-chat-'));
const role = { characterId: 'fish', epoch: 1 };
const sessionId = webSessionId(role.characterId);
const identity = () => ({ role, name: '鱼姬' });
const prefs = { cwd: path.join(dir, 'workspace'), proactive: false, purpose: { enabled: true }, batchMs: 0 };
const handlers = new Map();
const logs = [];
const captures = [];
const sessions = new Map();
const messages = [];
const host = {
  on(name, handler) {
    const listeners = handlers.get(name) ?? new Set();
    listeners.add(handler);
    handlers.set(name, listeners);
    return () => listeners.delete(handler);
  },
  created: [],
  get(name) {
    if (name === 'agentPresets') return { list: async () => ({ presets: [{ id: 'standard' }, { id: 'web-chat' }] }) };
    return undefined;
  },
  sessionController: {
    async create(params) {
      assert.equal(params.cwd, prefs.cwd);
      host.created.push(params);
      sessions.set(params.sessionId, []);
    },
    async events({ address }) {
      const events = sessions.get(address.sessionId);
      if (!events) throw Object.assign(new Error('missing'), { code: 'session/not-found' });
      return { cursor: events.length - 1, records: events.map((event) => ({ type: 'event', event })), hasMore: false };
    },
    async prompt(input) {
      captures.push(input);
      return { accepted: true };
    },
    async state() { return { running: false, pendingInput: [], queue: [], active: false }; },
    async wait() { return { reason: 'idle', state: await this.state() }; },
  },
};
function event(type, data, push = true) {
  const list = sessions.get(sessionId);
  const value = { seq: list.length, type, data };
  list.push(value);
  if (push) for (const handle of handlers.get('session/event') ?? []) handle({ id: sessionId }, value);
}
function admit(id, turn, push = true) {
  event('turn/start', { turn }, push);
  event('user/message', { source: { kind: 'user', rpcId: id } }, push);
}
function reply(turn, text, push = true) {
  event('assistant/message', { turn, message: { content: [{ type: 'text', text }] } }, push);
  event('turn/end', { turn, reason: { kind: 'completed' } }, push);
}
async function until(predicate) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail('没有等到预期中的事件');
}

let listener;
function createServer(handler) {
  listener = handler;
  const fake = new EventEmitter();
  return Object.assign(fake, {
    listen(port, address, callback) { assert.equal(address, '127.0.0.1'); this.listening = true; callback(); },
    address: () => ({ port: 17632 }),
    close() { this.listening = false; },
  });
}
function call(route, { method = 'GET', data, headers = {}, stream = false } = {}) {
  const chunks = data === undefined ? [] : [Buffer.from(JSON.stringify(data))];
  const req = Readable.from(chunks);
  Object.assign(req, { url: route.startsWith('/asset:') ? route.slice('/asset:'.length) : WEB_CHAT_API + route, method,
    headers: { host: '127.0.0.1:17632', ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}), ...headers } });
  return new Promise((resolve) => {
    const res = new EventEmitter();
    Object.assign(res, {
      headers: {}, output: '', status: 0, writableLength: 0, destroyed: false,
      setHeader(name, value) { this.headers[name] = value; },
      writeHead(status, values) {
        this.status = status;
        this.headersSent = true;
        Object.assign(this.headers, values);
        if (stream) resolve(this);
      },
      write(value) { this.output += value; return true; },
      end(value) {
        this.data = Buffer.from(value ?? '');
        try { this.json = JSON.parse(this.data); } catch {}
        resolve(this);
      },
      destroy() { this.destroyed = true; this.emit('close'); },
    });
    listener(req, res);
  });
}

let savedDispatch = null;
const dispatch = createRoleDispatch({
  getRole: () => role, controller: host.sessionController, save: (row) => { savedDispatch = row; },
  load: () => savedDispatch, pollMs: 10,
});
dispatch.start();
let purposeState = {};
const gateway = createWebChatGateway({
  directory: dir, ctx: host, dispatch, identity, config: () => prefs, context: () => [],
  budget: { block: async () => null }, createServer, log: (...args) => logs.push(args),
  onMessage: (message) => messages.push(message),
  readPurposeInputs: () => ({ ownerName: '主人', persona: '对身边的事很好奇。', ownerUin: '0',
    memoryRecords: [{ id: 'm1', source: 'manual', text: '昨天写了一篇关于鱼和水的日记，期待给主人分享。', createdAt: Date.now() }] }),
  readPurposeState: () => purposeState, writePurposeState: (state) => { purposeState = JSON.parse(JSON.stringify(state)); },
  focus: () => false, mood: () => null,
});
try {
  await gateway.start();
  assert.equal((await call('/asset:/')).status, 200);
  assert.equal((await call('/state')).json.code, 'WEB_PAIR_REQUIRED');
  assert.equal((await call('/state', { headers: { host: 'wrong.example' } })).status, 403);
  const code = new URL(gateway.pair()).hash.slice('#pair='.length);
  const pair = await call('/pair', { method: 'POST', data: { code } });
  assert.equal(pair.status, 200);
  const cookie = pair.headers['Set-Cookie'].split(';')[0];
  const headers = { cookie };
  assert.equal((await call('/pair', { method: 'POST', data: { code } })).status, 401);
  assert.equal((await call('/messages', { method: 'POST', data: {}, headers: { cookie, origin: 'http://bad.example' } })).status, 403);

  const bad = await call('/messages', { method: 'POST', data: { chat: role.characterId, id: randomUUID(), images: ['bad'] }, headers });
  assert.equal(bad.json.code, 'WEB_IMAGE_INVALID');
  assert.ok(bad.json.hint);

  const id = randomUUID();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVKcAAAAASUVORK5CYII=';
  const data = { chat: role.characterId, id, text: '你好', images: [png] };
  const first = await call('/messages', { method: 'POST', data, headers });
  assert.equal(first.status, 202, logs.map((log) => log[1]?.stack).join('\n'));
  assert.equal((await call('/messages', { method: 'POST', data, headers })).status, 200);
  assert.equal((await call('/messages', { method: 'POST', data: { ...data, text: 'conflict' }, headers })).status, 409);
  assert.equal((await call('/attachment/' + first.json.message.attachments[0].id, { headers })).data.toString('base64'), png);

  const secondId = randomUUID();
  assert.equal((await call('/messages', { method: 'POST', data: { chat: role.characterId, id: secondId, text: '还想问一句', quoteId: first.json.message.id }, headers })).status, 202);
  await until(() => captures.length === 1);
  assert.equal(captures[0].requestId, id);
  assert.equal(host.created[0]?.agentPreset, 'web-chat', '网页会话要用 web-chat preset');
  assert.ok(captures[0].content.some((part) => part.type === 'image' && part.mediaType === 'image/png'));
  admit(id, 1);
  const agent = { session: { id: sessionId } };
  const eventStream = await call('/events?chat=fish&after=0', { headers, stream: true });
  for (const handle of handlers.get('agent/assistant-stream')) {
    handle({ agent, frame: { type: 'start', attemptId: 'a1', turn: 1 } });
    handle({ agent, frame: { type: 'chunk', attemptId: 'a1', turn: 1, chunk: { type: 'reasoning-delta', text: 'private' } } });
    handle({ agent, frame: { type: 'chunk', attemptId: 'a1', turn: 1, chunk: { type: 'text-delta', text: '你' } } });
  }
  // 网页私聊和 QQ 一样：文字输出只是思考，不往页面推草稿。
  await until(() => eventStream.output.includes('"phase":"running"'));
  assert.ok(!eventStream.output.includes('"draft":"你"'));
  assert.ok(!eventStream.output.includes('private'));
  assert.equal(captures.length, 1);

  const approval = [...handlers.get('approval/request')][0]({ agent, toolName: 'safe-tool' }, () => assert.fail('需要由网页处理'));
  const state = (await call('/state', { headers })).json;
  assert.equal(state.run.phase, 'approval');
  const approvalId = state.run.requests[0].id;
  assert.equal((await call('/answer', { method: 'POST', data: { id: approvalId, allow: true }, headers })).status, 200);
  assert.equal(await approval, 'allowed-once');
  assert.equal((await call('/answer', { method: 'POST', data: { id: approvalId, allow: true }, headers })).json.code, 'WEB_REQUEST_EXPIRED');

  const question = [...handlers.get('user-questions/request')][0]({ agent, questions: [
    { id: 'q1', question: '选什么？', options: [{ label: '颜色' }, { label: '时间' }] },
  ] }, () => assert.fail('需要由网页处理'));
  const questionId = (await call('/state', { headers })).json.run.requests[0].id;
  const wrong = await call('/answer', { method: 'POST', data: { id: questionId, answers: [{ id: 'q1', selected: ['不存在'] }] }, headers });
  assert.equal(wrong.json.code, 'WEB_ANSWER_INVALID');
  assert.ok(wrong.json.hint);
  await call('/answer', { method: 'POST', data: { id: questionId, answers: [{ id: 'q1', selected: ['颜色'] }] }, headers });
  assert.deepEqual(await question, { answers: [{ id: 'q1', selected: ['颜色'], custom: '' }] });

  fs.writeFileSync(path.join(prefs.cwd, 'picture.png'), Buffer.from(png, 'base64'));
  gateway.sendImage({ file: 'picture.png' }, { agent, callId: 'call1' });
  gateway.sendImage({ file: 'picture.png' }, { agent, callId: 'call1' });
  assert.throws(() => gateway.sendImage({ file: '../chat.sqlite' }, { agent, callId: 'call2' }), { code: 'WEB_IMAGE_FILE' });
  // 发言走 web_chat_send_message：一次两条，逐条落库；整轮有发言时兜底文字不再追加。
  const sent = await gateway.sendMessages({ messages: ['你好，我在。', '刚在看水'], gaps: [0, 0] }, { agent });
  assert.equal(sent.count, 2);
  reply(1, '这段文字只是思考，不该显示。');
  const turnOne = (await call('/state', { headers })).json.messages.filter((item) => item.author === 'assistant');
  assert.equal(turnOne.length, 3);
  assert.deepEqual(turnOne.slice(1).map((item) => item.text), ['你好，我在。', '刚在看水']);
  eventStream.destroy();
  await until(() => captures.length === 2);
  assert.equal(captures[1].requestId, secondId);
  // 引用：快照里带着被引用的原话。
  assert.match(captures[1].content.find((part) => part.type === 'text').text, /"quote":\{[^}]*"你好"/);
  admit(secondId, 2, false);
  reply(2, '重开后能读到。', false);
  gateway.stop();

  // Host events that completed while the gateway was not active are recovered from DSH.
  await gateway.start();
  const restarted = (await call('/state', { headers })).json;
  assert.ok(restarted.messages.some((item) => item.text === '你好，我在。'));
  await until(() => messages.some((item) => item.text === '重开后能读到。'));
  assert.equal(captures.length, 2);

  // Proactive delivery uses the same real dispatch adapter with zero browser subscribers.
  prefs.proactive = true;
  const proactive = gateway.purposeTry({ force: true });
  assert.equal(proactive.ok, true, JSON.stringify(proactive));
  await until(() => captures.length === 3);
  admit(captures[2].requestId, 3);
  reply(3, '有一件事想跟你聊。');
  const fromBili = fs.readFileSync(path.join(dir, 'notify-token'), 'utf8');
  const notice = await call('/owner-notice', { method: 'POST', data: { role: 'fish', id: randomUUID(), text: 'B 站通知' },
    headers: { origin: undefined, authorization: 'Bearer ' + fromBili } });
  assert.equal(notice.status, 201);
  const recovered = (await call('/state', { headers })).json;
  assert.ok(recovered.messages.some((item) => item.text === '有一件事想跟你聊。'));
  assert.ok(recovered.messages.some((item) => item.author === 'notice' && item.text === 'B 站通知'));

  // 连发合并：窗口内的两条消息并成一轮，模型一次看到两句。
  prefs.batchMs = 120;
  const batch1 = randomUUID();
  const batch2 = randomUUID();
  assert.equal((await call('/messages', { method: 'POST', data: { chat: role.characterId, id: batch1, text: '第一句' }, headers })).status, 202);
  assert.equal((await call('/messages', { method: 'POST', data: { chat: role.characterId, id: batch2, text: '第二句' }, headers })).status, 202);
  await until(() => captures.length === 4);
  const mergedText = captures[3].content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  assert.match(mergedText, /第一句/);
  assert.match(mergedText, /第二句/);
  admit(captures[3].requestId, 4);
  reply(4, '一起回。');
  await until(() => messages.some((item) => item.text === '一起回。'));

  // 等待：轮内等主人补发的消息，补发的那条不再单独开一轮。
  const wait1 = randomUUID();
  assert.equal((await call('/messages', { method: 'POST', data: { chat: role.characterId, id: wait1, text: '等一下' }, headers })).status, 202);
  await until(() => captures.length === 5);
  admit(captures[4].requestId, 5);
  const waiting = gateway.waitMessages({ timeoutMs: 1500, quietMs: 50 }, { agent });
  await delay(30);
  const wait2 = randomUUID();
  assert.equal((await call('/messages', { method: 'POST', data: { chat: role.characterId, id: wait2, text: '补一句' }, headers })).status, 202);
  const waited = await waiting;
  assert.equal(waited.timeout, false);
  assert.ok(waited.messages.some((item) => item.text === '补一句'));
  reply(5, '等到了。');
  await delay(200);
  assert.equal(captures.length, 5, '等待期间收到的消息不应再开一轮');

  // 潜水/晚点回来：这轮不回，到点主动回来一轮。
  const diveMsg = randomUUID();
  assert.equal((await call('/messages', { method: 'POST', data: { chat: role.characterId, id: diveMsg, text: '我先去忙' }, headers })).status, 202);
  await until(() => captures.length === 6);
  admit(captures[5].requestId, 6);
  gateway.dive({ minutes: 0.006, summary: '他去忙了' }, { agent });
  reply(6, '');
  await until(() => captures.length === 7);
  assert.match(captures[6].content.find((part) => part.type === 'text').text, /晚点回来/);
  admit(captures[6].requestId, 7);
  reply(7, '忙完了？');
  await until(() => messages.some((item) => item.text === '忙完了？'));
  assert.deepEqual(logs, []);
} finally {
  gateway.stop();
  dispatch.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}
// 收尾/已读：她只调 web_chat_close、一条没发时，lastTurn 记 replied=false，页面显示“已读”。
{
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-store-'));
  const s = openWebChatStore(storeDir);
  s.enqueue('c', 't1', { text: 'hi' });
  s.finalize('t1', { closed: true, replied: false });
  assert.equal(s.lastTurn('c').replied, false);
  assert.equal(s.lastTurn('c').closed, true);
  s.close();
  fs.rmSync(storeDir, { recursive: true, force: true });
}

const at = Date.now();
const inbox = [
  { platform: 'web', text: '网页私密回忆测试', isOwner: true, private: true, at, eventId: 'm-web' },
  { platform: 'qq', text: '主人的旧 QQ 私聊回忆测试', isOwner: true, private: true, conversationKey: 'private:111', at },
  { platform: 'qq', text: '旁人的独立私聊回忆测试', private: true, direct: true, conversationKey: 'private:222', at },
].map((item) => JSON.stringify(item));
const card = createEmptyCard(at);
ingestInboxLines(card, inbox, {}, at);
const narrative = renderMemoryCard(card, { platform: 'web', runtimeSharing: { ownerPrivateKey: 'private:111' }, now: at });
assert.match(narrative, /网页私密回忆测试/);
assert.match(narrative, /旧 QQ 私聊回忆测试/);
assert.doesNotMatch(narrative, /旁人的独立私聊回忆测试/);
for (const platform of ['bili', 'qq']) assert.doesNotMatch(renderMemoryCard(card, { platform, now: at, config: { includeQqInBili: true } }), /网页私密回忆测试/);
const [webVector] = recordsFromInboxLines(inbox);
assert.equal(webVector.scope, 'web');
const index = { manifest: { dimension: 1, entries: [{ ...webVector, offset: 0 }] }, vectors: new Float32Array([1]) };
assert.equal(rankVectorMemories({ platform: 'bili', queryVector: [1], index }).length, 0);
assert.equal(rankVectorMemories({ platform: 'qq', queryVector: [1], index }).length, 0);
assert.equal(rankVectorMemories({ platform: 'web', queryVector: [1], index }).length, 1);
console.log('✓ Web gateway pairing, real dispatcher contract, SSE, image, approvals, restart and unattended delivery');
