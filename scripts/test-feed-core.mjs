// 选题器纯逻辑回归：偏好清洗/权重/配额/多样性/搜索轮换/去重。
// 不联网、不碰真实 ~/.dsh 状态。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  allocateQuotas, bvSetFromTexts, candidateScore, clampWeight, filterRecentlyPicked,
  followAgeDays, normalizePreferences, pickFollowingNew, preferenceHits, prunePickedMap, searchPlan, selectDiverse, splitTokens,
} from '../plugins/surfcore/tools/lib/feed-core.mjs';

const byKey = (entries) => Object.fromEntries(entries.map((entry) => [entry.key, entry]));
const candidate = (bv, title, opts = {}) => ({
  bv, t: title, d: opts.d ?? 120, dm: opts.dm ?? 0, play: opts.play ?? 100, up: opts.up ?? 'UP', kw: opts.kw ?? '',
  _hits: opts.hits ?? [], _score: opts.score ?? 0,
});

// ── 偏好清洗：大小写变体合并 / 权重 / 停用 / 额外关键词 ────────────────────
{
  const { entries, enabled, disabled } = normalizePreferences({
    like: ['DeepSeek', 'Deepseek', 'deepseek', '猫咪', 'DSH/AI 工具与插件'],
    keywords: ['手书', 'DeepSeek'],
    weights: { deepseek: 2.5, '猫咪': 0, '手书': 4 },
  });
  const map = byKey(entries);
  assert.equal(entries.length, 4, '大小写变体应合并成一条');
  assert.equal(map.deepseek.weight, 2.5, '权重按关键词生效');
  assert.equal(map.deepseek.kind, 'like', 'like 优先于 extra');
  assert.equal(map['猫咪'].weight, 0, '权重 0 = 停用');
  assert.equal(map['手书'].weight, 4, '额外关键词也吃权重');
  assert.equal(enabled.length, 3);
  assert.deepEqual(new Set(enabled.map((entry) => entry.key)), new Set(['deepseek', '手书', 'dsh/ai 工具与插件']));
  assert.deepEqual(disabled.map((entry) => entry.key), ['猫咪']);
  assert.ok(map['dsh/ai 工具与插件'].tokens.includes('ai'), '拆分出的子词参与标题匹配');
}
assert.equal(clampWeight(99), 5);
assert.equal(clampWeight(-1), 0);
assert.equal(clampWeight('abc', 1), 1);
assert.deepEqual(new Set(splitTokens('DSH/AI 工具与插件')), new Set(['dsh/ai 工具与插件', 'dsh', 'ai', '工具与插件']));

// ── 命中：同一标题里一个偏好只算一次，不会因变体叠分 ─────────────────────
{
  const { enabled } = normalizePreferences({ like: ['DeepSeek', 'Deepseek', 'deepseek', 'AI'] });
  const hits = preferenceHits('DeepSeek 和 deepseek 都在这条标题里', enabled);
  assert.equal(hits.length, 1, 'DeepSeek/Deepseek/deepseek 合并成一条，不能叠 3 分');
  assert.equal(hits[0].key, 'deepseek');
}
{
  // 拉丁短词按词边界匹配：AI 不能命中 said / email / trailer
  const { enabled } = normalizePreferences({ like: ['AI'] });
  assert.equal(preferenceHits('this is a said email trailer', enabled).length, 0);
  assert.equal(preferenceHits('AI 猫咪', enabled).length, 1);
  assert.equal(preferenceHits('AI猫咪', enabled).length, 1);
}
{
  const { enabled } = normalizePreferences({ like: ['AI', '猫咪'], weights: { AI: 2 } });
  const hits = preferenceHits('AI 猫咪', enabled);
  assert.equal(hits.length, 2);
  const base = candidate('BV1', 'AI');
  const title = 'AI 猫咪';
  assert.equal(candidateScore(base, preferenceHits(title, enabled)) > candidateScore(base, preferenceHits('AI', enabled)), true, '权重大 / 命中多应更高分');
  assert.equal(Number.isFinite(candidateScore({ dm: 'NaN', d: 0 }, hits)), true, 'NaN 弹幕不能把分数算成 NaN');
}

