import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createBiliMemory } from '../../../src/bili-memory.js';
import { addMemoryRecord, createEmptyCard, maintainMemoryCard, resolveMemoryCardPaths } from '../../../src/memory-card.js';
import { localDay } from '../../../src/diary-store.js';
import { buildDailyDigest } from '../lib/diary-scheduler.js';
import { publicWebHandoff, readWebDiaryHistory, readWebHandoff } from '../lib/web-chat/journal.js';
import { openWebChatStore } from '../lib/web-chat/store.js';

test('日记读取已停止的网页库，保留本角色语音和 B 站当天经历', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-memory-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openWebChatStore(dir);
  const now = Date.now();
  const day = localDay(now);
  store.enqueue('fish', 'web-one', { text: '刚聊到海里的水母。' });
  store.enqueue('other', 'web-two', { text: '另一个角色的内容。' });
  store.enqueue('fish', 'web-audio', { files: [{ type: 'audio/wav', bytes: Buffer.from([1]) }] });
  assert.equal(store.rememberTranscript('other', 'web-audio', '跨角色转写'), false);
  assert.equal(store.rememberTranscript('fish', 'web-audio', '语音里聊到了深海鱼。'), true);
  assert.equal(store.rememberTranscript('fish', 'web-audio', '重复转写'), false);
  store.notice('fish', 'internal', '内部通知');
  store.close();
  fs.mkdirSync(path.join(dir, 'bili'));
  fs.writeFileSync(path.join(dir, 'bili', 'whale-log.jsonl'), JSON.stringify({ at: new Date(now).toISOString(), kind: 'watch', note: '在 B 站看了珊瑚礁' }));
  const history = readWebDiaryHistory(dir, 'fish', day);
  assert.equal(history.length, 2);
  const review = buildDailyDigest({ characterDir: dir, day, webHistory: history, now }).text;
  assert.match(review, /鱼姬之家.*主人私聊/);
  assert.match(review, /海里的水母/);
  assert.match(review, /语音里聊到了深海鱼/);
  assert.match(review, /在 B 站看了珊瑚礁/);
  assert.doesNotMatch(review, /另一个角色|重复转写|内部通知/);
  assert.deepEqual(readWebDiaryHistory(dir, 'fish', '2000-01-01'), []);
});

test('B 站接续只读本角色新的公开摘要，私事收尾后清掉前次摘要', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-handoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openWebChatStore(dir);
  const now = Date.now();
  const safe = publicWebHandoff('最近在考虑写一篇关于珊瑚礁的专栏。', { now });
  assert.equal(publicWebHandoff('主人的号码是123456789。'), null);
  assert.equal(publicWebHandoff('小甲想看珊瑚礁。', { identities: ['小甲'] }), null);
  assert.equal(publicWebHandoff('引用自非公开日记。', { isPrivateDiary: () => true }), null);
  store.enqueue('fish', 't1', { text: '这句原始聊天只留在网页。' });
  store.update('t1', 'submitted', { closed: true, webCloseAt: now, webHandoff: safe });
  assert.deepEqual(readWebHandoff(dir, 'fish', now), safe);
  assert.equal(readWebHandoff(dir, 'other', now), null);
  assert.equal(readWebHandoff(dir, 'fish', now + 8 * 86400000), null);
  store.enqueue('fish', 't2', { text: '不公开的私事。' });
  store.update('t2', 'submitted', { closed: true, webCloseAt: now + 1, webHandoff: null });
  assert.equal(readWebHandoff(dir, 'fish', now + 1), null);
  store.close();
});

test('保护记忆填满后仍保留 B 站经历，旧索引补回一次并尊重手动忘记', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reserve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = resolveMemoryCardPaths(dir);
  const cfg = { maxRecords: 100, autoCompact: false, warnChars: 0 };
  const now = Date.now();
  const card = createEmptyCard(now);
  for (let i = 0; i < 102; i++) {
    addMemoryRecord(card, { source: 'manual', sourceId: `anchor-${i}`, text: `重要手记第${i}条`, pinned: true }, cfg, now);
  }
  card.stats.fromBili = 2;
  card.meta.sourceSeen = ['coral', 'forgotten'];
  card.meta.manuallyForgottenBili = ['forgotten'];
  fs.writeFileSync(paths.json, JSON.stringify(card));
  const biliEntries = [
    { id: 'coral', type: 'video', title: '珊瑚礁的一天', shareable: true, at: new Date(now).toISOString() },
    { id: 'forgotten', type: 'video', title: '主动忘记的条目', shareable: true, at: new Date(now).toISOString() },
  ];
  const first = maintainMemoryCard({ paths, config: cfg, biliEntries, now });
  assert.equal(first.card.records.filter(({ pinned }) => pinned).length, 102);
  assert.deepEqual(first.card.records.filter(({ platform }) => platform === 'bili').map(({ sourceId }) => sourceId), ['coral']);
  assert.match(fs.readFileSync(paths.promptBili, 'utf8'), /珊瑚礁/);
  assert.equal(maintainMemoryCard({ paths, config: cfg, biliEntries, now }).bili, 0);
});

test('B 站简报在网页主聊下使用鱼姬之家身份', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-memory-web-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memory = createBiliMemory({ stateDir: dir, home: dir, chatPlatform: 'web' });
  const result = await memory.refresh({ force: true });
  assert.equal(result.ok, true, result.error);
  const brief = fs.readFileSync(memory.paths.brief, 'utf8');
  assert.match(brief, /鱼姬之家和 B 站里的我都是同一个角色/);
  assert.doesNotMatch(brief, /QQ|群友/);
});
