// 每日 token 额度纯逻辑 + 文件读写回归（不启桥接、不连 DSH、不发 QQ）。
//
// 这些断言对应几个真实会翻车的点：
// 1. 金额 / token 两种单位必须能同时存在、各自比较，不能混成一个数；
// 2. `¥8`、`8元`、`8M`、`8,000,000`、`2万` 都要解析成同一个额度；
// 3. 80% 只提醒一次/天，而且**返回时就落盘**（DSH 重启不能重弹）；
// 4. 额度文件坏掉时回落默认值，不能静默变成「不限」；
// 5. 旧日期的用量文件不能被当成今天继续算。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALERT_RATIO, DEFAULT_LIMITS, SCOPES, allRatios, collectAlerts, collectHits,
  describeHit, evaluateBudget, formatLimit, formatMoney, formatTokens, formatUsed,
  localDayKey, localDayStart, normalizeLimitPair, normalizeLimits, normalizeUsage,
  parseCnyText, parseTokenText, ratioOf, readAlert, readBudget, readDailyUsage,
  takeAlert, totalsOf, writeBudget, writeDailyUsage,
} from '../src/token-budget.js';

let failed = 0;
let passed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log(`✅ ${label}`); }
  else { failed += 1; console.error(`❌ ${label}`); }
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

// ── 1. 单位解析 ──────────────────────────────────────────────────────────
check(parseCnyText('¥8') === 8, '¥8 → 8 元');
check(parseCnyText('￥8.50') === 8.5, '￥8.50 → 8.5 元');
check(parseCnyText('8元') === 8, '8元 → 8 元');
check(parseCnyText(' 8 人民币 ') === 8, '带空格/人民币后缀也能解析');
check(parseCnyText('') === null, '空金额 = 不限');
check(parseCnyText('abc') === undefined, '非法金额返回 undefined（由 API 报错）');
check(parseCnyText('-1') === undefined, '负数金额被拒绝');
check(parseTokenText('8000000') === 8_000_000, '裸 token 数');
check(parseTokenText('8M') === 8_000_000, '8M → 8,000,000');
check(parseTokenText('8m') === 8_000_000, '大小写不敏感');
check(parseTokenText('8,000,000') === 8_000_000, '千分位');
check(parseTokenText('2万') === 20_000, '中文「万」');
check(parseTokenText('1.5亿') === 150_000_000, '中文「亿」');
check(parseTokenText('20M token') === 20_000_000, 'token 后缀');
check(parseTokenText('') === null, '空 token = 不限');
check(parseTokenText('8元') === undefined, 'token 框里填金额 → 拒绝（不能猜）');

check(normalizeLimitPair(8).cny === 8, '裸数字按人民币（历史 maxDailyCostCNY 语义）');
check(normalizeLimitPair({ value: '8M', unit: 'tokens' }).tokens === 8_000_000, '{value,unit} 单值形态');
check(normalizeLimitPair({ cny: 0, tokens: 0 }).cny === null, '0 = 不限，而不是「0 元额度」');
check(normalizeLimitPair({ cny: '¥3.5', tokens: '20M' }).cny === 3.5, '同一 scope 两种单位可并存');
assert.throws(() => normalizeLimitPair({ cny: 'abc' }), /无法识别人民币额度/, '非法额度字符串必须抛错，不能静默变不限');

// ── 2. 默认值与归一化 ────────────────────────────────────────────────────
const defaults = normalizeLimits(undefined);
check(defaults.qq.cny === 8 && defaults.qq.tokens === null, '默认 QQ ¥8（沿用已上线的花费闸）');
check(defaults.bili.cny === null && defaults.total.cny === null, 'B站 / 总额默认不限');
check(normalizeLimits({ qq: { tokens: '20M' } }).qq.tokens === 20_000_000, '自定义 token 额度');
check(normalizeLimits({ qq: { tokens: '20M' } }).bili.cny === null, '缺的 scope 不被误写成 0');

// ── 3. 用量合并 / 比例 / 拦截 ────────────────────────────────────────────
const usage = normalizeUsage({
  qq: { cost: 6.4, tokens: 8_000_000 },
  bili: { cost: 1.6, tokens: 2_000_000 },
  other: { cost: 0.2, tokens: 100_000 },
});
check(near(usage.total.cost, 8.2), '总额 = 三类之和（金额）');
check(usage.total.tokens === 10_100_000, '总额 = 三类之和（token）');
check(near(ratioOf(6.4, 8), 0.8), '80% 比例');
check(ratioOf(1, null) === null && ratioOf(1, 0) === null, '不限时没有比例');

