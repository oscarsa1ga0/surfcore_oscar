// 日记存储层单测（真实临时目录，不碰用户数据）。
// 覆盖：建/同日多篇/按日期读/搜索/改/删/重启后读/索引损坏重建/分享/出站闸/候选/角色隔离。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  archiveCandidates, captureCandidate, checkPrivateLeak, clearLeakCache, createEntry, deleteEntry,
  diaryPaths, diaryStatus, editEntry, ensureIndex, listCandidates, listEntries, readEntries,
  readSchedulerState, rebuildIndex, scanEntries, searchEntries, shareEntry, writeSchedulerState,
} from '../src/diary-store.js';

const temps = [];
function tempCharacter(name = 'char-test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-store-'));
  temps.push(root);
  const dir = path.join(root, 'characters', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, 'characters'), { recursive: true });
  fs.writeFileSync(path.join(root, 'characters', 'current.json'), JSON.stringify({ id: name, name: '测试鱼', epoch: 1 }));
  return dir;
}
after(() => {
  for (const dir of temps) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});

const NOW = Date.parse('2026-11-12T23:30:00+08:00');
const DAY = '2026-11-12';

test('创建日记：同一天多篇、按日期读、索引记录', () => {
  const char = tempCharacter();
  const diary = path.join(char, 'diary');
  const a = createEntry(diary, { content: '今天第一次看见主人发来的猫猫图，毛茸茸的。', title: '猫猫', tags: ['主人', '第一次'], now: NOW });
  const b = createEntry(diary, { content: '晚上又聊到 B 站账号的事，他说名字随便我起。', tags: ['B站'], now: NOW + 1000 });
  assert.equal(a.entry.id, 'd-20261112-001');
  assert.equal(b.entry.id, 'd-20261112-002');
  assert.ok(fs.existsSync(path.join(diary, 'entries', '2026', '11', '12', 'entry_001.md')));
  assert.ok(fs.existsSync(path.join(diary, 'entries', '2026', '11', '12', 'entry_002.md')));

  const read = readEntries(diary, { date: DAY });
  assert.equal(read.entries.length, 2);
  assert.ok(read.entries[0].body.includes('猫猫') || read.entries[0].body.includes('B 站'));
  assert.equal(read.entries[0].private, true);

  const list = listEntries(diary, { from: DAY, to: DAY });
  assert.equal(list.total, 2);
  assert.equal(list.entries[0].chars > 0, true);

  const index = ensureIndex(diary);
  assert.equal(index.entries.length, 2);
  assert.equal(index.entries[0].file.startsWith('entries/'), true);
});

test('搜索与修改：按关键词/标签；append 不覆盖原文', () => {
  const char = tempCharacter();
  const diary = path.join(char, 'diary');
  const made = createEntry(diary, { content: '今天下雨，没出门，听了一下午的歌。', tags: ['下雨'], now: NOW });
  const hit = searchEntries(diary, { query: '下雨' });
  assert.equal(hit.entries.length, 1);
  assert.equal(hit.entries[0].id, made.entry.id);
  const byTag = searchEntries(diary, { tags: ['下雨'] });
  assert.equal(byTag.entries.length, 1);

  editEntry(diary, { id: made.entry.id, append: '后来雨停了，窗外有很亮的晚霞。', tags: ['下雨', '晚霞'], now: NOW + 5000 });
  const read = readEntries(diary, { id: made.entry.id });
  assert.ok(read.entries[0].body.includes('听了一下午的歌'));
  assert.ok(read.entries[0].body.includes('晚霞'));
  assert.deepEqual(read.entries[0].tags, ['下雨', '晚霞']);
});

