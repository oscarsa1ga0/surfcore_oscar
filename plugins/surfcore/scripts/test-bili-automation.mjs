/**
 * B站自动化配置/快照回归（2026-10-22）：
 *   · limits 从 bili.config.json 读，越界收敛，默认值不变；
 *   · checkFree 用实时配置（改文件后不用重启进程）；
 *   · kindsNow / dynamicsGapMin 读四类动态配置；
 *   · usageToday 与 automationSnapshot 的计数口径；
 *   · QQ 分享/动态同步快照（只读）。
 *
 * 运行：node scripts/test-bili-automation.mjs
 * 全程使用临时 DSH_HOME / QQBOT_ROOT，不读写真实配置和账本。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-auto-'));
const dshHome = path.join(tmp, '.dsh');
const biliDir = path.join(dshHome, 'surfcore', 'bili');
const fakeRoot = path.join(tmp, 'root');
fs.mkdirSync(biliDir, { recursive: true });
fs.mkdirSync(path.join(fakeRoot, 'src'), { recursive: true });
fs.mkdirSync(path.join(fakeRoot, 'state'), { recursive: true });

// paths.js 在 import 时读环境变量，所以必须先设置再动态 import。
process.env.DSH_HOME = dshHome;
process.env.SURFCORE_ROOT = fakeRoot;
process.env.SURFCORE_BILI_CONFIG = path.join(dshHome, 'surfcore', 'bili.config.json');

fs.writeFileSync(path.join(fakeRoot, 'src', 'bridge.js'), '// fixture\n');
fs.writeFileSync(path.join(fakeRoot, 'config.json'), JSON.stringify({
  allow: { groups: ['767098733'] },
  biliBridge: {
    enabled: true,
    share: { enabled: true, times: ['09:00', '21:00'], groups: [], gapMs: 4000, card: true },
    dynamics: { enabled: true, pollIntervalMs: 120000, groups: [] },
  },
}, null, 2));

const today = () => new Date().toLocaleDateString('sv-SE');
const nowIso = () => new Date().toISOString();

const biliConfig = {
  owner: { mid: '10001', name: '主人' },
  quota: { shareDaily: 5 },
  night: { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0.3, maxVideos: 5 },
  limits: {
    daily: 7, replyDaily: 9, taDaily: 3, mineDaily: 2, minePerPerson: 1,
    perUpMin: 1, perVideoMin: 1, perThreadMin: 1, globalMin: 0,
  },
  dynamics: {
    enabled: true,
    gapMin: 10,
    kinds: {
      best: { slot: 9, minLen: 20, maxLen: 40, prefix: '【T】' },
      game: { enabled: false },
    },
  },
};
const cfgFile = process.env.SURFCORE_BILI_CONFIG;
fs.writeFileSync(cfgFile, JSON.stringify(biliConfig, null, 2));

fs.writeFileSync(path.join(biliDir, 'quota.json'), JSON.stringify({
  log: [
    { at: nowIso(), type: 'comment', auto: true, share: false, reply: true, target: 'BV:A' },
    { at: nowIso(), type: 'comment', auto: true, share: false, reply: true, ta: true, target: 'BV:B' },
    { at: nowIso(), type: 'comment', auto: true, share: true, target: 'BV:C' },
    { at: nowIso(), type: 'comment', auto: true, share: false, reply: true, mine: 'best', target: 'oid:1' },
    { at: nowIso(), type: 'comment', auto: true, share: false, target: 'BV:D' },
  ],
}, null, 2));

fs.writeFileSync(path.join(biliDir, 'daily-dynamic.json'), JSON.stringify({
  best: { date: today(), at: nowIso(), atText: '09:01:00', kind: 'best', bvid: 'BV:A', dynId: '1' },
}, null, 2));
fs.writeFileSync(path.join(fakeRoot, 'state', 'bili-share-state.json'), JSON.stringify({
  lastSlot: `${today()} 09:00`,
  lastRunAt: nowIso(),
  lastSlots: { [`${today()} 09:00`]: nowIso() },
}, null, 2));
fs.writeFileSync(path.join(fakeRoot, 'state', 'bili-dynamics-state.json'), JSON.stringify({
  lastPollAt: Date.now(),
}, null, 2));

const { config } = await import('../tools/lib/config.mjs');
const { freeLimits, normalizeLimits, DEFAULT_LIMITS } = await import('../tools/lib/limits.mjs');
const { kindsNow, dynamicsEnabled, dynamicsGapMin, normalizeDynamics } = await import('../tools/lib/kinds.mjs');
const { checkFree, usageToday } = await import('../tools/lib/free-gate.mjs');
const { automationSnapshot } = await import('../lib/automation.js');

// ① 配置/默认值/收敛
assert.equal(config().limits.daily, 7);
assert.equal(config().quota.shareDaily, 5);
const limits = freeLimits(config());
assert.equal(limits.daily, 7);
assert.equal(limits.mineDaily, 2);
assert.equal(limits.perThreadMin, 1);
assert.equal(freeLimits({}).mineDaily, DEFAULT_LIMITS.mineDaily);
assert.deepEqual(normalizeLimits({ daily: -5, mineDaily: 999, globalMin: 999 }), {
  ...DEFAULT_LIMITS, daily: 0, mineDaily: 100, globalMin: 120,
});

// ② 四类动态配置
const kinds = kindsNow(config());
assert.equal(kinds.best.slot, 9);
assert.equal(kinds.best.prefix, '【T】');
assert.equal(kinds.anime.slot, 18, '没配置的类保留默认时段');
assert.equal(dynamicsGapMin(config()), 10);
assert.equal(dynamicsEnabled(config()), true);
const normalizedDyn = normalizeDynamics({ gapMin: 1, kinds: { best: { slot: 99, minLen: 9999, maxLen: 1, prefix: 'a\nb' } } });
assert.equal(normalizedDyn.gapMin, 5);
assert.equal(normalizedDyn.kinds.best.slot, 23);
assert.equal(normalizedDyn.kinds.best.minLen, 1000);
assert.equal(normalizedDyn.kinds.best.maxLen, 1010);
assert.equal(normalizedDyn.kinds.best.prefix, 'a b');

// ③ 四本账计数
const usage = usageToday();
assert.equal(usage.total, 5);
assert.equal(usage.comment, 1);
assert.equal(usage.reply, 1);
assert.equal(usage.ta, 1);
assert.equal(usage.mine.best, 1);
assert.equal(usage.share, 1);

// ④ checkFree 用实时配置：把 daily 改成 1，已经发过 1 条 → 必须拒绝
assert.equal(checkFree({ kind: 'comment' }).ok, true);
const patched = { ...biliConfig, limits: { ...biliConfig.limits, daily: 1 } };
fs.writeFileSync(cfgFile, JSON.stringify(patched, null, 2));
fs.utimesSync(cfgFile, new Date(), new Date(Date.now() + 2000));
const blocked = checkFree({ kind: 'comment' });
assert.equal(blocked.ok, false);
assert.match(blocked.text, /上限 1/);

// ④-b 0 = 关闭上限（不限量），不是"一条都不许发"
fs.writeFileSync(cfgFile, JSON.stringify({ ...biliConfig, limits: { ...biliConfig.limits, daily: 0 } }, null, 2));
fs.utimesSync(cfgFile, new Date(), new Date(Date.now() + 3000));
assert.equal(checkFree({ kind: 'comment' }).ok, true, 'daily=0 应视为不限量');

// ⑤ 快照
fs.writeFileSync(cfgFile, JSON.stringify(biliConfig, null, 2));
fs.utimesSync(cfgFile, new Date(), new Date(Date.now() + 4000));
const snap = automationSnapshot();
assert.equal(snap.ok, true);
assert.equal(snap.limits.daily, 7);
assert.equal(snap.usage.comment, 1);
assert.equal(snap.share.daily, 5);
assert.equal(snap.share.used, 1);
assert.equal(snap.dynamics.gapMin, 10);
assert.equal(snap.dynamics.kinds.length, 4);
assert.equal(snap.dynamics.kinds.find((k) => k.key === 'best').postedAt !== null, true);
assert.ok(snap.dynamics.next, '应能算出下一类动态');
assert.deepEqual(snap.qqShare.times, ['09:00', '21:00']);
assert.ok(snap.qqShare.nextAt, '应能算出下一班 QQ 分享');
assert.ok(snap.qqShare.lastSlot.includes('09:00'));
assert.ok(snap.qqShare.groupsEffective.includes('767098733'), 'groups 留空时应回落到 allow.groups');
assert.equal(snap.qqShare.cardMode, 'text', '旧 card:true 快照要报文本链接（QQ 卡片显示不了）');
assert.equal(snap.qqShare.card, true);
assert.ok(snap.dynamicsSync.lastPollAt);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('bili automation tests OK');
