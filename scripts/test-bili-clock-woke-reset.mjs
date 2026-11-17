// 回归：state.woke 不能把当晚的第二个 wake 槽饿死。
// 11-17 22:52 晚场没醒：06:10 醒过之后 woke=true 一直没复位，tick 每分钟重判「今天已醒」→
// 调 night plan → nextPendingSlot 把 at 推到 now+1 → 永远到不了真正的 wake 分支。
import assert from 'node:assert/strict';
import fs from 'node:fs';

const night = fs.readFileSync('plugins/surfcore/tools/commands/whale-night.mjs', 'utf8');
const scheduler = fs.readFileSync('plugins/surfcore/lib/scheduler.js', 'utf8');

// 1) 排下一个 slot 时必须复位 woke
assert.match(night, /action: slot\.action,[\s\S]{0,400}?woke: false,/, 'planFromSlot 必须在推进 slot 时把 woke 复位');

// 2) tick 的重排条件：有 slotId 时以 slot.status 为准，不能再看 woke
assert.match(
  scheduler,
  /if \(!st \|\| st\.date !== t \|\| \(st\.woke === true && !st\.slotId\)/,
  'tick 的重排条件必须只对没有 slotId 的旧格式看 woke',
);

console.log('✅ 生物钟 woke 复位回归通过');