const limits = normalizeLimits({
  qq: { cny: 8 },
  bili: { tokens: 5_000_000 },
  total: { cny: 10 },
});
const ratios = allRatios(usage, limits);
check(near(ratios.qq.cny, 0.8), 'QQ 金额比例 80%');
check(ratios.qq.tokens === null, 'QQ 未设 token 额度 → 比例 null');
check(near(ratios.bili.tokens, 0.4), 'B站 token 比例 40%');
check(near(ratios.total.cny, 0.82), '总额金额比例 82%');

const alerts = collectAlerts(usage, limits);
check(alerts.length === 2, `80% 命中 2 项（QQ 金额 + 总额金额），实得 ${alerts.length}`);
check(alerts[0].scope === 'total' && alerts[0].unit === 'cny', '按比例从高到低排序（总额 82% 在前）');
check(alerts.some((h) => h.scope === 'qq' && h.unit === 'cny'), 'QQ 80% 也在提醒列表里');
check(!alerts.some((h) => h.scope === 'qq' && h.unit === 'tokens'), '没设的 token 额度不产生提醒');
check(describeHit(alerts.find((h) => h.scope === 'qq')).includes('QQ：¥6.40 / ¥8.00（80.0%）'), '提醒文案含金额/上限/百分比');

const blocked = evaluateBudget(usage, limits, { scopes: ['qq', 'total'] });
check(blocked.blocked === false, '80% 只提醒，不拦截');
const webUsage = normalizeUsage({ web: { cost: 1.5, tokens: 200 }, other: { cost: 0.5, tokens: 50 } });
check(webUsage.web.tokens === 200 && webUsage.total.tokens === 250 && webUsage.total.cost === 2, '网页用量单独展示，只加一次到总额');
check(evaluateBudget(webUsage, normalizeLimits({ other: { tokens: 250 } }), { scopes: ['other'] }).blocked, '网页用量消耗其他渠道额度');
const overUsage = normalizeUsage({ qq: { cost: 8, tokens: 0 } });
const blockedOver = evaluateBudget(overUsage, limits, { scopes: ['qq', 'total'] });
check(blockedOver.blocked === true && blockedOver.scopes.qq === true, 'QQ 到 100% 拦截');
const totalOver = evaluateBudget(normalizeUsage({ qq: { cost: 5 }, bili: { cost: 5.01 } }), limits, { scopes: ['qq', 'total'] });
check(totalOver.blocked === true && totalOver.scopes.total === true, '总额到 100% 也拦截');
const biliOver = evaluateBudget(normalizeUsage({ bili: { tokens: 5_000_000 } }), limits, { scopes: ['bili', 'total'] });
check(biliOver.blocked === true && biliOver.scopes.bili === true, 'B站 token 到 100% 拦截');
check(evaluateBudget(normalizeUsage({}), { qq: { cny: null } }, { scopes: ['qq', 'total'] }).blocked === false, '不限额度时永不拦截');
check(collectHits(usage, limits, { threshold: 1.2 }).length === 0, '阈值高于当前比例时不命中');

// ── 4. 格式化 ────────────────────────────────────────────────────────────
check(formatMoney(8) === '¥8.00', '金额格式 ¥8.00');
check(formatMoney(1234.5) === '¥1,234.50', '金额千分位');
check(formatTokens(8_000_000) === '8,000,000', 'token 千分位');
check(formatLimit(8, 'cny') === '¥8.00' && formatLimit(null, 'cny') === '不限', '额度展示');
check(formatUsed(8_000_000, 'tokens') === '8,000,000 token', 'token 用量展示');

// ── 5. 本地自然日 ────────────────────────────────────────────────────────
const now = new Date('2026-10-23T15:00:00+08:00').getTime();
check(localDayKey(now) === '2026-10-23', '本地日 key 正确');
check(localDayStart(now) === new Date('2026-10-23T00:00:00+08:00').getTime(), '本地日 0 点正确');
check(localDayStart(now) < now, '0 点在当前时刻之前');

