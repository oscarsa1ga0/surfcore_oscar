// 日记工具层单测：直接调用工具的 execute（不经过 DSH），验证参数/返回/权限边界。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-tools-'));
const dshHome = path.join(tempRoot, 'dsh');
const surfcoreDir = path.join(dshHome, 'surfcore');
const charId = 'char-tools';
const charDir = path.join(surfcoreDir, 'characters', charId);
fs.mkdirSync(charDir, { recursive: true });
fs.writeFileSync(path.join(surfcoreDir, 'characters', 'current.json'), JSON.stringify({ id: charId, name: '测试鱼', epoch: 1 }));
fs.writeFileSync(path.join(surfcoreDir, 'config.json'), JSON.stringify({ diary: { leakGuard: true } }));
process.env.DSH_HOME = dshHome;

const { createDiaryToolDefinitions } = await import('../plugins/surfcore/lib/diary-tools.js');
const defs = createDiaryToolDefinitions();
const tools = new Map(defs.map((item) => [item.name, item]));

after(() => { try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {} });

async function call(name, args) {
  const tool = tools.get(name);
  assert.ok(tool, `工具不存在：${name}`);
  return JSON.parse(await tool.execute(args));
}

test('工具 schema：必填字段在 required，properties 里不再残留 required:true', () => {
  for (const tool of defs) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.parameters.additionalProperties, 'boolean');
    for (const [key, schema] of Object.entries(tool.parameters.properties)) {
      assert.equal(schema.required, undefined, `${tool.name}.${key} 不应该在 properties 里带 required`);
    }
  }
  assert.deepEqual(tools.get('diary_write').parameters.required, ['content']);
  assert.deepEqual(tools.get('diary_share').parameters.required, ['id']);
});

test('写 / 读 / 列表 / 搜索 / 改 / 删 完整走一遍', async () => {
  const write = await call('diary_write', { content: '今天第一次自己写日记，有点笨拙。', title: '第一次', tags: ['第一次'] });
  assert.equal(write.ok, true);
  assert.match(write.entry.id, /^d-\d{8}-\d{3}$/);

  const read = await call('diary_read', { id: write.entry.id });
  assert.equal(read.ok, true);
  assert.equal(read.entries[0].private, true);
  assert.ok(read.entries[0].body.includes('有点笨拙'));

  const list = await call('diary_list', { limit: 5 });
  assert.equal(list.ok, true);
  assert.ok(list.entries.some((entry) => entry.id === write.entry.id));

  const search = await call('diary_search', { query: '笨拙' });
  assert.equal(search.ok, true);
  assert.equal(search.entries[0].id, write.entry.id);

  const edited = await call('diary_edit', { id: write.entry.id, append: '不过写下来之后舒服多了。' });
  assert.equal(edited.ok, true);
  const reread = await call('diary_read', { id: write.entry.id });
  assert.ok(reread.entries[0].body.includes('舒服多了'));

  const removed = await call('diary_delete', { id: write.entry.id });
  assert.equal(removed.ok, true);
  const afterDelete = await call('diary_list', { limit: 5 });
  assert.equal(afterDelete.entries.some((entry) => entry.id === write.entry.id), false);
});

test('候选：capture 后可读；同日重复不重复记', async () => {
  const first = await call('diary_capture', { note: '主人今天第一次叫我名字' });
  assert.equal(first.ok, true);
  const dup = await call('diary_capture', { note: '主人今天第一次叫我名字' });
  assert.equal(dup.duplicate, true);
});

test('分享边界：private 整篇拒绝、原文摘录通过、改写拒绝', async () => {
  const body = '今天和主人聊了很久，最后他说希望我一直记得今天。';
  const write = await call('diary_write', { content: body });
  const full = await call('diary_share', { id: write.entry.id, mode: 'full' });
  assert.equal(full.ok, false);
  assert.match(full.error, /私人日记/);

  const rewritten = await call('diary_share', { id: write.entry.id, mode: 'excerpt', excerpt: '他希望我一直记得今天。' });
  assert.equal(rewritten.ok, false);
  assert.match(rewritten.error, /原文/);

  const excerpt = await call('diary_share', { id: write.entry.id, mode: 'excerpt', excerpt: '最后他说希望我一直记得今天。' });
  assert.equal(excerpt.ok, true);
  assert.equal(excerpt.text, '最后他说希望我一直记得今天。');

  const shareable = await call('diary_write', { content: '这条可以给你看：今天学会了一句新歌。', visibility: 'shareable' });
  const whole = await call('diary_share', { id: shareable.entry.id, mode: 'full' });
  assert.equal(whole.ok, true);
  assert.equal(whole.text, '这条可以给你看：今天学会了一句新歌。');
});

test('角色绑定：调用里带旧角色 id 会被拒绝', async () => {
  const wrong = await call('diary_write', { content: '不该写进去', characterId: 'char-other' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /角色已经切换/);
});

test('关闭自主暂存后 diary_capture 拒绝，但 diary_write 仍可用', async () => {
  const { createDiaryToolDefinitions: create } = await import('../plugins/surfcore/lib/diary-tools.js');
  const disabled = new Map(create({ getConfig: () => ({ captureEnabled: false }) }).map((item) => [item.name, item]));
  const captured = JSON.parse(await disabled.get('diary_capture').execute({ note: '不该记' }));
  assert.equal(captured.ok, false);
  assert.match(captured.error, /自主暂存候选已关闭/);
  const written = JSON.parse(await disabled.get('diary_write').execute({ content: '主人让我写，仍然要能写。' }));
  assert.equal(written.ok, true);
});

test('参数错误返回 ok:false，不抛到工具层外', async () => {
  const empty = await call('diary_write', { content: '   ' });
  assert.equal(empty.ok, false);
  const badDay = await call('diary_write', { content: 'x', date: '2026-13-01' });
  assert.equal(badDay.ok, false);
  const badId = await call('diary_delete', { id: '../../etc/passwd' });
  assert.equal(badId.ok, false);
});
