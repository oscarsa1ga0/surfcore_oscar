// B站「每日分享 → 自己的动态」纯逻辑回归（不发网络请求）。
// 重点：和四类动态共用 daily-dynamic.json，任意两条至少隔 dynamics.gapMin 分钟。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readShareState, lastDynamicAt, dynamicGapWait, mergeShareRecord,
} from '../plugins/surfcore/tools/lib/share-dynamic.mjs';
import { normalizeBiliConfig } from '../plugins/surfcore/lib/store.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-share-dynamic-'));

// 读不存在的 / 损坏的文件 → 空对象，不抛
assert.deepEqual(readShareState(path.join(tmpDir, 'nope.json')), {});
const broken = path.join(tmpDir, 'broken.json');
fs.writeFileSync(broken, '{not json');
assert.deepEqual(readShareState(broken), {});

const now = Date.parse('2026-10-23T10:20:00+08:00');
const state = {
  best: { at: '2026-10-23T08:00:00+08:00', kind: 'best', bvid: 'BV1xx411c7mD' },
  share: { at: '2026-10-23T09:00:00+08:00', kind: 'share', bvid: 'BV1yy411c7mE' },
};
assert.equal(lastDynamicAt(state), Date.parse('2026-10-23T09:00:00+08:00'));
assert.equal(lastDynamicAt({}), 0);

// 09:00 + 30 分钟 = 09:30；10:20 已经可以
assert.deepEqual(dynamicGapWait(state, 30, now), { ok: true, lastAt: Date.parse('2026-10-23T09:00:00+08:00'), waitMin: 0 });
const early = Date.parse('2026-10-23T09:20:00+08:00');
const wait = dynamicGapWait(state, 30, early);
assert.equal(wait.ok, false);
assert.equal(wait.waitMin, 10);
// 没有历史 → 直接放行
assert.equal(dynamicGapWait({}, 30, now).ok, true);

// 写 share 记录时保留四类
const merged = mergeShareRecord(state, {
  date: '2026-10-23', at: '2026-10-23T10:30:00+08:00', atText: '10:30:00',
  bvid: 'BV1zz411c7mF', dynId: '123456', card: true, chars: 42,
});
assert.equal(merged.best.bvid, 'BV1xx411c7mD');
assert.equal(merged.share.kind, 'share');
assert.equal(merged.share.card, true);
assert.equal(merged.share.dynId, '123456');
assert.equal(merged.share.bvid, 'BV1zz411c7mF');
assert.equal(merged.share.chars, 42);

// 命令接线契约（防止以后又把“卡片/间隔/分享额度”删掉）
const cmd = fs.readFileSync(new URL('../plugins/surfcore/tools/commands/share-dynamic.mjs', import.meta.url), 'utf8');
assert.ok(cmd.includes('findVideoDynamic'));
assert.ok(cmd.includes('createForward'));
assert.ok(cmd.includes('dynamicGapWait'));
assert.ok(cmd.includes('recordQuota'));
assert.ok(cmd.includes('--allow-text'));
assert.ok(cmd.includes('daily-dynamic.json'));

const registry = fs.readFileSync(new URL('../plugins/surfcore/tools/bili.mjs', import.meta.url), 'utf8');
assert.ok(registry.includes("'share-dynamic'"));

// 默认分享方式为动态。旧评论分享设置读入后转为私信。
assert.equal(normalizeBiliConfig({ share: { via: 'dynamic' } }).share.via, 'dynamic');
assert.equal(normalizeBiliConfig({ share: { via: 'comment' } }).share.via, 'dm');
assert.equal(normalizeBiliConfig({ share: { via: 'dm' } }).share.via, 'dm');
assert.equal(normalizeBiliConfig({ share: {} }).share.via, 'dynamic');

console.log('share dynamic tests OK');
