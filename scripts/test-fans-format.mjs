// fans 输出排版：结论必须在最后一行（她习惯 | tail -2 截断）。
// 事故：2026-11-17 06:11 第三位粉丝被发现、水位前移，但 tail -2 只留下「水位：…」。
import assert from 'node:assert/strict';
import { renderFansOutput, stampLocal } from '../plugins/surfcore/tools/lib/fans-format.mjs';

const fan = { mid: '443557215', name: '两只沈梦溪-_-_', time: 1794825551 };
const old = { mid: '359455452', name: 'ppMaxxxx', time: 1794638834 };
const owner = { mid: '353782040', name: 'oscarsaigao', time: 1794400000 };

// 1) 有新粉丝：最后一行必须自解释（谁 + 时间 + 水位）
{
  const lines = renderFansOutput({ follower: 3, following: 5, list: [fan, old, owner], fresh: [fan], ownerMid: owner.mid, lastSeen: old.time, newOnly: true });
  const last = lines[lines.length - 1];
  assert.ok(last.includes('新粉丝 1 个'), last);
  assert.ok(last.includes('两只沈梦溪'), '最后一行要有名字：' + last);
  assert.ok(/水位 \d+/.test(last), '最后一行要有水位：' + last);
  // 模拟 tail -2：结论仍可见
  assert.ok(lines.slice(-2).join('\n').includes('两只沈梦溪'));
  // 模拟 tail -1：仍然是结论
  assert.ok(lines.slice(-1).join('\n').includes('两只沈梦溪'));
}

// 2) 没有新粉丝：一行说清
{
  const lines = renderFansOutput({ follower: 2, following: 4, list: [old, owner], fresh: [], ownerMid: owner.mid, lastSeen: old.time, newOnly: true });
  assert.equal(lines.length, 2);
  assert.match(lines[1], /没有新粉丝 ｜ 水位 1794638834/);
}

// 3) 全量：主人标记保留、水位在最后
{
  const lines = renderFansOutput({ follower: 3, following: 5, list: [fan, old, owner], fresh: [], ownerMid: owner.mid, lastSeen: 0, newOnly: false });
  assert.ok(lines.some((l) => l.includes('[主人]')));
  assert.match(lines[lines.length - 1], /水位：1794825551/);
}

// 4) 时间格式：本地时间、不是 UTC
{
  const s = stampLocal(fan.time);
  assert.ok(s.includes('2026'), s);
  assert.ok(s.includes('18:39'), '本地应为 18:39：' + s);
}

console.log('✅ fans 输出排版测试通过');
