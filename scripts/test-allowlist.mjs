// 回归：白名单归一化 + 启动补唤醒挑选（2026-10-31 用户反馈）
// 现象1：allow.private 只有机器人自己的号 → 主人私信被忽略；
// 现象2：install-apply 用 [owner] 整体替换 → 用户加的白名单被冲掉；
// 现象3：桥接重启后积压 unread 不触发唤醒。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeAllowlist, pickBacklogSessions } from '../src/allowlist.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label} ${extra}`); }
};

const OWNER = '1609302529';
const SELF = '2708810079';
const FRIEND = '2602648498';

// 1) 事故现场：私聊白名单只有机器人自己 → 必须换成主人，并给出警告
{
  const r = normalizeAllowlist({ allow: { private: [SELF], groups: [] }, ownerQQ: OWNER, selfUserId: SELF });
  ok(JSON.stringify(r.allow.private) === JSON.stringify([Number(OWNER)]), '移除机器人自己并补上主人', JSON.stringify(r.allow));
  ok(r.changed === true, '发生修正 → changed=true');
  const codes = r.warnings.map((w) => w.code);
  ok(codes.includes('ALLOW_SELF_REMOVED') && codes.includes('ALLOW_OWNER_ADDED'), '两类警告都有', codes.join(','));
}

// 2) 用户已有白名单：保留，只追加主人（install-apply 事故）
{
  const r = normalizeAllowlist({ allow: { private: [FRIEND], groups: [175982093] }, ownerQQ: OWNER, selfUserId: SELF });
  ok(r.allow.private[0] === Number(FRIEND), '保留用户加的人', JSON.stringify(r.allow.private));
  ok(r.allow.private.includes(Number(OWNER)), '同时补上主人');
  ok(r.allow.groups.length === 1 && r.allow.groups[0] === 175982093, '群白名单不变');
}

// 3) 幂等：同一份再跑一次不应再变
{
  const once = normalizeAllowlist({ allow: { private: [FRIEND], groups: [] }, ownerQQ: OWNER, selfUserId: SELF });
  const twice = normalizeAllowlist({ allow: once.allow, ownerQQ: OWNER, selfUserId: SELF });
  ok(twice.changed === false, '第二次运行 changed=false', JSON.stringify(twice));
  ok(twice.warnings.length === 0, '第二次无警告');
}

// 4) 去重 / 非法值 / 群里的机器人自己
{
  const r = normalizeAllowlist({ allow: { private: [FRIEND, FRIEND, 'abc', '123'], groups: [SELF, 175982093] }, ownerQQ: OWNER, selfUserId: SELF });
  ok(r.allow.private.filter((x) => x === Number(FRIEND)).length === 1, '私聊去重');
  ok(!r.allow.private.includes(NaN) && r.allow.private.every((x) => Number.isFinite(x)), '丢掉非法值');
  ok(!r.allow.groups.includes(Number(SELF)), '群白名单移除机器人自己');
}

// 5) 没配置主人：只清理自己，不瞎补
{
  const r = normalizeAllowlist({ allow: { private: [SELF, FRIEND], groups: [] }, ownerQQ: '', selfUserId: SELF });
  ok(JSON.stringify(r.allow.private) === JSON.stringify([Number(FRIEND)]), '没有主人时只移除自己', JSON.stringify(r.allow.private));
}

// 6) 补唤醒挑选：允许范围内、有未读、没有待发定时器
{
  const entries = [
    ['group:1', { unread: [{ seq: 1 }, { seq: 2 }], pendingWakeTimer: null }],
    ['group:2', { unread: [], pendingWakeTimer: null }],
    ['group:3', { unread: [{ seq: 3 }], pendingWakeTimer: setTimeout(() => {}, 1000) }],
    ['private:9', { unread: [{ seq: 4 }] }],
  ];
  const list = pickBacklogSessions(entries, { isAllowed: (k) => k !== 'private:9' });
  ok(list.length === 1 && list[0].key === 'group:1', '只挑允许范围内的积压会话', JSON.stringify(list));
  ok(list[0].unread === 2, '带上未读数');
  for (const [, st] of entries) if (st.pendingWakeTimer) clearTimeout(st.pendingWakeTimer);
}

// 7) 接线：桥接必须调用自愈 + 补唤醒；三处写入必须用归一化
{
  const bridge = fs.readFileSync(path.resolve('src/bridge.js'), 'utf8');
  ok(bridge.includes('reconcileAllowlist'), '桥接启动自愈接线');
  ok(bridge.includes('wakeBacklogConversations'), '桥接启动补唤醒接线');
  ok(bridge.includes("normalizeAllowlist({ allow, ownerQQ, selfUserId })"), '控制台白名单保存也归一化');
  const index = fs.readFileSync(path.resolve('plugins/surfcore/lib/index.js'), 'utf8');
  ok(!index.includes('normalizeAllowlist'), '网页宿主不再写入 QQ 白名单');
  ok(!/const priv = owner \\? \\[owner\\]/.test(index), 'install-apply 不再用 [owner] 整体替换');
  const guard = fs.readFileSync(path.resolve('src/token-guard.js'), 'utf8');
  ok(guard.includes('msUntilNextLocalDay'), 'day 拦截给出到零点的 retryAfterMs');
}

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n✅ test-allowlist 通过');
