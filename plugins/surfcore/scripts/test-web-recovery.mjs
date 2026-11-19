import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createWebDsh, webSessionId } from '../lib/web-chat/dsh.js';
import { openWebChatStore } from '../lib/web-chat/store.js';
import { createRoleStateFiles } from '../lib/web-chat/role-state.js';
import { closureAssessment, webStatusLine } from '../lib/web-chat/prompt.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-recovery-fixture-'));
const store = openWebChatStore(dir);
const role = { characterId: 'fish', epoch: 1 };
const chat = role.characterId;
const session = webSessionId(chat);
const clock = Date.now;
let offset = 0;
let seq = 0;
let start;
let event;
let readFails = false;
let idle = false;
let submits = 0;
const dsh = createWebDsh({
  ctx: {
    on(name, handler) { if (name === 'session/event') event = handler; return () => {}; },
    sessionController: {
      async events() {
        if (readFails) throw Object.assign(new Error('history unavailable'), { code: 'SESSION_QUERY_CORRUPT_SESSION' });
        return { cursor: seq, records: [] };
      },
      async state() { return { running: !idle, pendingInput: [], queue: [], active: !idle }; },
    },
  },
  store, identity: () => ({ role }), config: () => ({ proactive: true }), context: () => [],
  dispatch: {
    enqueue(_job, run) {
      return new Promise((resolve, reject) => {
        start = () => run(async () => { submits++; return { accepted: true }; }).then(resolve, reject);
      });
    },
  },
  onMessage() {}, onChange() {}, log() {},
});
const execution = { agent: { session: { id: session } }, callId: 'reply-fixture' };
const emit = (type, data) => event({ id: session }, { type, data, seq: ++seq });
function admit(id, turn) {
  emit('turn/start', { turn });
  emit('user/message', { turn, source: { rpcId: id } });
}
try {
  Date.now = () => clock() + offset;
  const proactive = randomUUID();
  store.enqueue(chat, proactive, { kind: 'purpose', purpose: { prompt: 'fixture' } });
  await dsh.tick();
  const preparing = randomUUID();
  store.enqueue(chat, preparing, { text: '刚才补发' });
  offset += 12_000;
  await start();
  admit(proactive, 1);
  const backlog = await dsh.waitMessages({ purpose: 'reply', timeoutMs: 1000 }, execution);
  assert.equal(backlog.newMessages.at(-1)?.id, preparing);
  assert.equal(store.turn(preparing).primaryId, proactive);
  await dsh.sendMessages({ messages: ['我看到了'] }, execution);
  emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(store.turn(preparing).state, 'done');

  const root = randomUUID(), skipped = randomUUID(), reported = randomUUID();
  store.enqueue(chat, root, { text: '发起新一轮' });
  await dsh.tick(); await start();
  admit(root, 2);
  store.enqueue(chat, skipped, { text: '没在本页返回' });
  store.enqueue(chat, reported, { text: '已在本页返回' });
  await dsh.getContextSnapshot({ afterSeq: store.message(skipped).seq, limit: 1 }, execution);
  assert.equal(store.turn(reported).primaryId, root);
  assert.equal(store.turn(skipped).state, 'queued');
  const waiting = dsh.waitMessages({ timeoutMs: 1000 }, execution);
  await assert.rejects(dsh.waitMessages({ timeoutMs: 1000 }, execution), (error) => error.code === 'WEB_WAIT_BUSY' && Boolean(error.hint));
  assert.equal((await waiting).newMessages.at(-1)?.id, skipped, '翻阅一段历史不能跨过没读到的补发');
  assert.equal((await dsh.waitMessages({ timeoutMs: 1000 }, execution)).timeout, true);
  assert.equal((await dsh.waitMessages({ timeoutMs: 1000 }, execution)).reason, 'consecutive-wait-limit');
  offset += 121_000;
  assert.equal((await dsh.waitMessages({ timeoutMs: 300_000 }, execution)).reason, 'round-wait-budget');

  const successor = randomUUID();
  store.enqueue(chat, successor, { text: '回读失败时收到' });
  readFails = true;
  await dsh.tick();
  assert.equal(dsh.status(chat).recovery.code, 'WEB_DSH_RECOVERY');
  assert.ok(dsh.status(chat).recovery.hint);
  assert.equal(store.turn(successor).state, 'queued');
  idle = true;
  offset += 6000;
  await dsh.tick();
  assert.equal(store.turn(root).state, 'failed');
  assert.equal(store.turn(root).retryable, false);
  assert.equal(store.turn(reported).state, 'failed');
  assert.equal(submits, 2, '无法确认的旧回合不能被自动重投');

  const messages = [
    { author: 'user', text: '晚安', at: clock() - 1000 },
    { author: 'user', text: '', attachments: [{ type: 'image/png' }], at: clock() - 500 },
  ];
  assert.match(webStatusLine({ messages }), /未读 2 条.*\[图片\]/);
  assert.doesNotMatch(closureAssessment(messages), /可以自然收尾/);

  fs.writeFileSync(path.join(dir, 'memory.json'), '{"activeTopics":["old role"]}');
  const first = createRoleStateFiles(dir, 'fish', () => {});
  assert.match(fs.readFileSync(first('fish', 'memory.json'), 'utf8'), /old role/);
  const reopened = createRoleStateFiles(dir, 'other', () => {});
  assert.equal(fs.existsSync(reopened('other', 'memory.json')), false);
  assert.notEqual(reopened('other', 'memory.json'), first('fish', 'memory.json'));
  console.log('✓ web wait lease/budget, proactive race, exact snapshot adoption, recovery and role-scoped memory');
} finally {
  Date.now = clock;
  dsh.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
