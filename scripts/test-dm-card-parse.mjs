// B站私信卡片：content 是 JSON 时不能只取文字，jump_url 也得带出来。
// 事故：2026-11-15 主人私信分享了一条视频，dm-await 只给了标题，她两次都没看到，
// 最后手动翻消息接口才补看回来（她自己的日记里记了这个坑）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDmContent, normalizeCardUrl } from '../plugins/surfcore/tools/lib/dm-content.mjs';

const cases = [
  {
    name: '纯文本',
    raw: '在吗',
    want: { text: '在吗', url: '' },
  },
  {
    name: '普通文本 JSON',
    raw: '{"content":"在吗"}',
    want: { text: '在吗', url: '' },
  },
  {
    name: 'BV 富文本节点',
    raw: JSON.stringify({
      type: 'RICH_TEXT_NODE_TYPE_BV',
      jump_url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
      rid: 'BV1xx411c7mD',
      text: '字幕君交流场所',
    }),
    want: { text: '字幕君交流场所', url: 'https://www.bilibili.com/video/BV1xx411c7mD/' },
  },
  {
    name: '分享卡片：标题 + 协议相对 URL',
    raw: JSON.stringify({ title: '【4K】如果聊天窗口就是她的整个世界', jump_url: '//www.bilibili.com/video/BV1abc411c7mD' }),
    want: { text: '【4K】如果聊天窗口就是她的整个世界', url: 'https://www.bilibili.com/video/BV1abc411c7mD' },
  },
  {
    name: 'JSON 套 JSON',
    raw: JSON.stringify({ content: JSON.stringify({ title: '嵌套卡片', jump_url: '/video/BV1xx411c7mD' }) }),
    want: { text: '嵌套卡片', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
  },
  {
    name: '只有 rid 也要能拼出地址',
    raw: JSON.stringify({ rid: 'BV1xx411c7mD', text: '只有编号' }),
    want: { text: '只有编号', url: 'https://www.bilibili.com/video/BV1xx411c7mD/' },
  },
  {
    name: '数组节点：地址在第一个、文字在第二个',
    raw: JSON.stringify({ content: [{ jump_url: 'https://www.bilibili.com/video/BV1xx411c7mD' }, { content: '两个节点' }] }),
    want: { text: '两个节点', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
  },
  {
    name: '图片消息：占位 + 拿得到图地址',
    raw: JSON.stringify({ url: 'https://message.biliimg.com/bfs/im_new/a.png' }),
    want: { text: '[图片]', url: 'https://message.biliimg.com/bfs/im_new/a.png' },
  },
  {
    name: '卡片没有标题时给占位',
    raw: JSON.stringify({ jump_url: 'https://www.bilibili.com/video/BV1xx411c7mD/' }),
    want: { text: '[卡片]', url: 'https://www.bilibili.com/video/BV1xx411c7mD/' },
  },
  {
    name: '坏 JSON 原样保留',
    raw: '{"content": ',
    want: { text: '{"content": ', url: '' },
  },
];

for (const item of cases) {
  const got = parseDmContent(item.raw);
  assert.equal(got.text, item.want.text, `${item.name} · text`);
  assert.equal(got.url, item.want.url, `${item.name} · url`);
}

assert.equal(normalizeCardUrl('//www.bilibili.com/x'), 'https://www.bilibili.com/x');
assert.equal(normalizeCardUrl('/video/BV1'), 'https://www.bilibili.com/video/BV1');
assert.equal(normalizeCardUrl('https://b23.tv/x'), 'https://b23.tv/x');
assert.equal(normalizeCardUrl(''), '');

// 接线回归：dm-await 的两条输出路径都得带 url，不能再只打印 text。
const cli = fs.readFileSync('plugins/surfcore/tools/commands/dm-await.mjs', 'utf8');
assert.match(cli, /import \{ parseDmContent \} from '\.\.\/lib\/dm-content\.mjs'/, 'dm-await 没接 dm-content');
assert.match(cli, /url: info\.url/, 'items 没带 url');
const dmFormat = fs.readFileSync('plugins/surfcore/tools/lib/dm-format.mjs', 'utf8');
assert.match(cli, /dmItemLine\(\{ name: it\.name, ts: it\.ts, text: it\.text, url: it\.url \}\)/, '--any 输出没走 dmItemLine');
assert.match(cli, /dmItemLine\(\{ name: OWNER_NAME, ts: m\.ts, text: m\.text, url: m\.url \}\)/, 'owner 模式逐条输出没走 dmItemLine');
assert.match(dmFormat, /url \? ` → \$\{url\}`/, 'dmItemLine 没带 url');
assert.doesNotMatch(cli, /text: parsed\(last\.content\)/, '还在把 parsed() 的结果当字符串用');

console.log('✅ B站私信卡片解析通过');