// ── 配额：按权重分，且有保底与上限 ────────────────────────────────────────
function quotaTester(labels, weights, n, perPref = 3, seed = 1) {
  const { enabled } = normalizePreferences({ like: labels, weights });
  const counts = new Map(enabled.map((entry) => [entry.key, 100]));
  return allocateQuotas(enabled, counts, n, { perPref, seed });
}
{
  const q = quotaTester(['A', 'B', 'C', 'D'], {}, 6, 3);
  const values = [...q.values()].sort((a, b) => b - a);
  assert.deepEqual(values, [2, 2, 1, 1], `4 个等权偏好分 6 条应是 2/2/1/1，实际 ${values}`);
}
{
  const q = quotaTester(['A', 'B'], { A: 3, B: 1 }, 4, 4);
  assert.equal(q.get('a'), 3, '3:1 应该分出 3:1，不是 2:2');
  assert.equal(q.get('b'), 1);
}
{
  const q = quotaTester(['A', 'B'], { A: 1 }, 6, 3);
  assert.deepEqual([...q.values()].sort((a, b) => b - a), [3, 3], '等权 2 个偏好应各拿 3');
}
{
  const q = quotaTester(['A', 'B'], { A: 10, B: 1 }, 6, 2);
  assert.equal(q.get('a'), 2, '单条偏好不能超过 perPref');
  assert.equal(q.get('b'), 2, '被上限卡住后，另一条尽量补满');
}
{
  const q = quotaTester(Array.from({ length: 12 }, (_, i) => `词${i}`), {}, 6, 3, 42);
  assert.equal([...q.values()].reduce((a, b) => a + b, 0), 6);
  assert.equal(q.size, 6, '12 个偏好只有 6 条时，按权重抽样选 6 个（不能永远前 6 个）');
  const q2 = quotaTester(Array.from({ length: 12 }, (_, i) => `词${i}`), {}, 6, 3, 7);
  assert.notDeepEqual([...q.keys()].sort(), [...q2.keys()].sort(), '换一天（种子）应轮到别的偏好');
}

// ── 选择：偏好间轮转、每词上限、不重复、无命中最多 1 条 ──────────────────
{
  const { enabled } = normalizePreferences({ like: ['A', 'B', 'C', 'D'] });
  const labels = byKey(enabled);
  let seq = 0;
  const mk = (title, tag) => {
    seq += 1;
    return {
      ...candidate(`BV${String(seq).padStart(4, '0')}`, title),
      _hits: [labels[tag]],
      _score: 10 + (seq % 5),
    };
  };
  const list = [
    ...Array.from({ length: 5 }, () => mk('A 视频', 'a')),
    ...Array.from({ length: 5 }, () => mk('B 视频', 'b')),
    ...Array.from({ length: 5 }, () => mk('C 视频', 'c')),
    ...Array.from({ length: 5 }, () => mk('D 视频', 'd')),
    { ...candidate('BVnone', '没有命中'), _hits: [], _score: 99 },
  ];
  const { picked, quotas } = selectDiverse(list, enabled, { n: 6, perPref: 3, generic: 1, seed: 1 });
  assert.equal(picked.length, 6);
  assert.equal(new Set(picked.map((item) => item.bv)).size, 6, '不能推重复 BV');
  for (const [key, quota] of quotas) {
    const count = picked.filter((item) => item._via === key).length;
    assert.ok(count <= quota, `${key} 超出配额 ${quota}（实际 ${count}）`);
    assert.ok(count <= 3, '每词最多 perPref 条');
  }
  assert.equal(picked.filter((item) => !item._primary).length <= 1, true, '无命中最多补 1 条');
  // 偏好之间轮转：前 4 条应该覆盖 4 个偏好（顺序按权重，等权时按 key）
  assert.equal(new Set(picked.slice(0, 4).map((item) => item._via)).size, 4, '前 4 条应覆盖 4 个偏好');
}
{
  // 某条偏好候选不够 → 名额让给别的偏好，不抛错
  const { enabled } = normalizePreferences({ like: ['A', 'B'] });
  const labels = byKey(enabled);
  const list = [
    { ...candidate('BV1', 'A1'), _hits: [labels.a], _score: 5 },
    { ...candidate('BV2', 'B1'), _hits: [labels.b], _score: 4 },
    { ...candidate('BV3', 'B2'), _hits: [labels.b], _score: 3 },
    { ...candidate('BV4', 'B3'), _hits: [labels.b], _score: 2 },
  ];
  const result = selectDiverse(list, enabled, { n: 5, perPref: 3, generic: 0, seed: 1 });
  assert.equal(result.picked.length, 4, '候选不够就少给，不凑数');
  assert.ok(result.shortfall.some((item) => item.key === 'a'), 'A 候选不足应记录 shortfall');
}

{
  // 只有一条偏好有候选：perPref 不该把它削到看不够
  const { enabled } = normalizePreferences({ like: ['A'] });
  const labels = byKey(enabled);
  const list = Array.from({ length: 8 }, (_, i) => ({
    ...candidate(`BVsolo${i}`, `A ${i}`),
    _hits: [labels.a],
    _score: 10 - i,
  }));
  const result = selectDiverse(list, enabled, { n: 6, perPref: 2, generic: 0, seed: 1 });
  assert.equal(result.picked.length, 6, '单偏好时候选够就能看满 N 条');
}

// ── 搜索轮换：同种子稳定、换种子换页/换排序 ─────────────────────────────
{
  const { enabled } = normalizePreferences({ like: ['AI', '猫咪', '手书'] });
  const p1 = searchPlan(enabled, { seed: '2026-10-23' });
  const p2 = searchPlan(enabled, { seed: '2026-10-23' });
  assert.deepEqual(p1.map((item) => `${item.key}:${item.order}:${item.page}`), p2.map((item) => `${item.key}:${item.order}:${item.page}`));
  const p3 = searchPlan(enabled, { seed: '2026-10-24' });
  assert.notDeepEqual(p1.map((item) => `${item.order}:${item.page}`), p3.map((item) => `${item.order}:${item.page}`));
  assert.ok(p1.every((item) => ['totalrank', 'pubdate', 'click', 'dm'].includes(item.order)));
  assert.ok(p1.every((item) => [1, 2, 3].includes(item.page)));
}

