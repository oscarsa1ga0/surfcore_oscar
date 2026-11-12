// 出站 outbox：连接失败暂存、上线补发、去重、策略失败不入队。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOutbox } from '../src/outbox.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-outbox-'));
const file = path.join(dir, 'outbox.json');
try {
  let fail = true;
  const sent = [];
  const outbox = createOutbox({
    file,
    send: async (entry) => {
      if (fail) throw new Error('fetch failed');
      sent.push(entry.text);
    },
    isConnectionError: (error) => /fetch failed/.test(String(error?.message ?? error)),
    now: () => Date.now(),
  });

  assert.equal(outbox.push('private', '123', 'hello'), true);
  assert.equal(outbox.push('private', '123', 'hello'), false, '同文本 10 分钟内去重');
  const first = await outbox.flush('test');
  assert.equal(first.sent, 0);
  assert.equal(first.left, 1);
  fail = false;
  const second = await outbox.flush('test');
  assert.equal(second.sent, 1);
  assert.equal(second.left, 0);
  assert.deepEqual(sent, ['hello']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);

  outbox.push('group', '456', 'will-be-deduped');
  outbox.markSent('group', '456', 'will-be-deduped');
  assert.equal(outbox.stats().count, 0, '正常发送成功要清掉同文本待补发项');

  const policy = createOutbox({
    file,
    send: async () => { throw new Error('sensitive content blocked'); },
    isConnectionError: () => false,
  });
  policy.push('private', '789', 'policy');
  const p = await policy.flush('test');
  assert.equal(p.left, 0, '策略失败不能留在队列里反复撞');
  const observed = [];
  const concurrent = createOutbox({
    file,
    send: async (entry) => {
      observed.push(entry.text);
      concurrent.markSent(entry.kind, entry.id, entry.text);
      if (entry.text === 'first') concurrent.push('private', '123', 'newly queued');
    },
  });
  concurrent.push('private', '123', 'first');
  concurrent.push('private', '123', 'second');
  assert.equal((await concurrent.flush()).sent, 2);
  assert.deepEqual(observed, ['first', 'second']);
  assert.equal(concurrent.stats().count, 1, 'flush 期间入队的新回复保留');
  const bridge = fs.readFileSync('src/bridge.js', 'utf8');
  assert.ok(bridge.includes('probeOneBotSendable') && bridge.includes("reason: 'QQ 暂不可发送'"),
    '早安必须先探活，不能只凭 deliverPrompt 成功就记已发');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// 驱动真实桥接的发送和补发入口，网关只用夹具。
let clock = Date.now();
class TestDate extends Date {
  static now() { return clock; }
}
const original = { message_id: 101, time: Math.floor(clock / 1000) };
let history = [original];
let failure = '';
let nextId = 200;
let onHistory;
const delivered = [];
const h = await bridgeHarness({
  globals: {
    Date: TestDate,
    createOutbox: (options) => createOutbox({ ...options, now: () => clock }),
    fetch: async (url, init) => {
      if (String(url).endsWith('/get_friend_msg_history')) {
        onHistory?.();
        return Response.json(history
          ? { status: 'ok', retcode: 0, data: { messages: history } }
          : { status: 'failed', retcode: 1 });
      }
      assert.ok(String(url).endsWith('/send_private_msg'));
      if (failure) throw new TypeError('fetch failed', { cause: { code: failure } });
      const text = JSON.parse(init.body).message.at(-1).data.text;
      const message_id = nextId++;
      delivered.push(text);
      history = [{ message_id, time: Math.floor(clock / 1000) }, ...(history ?? [])];
      return Response.json({ status: 'ok', retcode: 0, data: { message_id } });
    },
  },
});
try {
  const key = 'private:123';
  h.setReplyOutboxAccount('99');
  h.setSnowlumaHealth({ connected: true, accountOnline: true });
  h.appendSocialV2Message(key, 'owner', 'hello', 'hello', false, true, original.message_id, [], '123', []);
  async function failSend(messages, code = 'ECONNREFUSED') {
    failure = code;
    await assert.rejects(h.sendMessagesV2(key, messages, []), /QQ 发送失败/);
    failure = '';
  }

  await failSend(['first line', 'second line']);
  assert.equal((await h.flushReplyOutbox('test')).sent, 2, '同一批回复的补发回执不误判为新话题');
  assert.deepEqual(delivered, ['first line', 'second line']);

  clock += 1000;
  await failSend(['expired']);
  clock += 60_001;
  assert.equal((await h.flushReplyOutbox('test')).sent, 0);

  await failSend(['advanced locally']);
  h.appendSocialV2Message(key, 'owner', 'new', 'new', false, true, 102, [], '123', []);
  assert.equal((await h.flushReplyOutbox('test')).sent, 0);

  await failSend(['advanced while offline']);
  history = [{ message_id: 103, time: Math.floor(clock / 1000) }];
  assert.equal((await h.flushReplyOutbox('test')).sent, 0);

  await failSend(['history unavailable']);
  history = null;
  assert.equal((await h.flushReplyOutbox('test')).sent, 0);

  await failSend(['unknown delivery'], 'ECONNRESET');
  assert.equal(h.outbox.stats().count, 0);

  await failSend(['expires during history lookup']);
  history = [original];
  onHistory = () => { clock += 60_001; };
  assert.equal((await h.flushReplyOutbox('test')).sent, 0);
  onHistory = null;

  h.outbox.push('private', '123', 'legacy entry');
  assert.equal((await h.flushReplyOutbox('test')).sent, 0);
  assert.deepEqual(delivered, ['first line', 'second line']);
} finally {
  await h.close();
}
console.log('✅ 出站 outbox 测试通过');