test('删除进回收站，不会误删别的条目', () => {
  const char = tempCharacter();
  const diary = path.join(char, 'diary');
  const a = createEntry(diary, { content: '第一篇要删的。', now: NOW });
  const b = createEntry(diary, { content: '第二篇要留的。', now: NOW });
  const removed = deleteEntry(diary, { id: a.entry.id, now: NOW });
  assert.match(removed.trash, /^trash\//);
  assert.equal(fs.existsSync(path.join(diary, removed.trash)), true);
  const list = listEntries(diary);
  assert.equal(list.total, 1);
  assert.equal(list.entries[0].id, b.entry.id);
});

test('重启后仍能读：不依赖进程内状态；索引损坏可重建', () => {
  const char = tempCharacter();
  const diary = path.join(char, 'diary');
  const made = createEntry(diary, { content: '这篇要在“重启”之后还能读到。', now: NOW });
  const scanned = scanEntries(diary);
  assert.equal(scanned.entries.length, 1);
  assert.equal(scanned.entries[0].id, made.entry.id);

  fs.writeFileSync(diaryPaths(diary).index, '{ this is not json');
  const rebuilt = ensureIndex(diary);
  assert.equal(rebuilt.entries.length, 1);
  assert.equal(rebuilt.entries[0].id, made.entry.id);
  fs.rmSync(diaryPaths(diary).index);
  const rebuilt2 = rebuildIndex(diary);
  assert.equal(rebuilt2.entries.length, 1);
});

test('私人日记不能整篇分享；原文摘录可以，且只有摘录被授权', () => {
  const char = tempCharacter();
  const diary = path.join(char, 'diary');
  const body = '今天主人问我想不想去海边，我说想，但是又有点怕水。';
  const made = createEntry(diary, { content: body, now: NOW });
  assert.throws(() => shareEntry(diary, { id: made.entry.id, mode: 'full' }), /私人日记/);
  assert.throws(() => shareEntry(diary, { id: made.entry.id, mode: 'excerpt', excerpt: '海边很好玩' }), /原文/);

  clearLeakCache();
  const leaked = checkPrivateLeak(diary, `我跟你说：${body}`);
  assert.equal(leaked.blocked, true);

  const shared = shareEntry(diary, { id: made.entry.id, mode: 'excerpt', excerpt: '我说想，但是又有点怕水。', reason: '主人问起' });
  assert.equal(shared.ok, true);
  assert.equal(shared.text, '我说想，但是又有点怕水。');
  clearLeakCache();
  const allowed = checkPrivateLeak(diary, '跟你分享一句：我说想，但是又有点怕水。');
  assert.equal(allowed.blocked, false);
  const stillBlocked = checkPrivateLeak(diary, '今天主人问我想不想去海边，我说想，但是又有点怕水。');
  assert.equal(stillBlocked.blocked, true);

  const shareable = createEntry(diary, { content: '这条可以给他看：今天学会了一句新歌。', visibility: 'shareable', now: NOW });
  const full = shareEntry(diary, { id: shareable.entry.id, mode: 'full' });
  assert.equal(full.text, '这条可以给他看：今天学会了一句新歌。');
});

test('候选：追加、去重、归档；调度状态读写', () => {
  const char = tempCharacter();
  const diary = path.join(char, 'diary');
  captureCandidate(diary, { note: '今天第一次听到主人唱歌', now: NOW });
  const dup = captureCandidate(diary, { note: '今天第一次听到主人唱歌', now: NOW + 1000 });
  assert.equal(dup.duplicate, true);
  captureCandidate(diary, { note: 'B站账号起名了', now: NOW + 2000 });
  assert.equal(listCandidates(diary, { day: DAY }).items.length, 2);
  const moved = archiveCandidates(diary, { day: DAY, now: NOW });
  assert.equal(moved.moved, true);
  assert.equal(listCandidates(diary, { day: DAY }).items.length, 0);
  assert.ok(fs.existsSync(path.join(diary, 'candidates', 'processed', `${DAY}.jsonl`)));

  writeSchedulerState(diary, { lastReviewedDay: DAY, attempts: {}, submittedAt: new Date(NOW).toISOString() });
  assert.equal(readSchedulerState(diary).lastReviewedDay, DAY);
  assert.equal(diaryStatus(diary, { now: NOW }).scheduler.lastReviewedDay, DAY);
});

test('角色隔离：两个角色目录互不可见；非法 id/未来日期被拒绝', () => {
  const charA = tempCharacter('char-a');
  const charB = tempCharacter('char-b');
  createEntry(path.join(charA, 'diary'), { content: '只属于 A 的日记。', now: NOW });
  assert.equal(listEntries(path.join(charA, 'diary')).total, 1);
  assert.equal(listEntries(path.join(charB, 'diary')).total, 0);
  assert.throws(() => deleteEntry(path.join(charA, 'diary'), { id: '../../char-b/diary/index.json' }), /id 不合法/);
  assert.throws(() => createEntry(path.join(charA, 'diary'), { content: '未来的事', date: '2026-12-01', now: NOW }), /未来/);
  assert.throws(() => createEntry(path.join(charA, 'diary'), { content: '   ', now: NOW }), /不能为空/);
});