// ── 看过名单 / 最近推过 ───────────────────────────────────────────────────
{
  const set = bvSetFromTexts(['看过 BV1KXpN6QEJm 和 BV1jhn16GEcv', '重复 BV1KXpN6QEJm']);
  assert.deepEqual([...set].sort(), ['BV1KXpN6QEJm', 'BV1jhn16GEcv']);
}
{
  const now = Date.parse('2026-10-23T12:00:00Z');
  const list = [candidate('BVnew', 'new'), candidate('BVold', 'old'), candidate('BVedge', 'edge')];
  const filtered = filterRecentlyPicked(list, {
    BVold: '2026-10-01T00:00:00Z',
    BVedge: '2026-10-22T23:00:00Z',
  }, { now, days: 3 });
  assert.deepEqual(filtered.map((item) => item.bv), ['BVnew', 'BVold'], '3 天内推过的避开；更早的可以再推');
  const pruned = prunePickedMap({ BVold: '2026-01-01T00:00:00Z', BVedge: '2026-10-22T23:00:00Z' }, { now, days: 30 });
  assert.deepEqual(Object.keys(pruned), ['BVedge']);
}

// ── 关注新视频优先：只看 7 天内、按发布时间新→旧、最多 n 条 ──────────────
{
  const now = Date.parse('2026-11-13T12:00:00+08:00');
  const day = 86400000;
  const cands = [
    { bv: 'BVnew1', via: 'following', pubTs: now - 1 * day, _score: 1 },
    { bv: 'BVold', via: 'following', pubTs: now - 8 * day, _score: 9 },
    { bv: 'BVnew2', via: 'following', pubTs: now - 3 * day, _score: 2 },
    { bv: 'BVsearch', via: 'search', pubTs: now - 1 * day, _score: 8 },
    { bv: 'BVunknown', via: 'following', pubTs: 0, _score: 9 },
  ];
  const r = pickFollowingNew(cands, { n: 2, days: 7, now });
  assert.deepEqual(r.picked.map((x) => x.bv), ['BVnew1', 'BVnew2']);
  assert.ok(r.picked.every((x) => x._via === 'following' && x._followAgeDays <= 7));
  assert.equal(r.eligible, 2);
  const rest = new Set(r.rest.map((x) => x.bv));
  assert.ok(!rest.has('BVnew1') && !rest.has('BVnew2'), '已优先的不能留在补位池');
  assert.ok(rest.has('BVold') && rest.has('BVsearch') && rest.has('BVunknown'));
  assert.equal(followAgeDays(now - 7 * day, now), 7);
  assert.equal(followAgeDays(0, now), null);
  assert.equal(pickFollowingNew(cands, { n: 0, days: 7, now }).picked.length, 0);
}

// ── 接线契约：feed.mjs 必须真的接上观看历史/偏好权重/最近推过 ─────────────
{
  const source = fs.readFileSync(new URL('../plugins/surfcore/tools/commands/feed.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('readWatchHistory'), 'feed 没有接观看历史（会重复推刚看过的）');
  assert.ok(source.includes('feed-picks.json'), 'feed 没有记最近推过');
  assert.ok(source.includes('preferences?.weights'), 'feed 没有读 preferences.weights');
  assert.ok(source.includes('normalizePreferences'), 'feed 没有走偏好清洗（大小写变体会叠分）');
  assert.ok(source.includes('searchPlan'), 'feed 没有走搜索轮换');
  assert.ok(source.includes('pickFollowingNew'), 'feed 没有接关注新视频优先');
  assert.ok(source.includes("follow-days"), 'feed 缺少 --follow-days');
  assert.ok(source.includes('like-video') && source.includes("type === 'coin'"), 'feed 没有接点赞/投币回流');
  assert.ok(source.includes('5.5') && source.includes('4.0') && source.includes('2.5') && source.includes('1.0'), 'feed 的点赞/收藏/投币权重不完整');
}

// ── 游戏候选取样器也必须排除看过的视频（2026-10-23 原神/鸣潮又推旧片）──
{
  const gamefeed = fs.readFileSync(new URL('../plugins/surfcore/tools/commands/gamefeed.mjs', import.meta.url), 'utf8');
  assert.ok(gamefeed.includes('readWatchHistory'), 'gamefeed 没接观看历史');
  assert.ok(gamefeed.includes('gamefeed-picks.json'), 'gamefeed 没记最近推过');
  assert.ok(gamefeed.includes('已排除：看过'), 'gamefeed 没有输出排除统计');
  assert.ok(gamefeed.includes("opt['no-remember']"), 'gamefeed 缺少 --no-remember（测试/重跑会污染备忘）');
}

console.log('OK test-feed-core');
