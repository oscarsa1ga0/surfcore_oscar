// dm-await 文本输出：每条自带「谁+时间」，最后一行给结论（防止 tail 截断后什么都不知道）。
import assert from 'node:assert/strict';
import { dmItemLine, dmSummaryLine } from '../plugins/surfcore/tools/lib/dm-format.mjs';

// 1) 明细行：时间、发送人、正文、链接都要在
{
  const line = dmItemLine({ name: '主人', ts: 1794825551, text: '看看这个', url: 'https://www.bilibili.com/video/BV1xx411c7mD/' });
  assert.match(line, /\[\d{2}:\d{2}(:\d{2})?\]/, line);
  assert.ok(line.includes('主人：'), line);
  assert.ok(line.includes('看看这个'));
  assert.ok(line.includes('BV1xx411c7mD'));
}

// 2) 结论行：条数 + 谁 + 最新时间 + 提示
{
  const items = [
    { name: '主人', ts: 1794825551 },
    { name: '主人', ts: 1794825600 },
    { name: '小明', ts: 1794825700 },
  ];
  const line = dmSummaryLine(items, '别用 tail 截断');
  assert.ok(line.startsWith('共 3 条新私信'), line);
  assert.ok(line.includes('主人（2 条）') && line.includes('小明（1 条）'), line);
  assert.ok(/\d{2}:\d{2}/.test(line), line);
  assert.ok(line.includes('别用 tail 截断'));
}

// 3) 空列表
assert.equal(dmSummaryLine([]), '新私信 0 条');

// 4) 换行压平（避免一条消息把排版撑坏）
assert.ok(!dmItemLine({ name: 'a', ts: 0, text: '第一行\n第二行' }).includes('\n'));

console.log('✅ dm 输出排版测试通过');
