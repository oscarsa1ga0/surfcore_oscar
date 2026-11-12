/**
 * 早安问候排程回归（2026-10-23 用户反馈「早上八点问候没成功」）。
 *
 * 两个真实失败点，都必须有断言钉住：
 *   1. **错过就丢**：桥接正好在 08:00:00 重启 → 启动时 `08:00 <= now` 直接排到明天；
 *      现在要求：在补发窗口（3 小时）内要补发，DSH 离线/投递失败要 10 分钟后重试；
 *   2. **reserved2 只输出文字等于没发**：那个模式下纯文本不会自动转发，
 *      提示词必须让她真的调 qq_send_private_message。
 *
 * 纯函数测试，不连 DSH / QQ。
 * 运行：node scripts/test-greeting.mjs
 */
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  GREETING_GRACE_MS, GREETING_RETRY_MS,
  buildMorningGreetingPrompt, localDateKey, parseGreetingTime, pickGreetingTheme, planMorningGreeting,
} from '../src/greeting-schedule.js';

let failures = 0;
function test(name, run) {
  try { run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
}

const at = (h, m = 0, day = 23) => new Date(2026, 9, day, h, m, 0, 0).getTime();

test('时间解析：8:00 / 08:00 等价，非法值回 08:00', () => {
  assert.deepEqual(parseGreetingTime('8:00'), { hh: 8, mm: 0, text: '08:00' });
  assert.deepEqual(parseGreetingTime('08:05'), { hh: 8, mm: 5, text: '08:05' });
  assert.equal(parseGreetingTime('99:99').text, '23:59');
  assert.equal(parseGreetingTime('nope').text, '08:00');
  assert.equal(parseGreetingTime(undefined).text, '08:00');
});

test('没到点：准点排程', () => {
  const plan = planMorningGreeting({ now: at(7, 0), hh: 8, mm: 0, sentToday: false });
  assert.equal(plan.mode, 'scheduled');
  assert.equal(plan.fireAt, at(8, 0));
});

test('过了点但在窗口内且今天没发：补发（这就是 08:00 重启那次）', () => {
  const plan = planMorningGreeting({ now: at(8, 0), hh: 8, mm: 0, sentToday: false });
  assert.equal(plan.mode, 'catchup', '08:00:00 正好重启时必须补发，不能排到明天');
  assert.ok(plan.fireAt <= at(8, 0) + 10_000, '补发应马上尝试');
  const later = planMorningGreeting({ now: at(10, 30), hh: 8, mm: 0, sentToday: false });
  assert.equal(later.mode, 'catchup', '3 小时窗口内仍可补发');
});

test('超过补发窗口：排明天', () => {
  const plan = planMorningGreeting({ now: at(8, 0) + GREETING_GRACE_MS + 1000, hh: 8, mm: 0, sentToday: false });
  assert.equal(plan.mode, 'tomorrow');
  assert.equal(plan.fireAt, at(8, 0, 24));
});

test('今天已经发过：不再补发，排明天', () => {
  const plan = planMorningGreeting({ now: at(9, 0), hh: 8, mm: 0, sentToday: true });
  assert.equal(plan.mode, 'tomorrow');
  assert.equal(plan.fireAt, at(8, 0, 24));
});

test('投递失败的重试：10 分钟后，且不会越过补发窗口', () => {
  const plan = planMorningGreeting({ now: at(8, 5), hh: 8, mm: 0, sentToday: false, retryDelayMs: GREETING_RETRY_MS });
  assert.equal(plan.mode, 'retry');
  assert.equal(plan.fireAt, at(8, 5) + GREETING_RETRY_MS);
  const late = planMorningGreeting({
    now: at(8, 0) + GREETING_GRACE_MS - 60_000,
    hh: 8, mm: 0, sentToday: false, retryDelayMs: GREETING_RETRY_MS,
  });
  assert.equal(late.mode, 'retry');
  assert.ok(late.fireAt <= at(8, 0) + GREETING_GRACE_MS, '重试不能越过窗口，否则第二天才发就离谱了');
});

test('跨天：昨天发过不影响今天', () => {
  const plan = planMorningGreeting({ now: at(8, 0, 24), hh: 8, mm: 0, sentToday: false });
  assert.equal(plan.mode, 'catchup');
  assert.equal(localDateKey(at(8, 0, 24)), '2026-10-24');
});

test('主题轮换：随机 0 取第一条，1 也能正常取', () => {
  assert.equal(pickGreetingTheme(() => 0), '赖床');
  assert.equal(pickGreetingTheme(() => 0.999999), '今天想去哪玩');
  assert.equal(pickGreetingTheme(() => 0.5), '天气冷不冷');
});

test('reserved2 提示词必须要求真调发送工具（只输出文字等于没发）', () => {
  const prompt = buildMorningGreetingPrompt({
    who: '测试对象', uin: '3362299430', time: '08:00', theme: '赖床', mode: 'reserved2',
    token: 'abc123token',
  });
  assert.match(prompt, /qq_send_private_message/);
  assert.match(prompt, /3362299430/);
  assert.match(prompt, /token 填 abc123token/, 'reserved2 的发送工具要带会话令牌');
  assert.match(prompt, /纯文本不会自动发到 QQ/);
  assert.match(prompt, /1~2 句/);
});

test('chat 模式提示词：直接输出即可', () => {
  const prompt = buildMorningGreetingPrompt({ who: '测试对象', uin: '123456', time: '08:00', theme: '阳光', mode: 'chat' });
  assert.match(prompt, /直接输出要发的话/);
  assert.ok(!prompt.includes('qq_send_private_message'), 'chat 模式不需要让她调工具');
});

test('补发提示词要说明这是补发，且不让她以为现在是八点', () => {
  const prompt = buildMorningGreetingPrompt({ who: '测试对象', uin: '123456', time: '08:00', theme: '阳光', mode: 'reserved2', catchUp: true });
  assert.match(prompt, /补发/);
  assert.match(prompt, /原定 08:00/);
});

const h = await bridgeHarness({ config: { snowluma: { provider: 'onebot' } } });
try {
  let list = [];
  let queried = [];
  h.bot.raw = async (action, params) => {
    assert.equal(action, 'get_friend_list');
    queried.push(params);
    return list;
  };
  assert.equal((await h.greetingFriendCheck('123')).ok, false);
  list = [{ user_id: 123 }];
  assert.equal((await h.greetingFriendCheck('123')).ok, true, '空好友名单不阻挡恢复后的真实好友');

  list = [{ user_id: 456 }];
  h.setAccountOnline(false, 'fixture');
  h.setAccountOnline(true, 'fixture');
  assert.equal((await h.greetingFriendCheck('456')).ok, true, '账号重新上线后重新读取列表');

  list = [{ user_id: 123 }];
  assert.equal((await h.greetingFriendCheck('123', { refresh: true })).ok, true);
  assert.equal(queried.at(-1).no_cache, true, '手动试发时刷新网关的好友列表');
  console.log('PASS 重连与手动试发刷新好友名单');
} finally {
  await h.close();
}

if (failures) process.exitCode = 1;
console.log(failures ? `\n${failures} 项失败` : '\ngreeting tests OK');
