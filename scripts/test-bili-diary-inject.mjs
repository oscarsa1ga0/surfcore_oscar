// B站日记注入 QQ：只取当天段落 + 预算「从最新往回装」（2026-11-16）。
// 事故：6000 字上限按从前往后截，刚写的第 44 条落在 7484 字处，被切掉。
import assert from 'node:assert/strict';
import {
  extractDaySegments, trimNewestFirst, composeDiaryInjection,
} from '../src/bili-diary-inject.js';

const diary = [
  '## 2026-11-15',
  '昨天的总标题内容。',
  '### 一、昨天的条目（2026-11-15 10:00）',
  '昨天的事。',
  '### 二、今天的旧条目（2026-11-16 09:00）',
  '今天早上写的。',
  '### 三、今天的新条目（2026-11-16 23:20）',
  '刚刚写的，不该被截掉。',
].join('\n');

// 1) 只抽当天
{
  const segs = extractDaySegments(diary, '2026-11-16');
  assert.equal(segs.length, 2, '只保留今天的两个段落');
  assert.ok(segs[0].includes('今天的旧条目'));
  assert.ok(segs[1].includes('今天的新条目'));
  assert.ok(!segs.join('\n').includes('昨天的事'), '昨天的不该进来');
  assert.ok(segs.every((seg) => seg.startsWith('###')), '段落要保留标题行');
}

// 2) 预算不够时丢最老的，保留最新的
{
  const older = 'A'.repeat(100);
  const newer = 'B'.repeat(100);
  const out = trimNewestFirst([older, newer], 150);
  assert.equal(out, newer, '只该留下最新的那段');
  assert.ok(out.length <= 150);
}

// 3) 预算够时两个都在，且顺序是旧 → 新
{
  const out = trimNewestFirst(extractDaySegments(diary, '2026-11-16'), 2000);
  assert.ok(out.indexOf('今天的旧条目') < out.indexOf('今天的新条目'), '保持时间顺序');
}

// 4) 单段就超预算：保留它的尾部（最新写的那部分）
{
  const long = `### 四十四、长条目（2026-11-16 23:20）\n${'x'.repeat(900)}尾部这句要留下`;
  const out = trimNewestFirst([long], 300);
  assert.ok(out.length <= 300);
  assert.ok(out.endsWith('尾部这句要留下'), '超长段落应保留尾部');
}

// 5) 多文件拼接：按文件顺序，整体仍从最新往回装
{
  const a = '### A（2026-11-16 08:00）\n公开日记的内容';
  const b = '### B（2026-11-16 20:00）\n私人日记的内容';
  const out = composeDiaryInjection([a, b], '2026-11-16', 2000);
  assert.ok(out.includes('公开日记'));
  assert.ok(out.includes('私人日记'));
  const narrow = composeDiaryInjection([a, b], '2026-11-16', 50);
  assert.ok(!narrow.includes('公开日记'), '预算紧时先丢靠前的（较老的）');
}

// 6) 没有当天段落 → 空串，不报错
{
  assert.equal(composeDiaryInjection([diary], '2026-01-01', 6000), '');
  assert.equal(extractDaySegments('没有标题的纯文本', '2026-11-16').length, 0);
}

console.log('✅ B站日记注入测试通过');
