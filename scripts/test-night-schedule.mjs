// 生物钟 C 模式：每窗至少 1 次、全天 ≤12、相邻至少 minGap、额外按质量分配。
// 纯逻辑；不读写真实状态、不叫醒。
import assert from 'node:assert/strict';
import {
  normalizeNightWindows, buildNightSchedule, nextPendingSlot, markScheduleSlot,
  qualityByWindow, minToHHMM,
} from '../plugins/surfcore/tools/lib/night-schedule.mjs';

const windows = [
  { start: '06:00', end: '08:00', wakes: 3 },
  { start: '10:00', end: '12:00', wakes: 3 },
  { start: '14:00', end: '16:00', wakes: 3 },
  { start: '18:00', end: '19:00', wakes: 3 },
  { start: '19:00', end: '20:00', wakes: 3 },
  { start: '20:00', end: '21:00', wakes: 3 },
  { start: '21:00', end: '22:00', wakes: 3 },
  { start: '22:00', end: '23:00', wakes: 3 },
  { start: '23:00', end: '24:00', wakes: 3 },
];

assert.equal(minToHHMM(630), '10:30');
assert.equal(normalizeNightWindows([{ start: '22:00', end: '02:00', wakes: 1 }])[0].wrap, true);

const built = buildNightSchedule({
  windows, maxWakes: 12, minGapMin: 20, skipChance: 0, nowMin: 0,
  quality: {}, random: () => 0.5,
});
assert.equal(built.slots.length, 12, '全天最多 12 次');
assert.equal(built.baseCount, 9, '9 个窗口至少 1 次');
assert.equal(built.extraCount, 3, '剩余 3 次加餐');
assert.equal(new Set(built.slots.map((s) => s.window)).size, 9, '每个窗口都要覆盖');
for (let i = 1; i < built.slots.length; i += 1) {
  assert.ok(built.slots[i].at - built.slots[i - 1].at >= 20, `相邻两次至少 20 分钟：${built.slots[i - 1].atText} → ${built.slots[i].atText}`);
}
// 每个窗口的 base 都在自己的 [start,end) 内
for (const slot of built.slots) {
  assert.ok(slot.at >= slot.start && slot.at < slot.end, `${slot.window} ${slot.atText} 越界`);
}

// 质量优先：10–12 时段历史分最高 → 它的加餐名额应该最多
const q = { '10:00–12:00': 18 };
const qualityBuilt = buildNightSchedule({
  windows, maxWakes: 12, minGapMin: 20, skipChance: 0, nowMin: 0,
  quality: q, random: () => 0.5,
});
const ten = qualityBuilt.slots.filter((s) => s.window === '10:00–12:00');
assert.equal(ten.length, 3, '高评分窗口应拿满 3 次');
assert.ok(qualityBuilt.slots.filter((s) => s.kind === 'extra').some((s) => s.window === '10:00–12:00'));

// skip 是“轻醒”，不结束全天；每个 base 仍然存在
const skipped = buildNightSchedule({
  windows, maxWakes: 12, minGapMin: 20, skipChance: 1, nowMin: 0,
  quality: {}, random: () => 0.5,
});
assert.ok(skipped.slots.every((s) => s.action === 'skip'));
assert.equal(new Set(skipped.slots.map((s) => s.window)).size, 9);

// 过期 slot → missed；窗口内已过点 → 改成现在叫醒
const schedule = {
  slots: [
    { id: 'a', window: 'w', start: 100, end: 120, at: 110, atText: '01:50', status: 'pending', action: 'wake' },
    { id: 'b', window: 'w2', start: 200, end: 220, at: 210, atText: '03:30', status: 'pending', action: 'wake' },
  ],
};
const early = nextPendingSlot(schedule, 115);
assert.equal(early.id, 'a');
assert.equal(early.late, true);
assert.equal(early.at, 116);
const afterA = nextPendingSlot(schedule, 130);
assert.equal(afterA.id, 'b');
const missed = nextPendingSlot(schedule, 300);
assert.equal(missed, null);
assert.equal(schedule.slots[1].status, 'missed');
markScheduleSlot(schedule, 'a', 'fired', 116);
assert.equal(schedule.slots[0].status, 'fired');

// 质量聚合：只算窗口内、最近 30 天
const scores = {
  '2026-10-23': [
    { at: '2026-10-23T10:30:00+08:00', score: 16 },
    { at: '2026-10-23T10:45:00+08:00', score: 18 },
    { at: '2026-10-23T18:30:00+08:00', score: 10 },
  ],
  '2026-01-01': [{ at: '2026-01-01T10:30:00+08:00', score: 20 }],
};
const qq = qualityByWindow(scores, normalizeNightWindows(windows), {
  now: new Date('2026-10-23T12:00:00+08:00').getTime(), days: 30,
});
assert.equal(qq['10:00–12:00'], 17);
assert.equal(qq['18:00–19:00'], 10);
assert.equal(qq['20:00–21:00'], undefined);

console.log('night schedule tests OK');

// 回归：落在窗口最后一分钟的点会被 60s tick 判成 missed（2026-11-16 22:00–23:00 丢过）。
// 排程必须把 at 压到 end-2 以内，random=0.999 也不能贴边。
{
  const edge = buildNightSchedule({
    windows: [{ start: '22:00', end: '23:00', wakes: 1 }],
    maxWakes: 1, minGapMin: 20, skipChance: 0, nowMin: 0,
    quality: {}, random: () => 0.999,
  });
  assert.equal(edge.slots.length, 1);
  assert.ok(edge.slots[0].at <= edge.slots[0].end - 2, `不能排在最后一分钟：${edge.slots[0].atText}`);
  assert.ok(edge.slots[0].at >= edge.slots[0].start, '仍要落在窗口内');
}
console.log('night schedule edge tests OK');