// ── 6. 文件读写 / 只提醒一次 / 跨天重置 ─────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-token-budget-'));
try {
  // 额度文件不存在：回默认 QQ ¥8
  check(readBudget(dir).qq.cny === 8, '文件不存在时回落默认 QQ ¥8');
  // 坏 JSON：仍回默认，不能变成不限
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'token-budget.json'), '{ broken json', 'utf8');
  check(readBudget(dir).qq.cny === 8, '坏 JSON 回落默认，不能静默变「不限」');
  fs.writeFileSync(path.join(dir, 'token-budget.json'), JSON.stringify({ limits: { qq: { cny: 'abc' } } }), 'utf8');
  check(readBudget(dir).qq.cny === 8, '坏额度字符串回落默认，不能静默变「不限」');

  const saved = writeBudget(dir, { qq: { cny: '¥5', tokens: '20M' }, bili: { tokens: '50M' }, total: { cny: 20 } });
  check(saved.qq.cny === 5 && saved.qq.tokens === 20_000_000, 'writeBudget 归一化并落盘');
  const reloaded = readBudget(dir);
  check(reloaded.qq.cny === 5 && reloaded.bili.tokens === 50_000_000 && reloaded.total.cny === 20, '重新读取额度一致');
  check(reloaded.other.cny === null, '未写的 scope 保持不限');

  writeDailyUsage(dir, { qq: { cost: 6.4, tokens: 8_000_000 }, bili: { cost: 1.6 }, other: { cost: 0.2 } }, { day: '2026-10-23' });
  const daily = readDailyUsage(dir, '2026-10-23');
  check(near(daily.qq.cost, 6.4) && near(daily.total.cost, 8.2), '当天用量文件读写正确');
  check(daily.stale === false, '当天文件不算 stale');
  const oldDay = readDailyUsage(dir, '2026-10-24');
  check(oldDay.stale === true && oldDay.qq.cost === 0 && oldDay.total.cost === 0, '旧日文件不被当成今天');

  // 80% 只提醒一次：第一次返回 alert，第二次同一天返回 null + existing
  const first = takeAlert(dir, usage, limits, now);
  check(Boolean(first.alert), '第一次到 80% 返回提醒');
  check(first.alert.items.length === 2 && first.alert.day === '2026-10-23', '提醒记录包含当天和命中项');
  const stored = readAlert(dir);
  check(stored?.day === '2026-10-23' && stored.items.length === 2, '提醒返回时已经落盘');
  const second = takeAlert(dir, usage, limits, now + 60_000);
  check(second.alert === null && second.existing?.day === '2026-10-23', '同一天第二次不再提醒，但能读出已提醒记录');
  const nextDay = takeAlert(dir, usage, limits, new Date('2026-10-24T09:00:00+08:00').getTime());
  check(Boolean(nextDay.alert), '跨天后可以重新提醒一次');

  // 同一天里先提醒 QQ、之后总额再到 80%：不再提醒
  fs.rmSync(path.join(dir, 'token-alert.json'), { force: true });
  const qqOnly = normalizeUsage({ qq: { cost: 6.5 } });
  const firstQq = takeAlert(dir, qqOnly, limits, now);
  check(Boolean(firstQq.alert) && firstQq.alert.items[0].scope === 'qq', '先由分项触发第一次提醒');
  const laterTotal = takeAlert(dir, usage, limits, now + 3600_000);
  check(laterTotal.alert === null, '同一天其他分项再到 80% 不再提醒（用户要求）');

  // 总额额度单独设置时也能触发
  fs.rmSync(path.join(dir, 'token-alert.json'), { force: true });
  const totalOnly = takeAlert(dir, normalizeUsage({ qq: { cost: 9 } }), normalizeLimits({ qq: { cny: null }, total: { cny: 10 } }), now);
  check(Boolean(totalOnly.alert) && totalOnly.alert.items[0].scope === 'total', '总额 80% 单独也能触发提醒');
  check(totalOnly.alert.items[0].ratio >= ALERT_RATIO, '提醒项比例 ≥ 80%');

  // 未达到 80%：不提醒、不写盘
  fs.rmSync(path.join(dir, 'token-alert.json'), { force: true });
  const low = takeAlert(dir, normalizeUsage({ qq: { cost: 1 } }), normalizeLimits({ qq: { cny: 8 } }), now);
  check(low.alert === null && !fs.existsSync(path.join(dir, 'token-alert.json')), '没到 80% 不写提醒文件');

  // totalsOf / normalizeUsage 的幂等性
  check(totalsOf(usage).tokens === usage.total.tokens, 'totalsOf 与 normalizeUsage 一致');
  check(SCOPES.length === 4 && DEFAULT_LIMITS.qq.cny === 8, '导出常量稳定');

  // 接线：宿主路由 / 插件服务 / 桥接 endpoint 三处必须都在，否则「额度页能改但不生效」
  const host = fs.readFileSync(path.join(import.meta.dirname, '..', 'plugins', 'surfcore', 'lib', 'index.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'bridge.js'), 'utf8');
  check(host.includes('createTokenBudgetService'), '宿主已创建 token 额度服务');
  check(host.includes('/token-budget'), '宿主已注册 /token-budget 路由');
  check(host.includes("ctx.on('session/event'"), '宿主已监听 session/event');
  check(bridge.includes("url.pathname === '/api/tokens/daily'"), '桥接已提供 /api/tokens/daily 诊断端点');
  check(bridge.includes('bridgeDailyUsage'), '桥接已合并当日用量');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n❌ token 额度测试失败：${passed} 通过 / ${failed} 失败`);
  process.exit(1);
}
console.log(`\n🎉 token 额度测试通过（${passed} 项）`);
