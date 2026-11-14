// B站记忆 / 分享池 / 动态格式的离线测试。
//
// 重点不是“生成得漂亮”，而是三条硬约束：
//   1. 私信内容不进记忆（不读 dm-*.json；日记里转述私信的段落整段丢弃）。
//   2. 「B站的测试肥鱼」被明确写成“我自己”，不能当成别人。
//   3. 分享池不碰政治 / 娱乐圈。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBiliMemory, isBlockedContent } from '../src/bili-memory.js';
import { buildSharePrompt } from '../src/bili-share-scheduler.js';
import { formatDynamicMessage } from '../src/bili-dynamics.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
// 2026-11 起记忆输出在角色目录（activePlatformStateDir），旧版写仓库 state/。
// 测试用临时 stateDir 隔离输出；账本输入优先读当前角色的 biliDir，缺角色时回退仓库 state。
const { currentCharacter } = await import('../plugins/surfcore/tools/lib/state-paths.mjs');
const characterBili = currentCharacter()?.biliDir ?? null;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-memory-test-'));
if (fs.existsSync(path.join(ROOT, 'state', 'bili-dynamics-cache.json'))) {
  fs.copyFileSync(path.join(ROOT, 'state', 'bili-dynamics-cache.json'), path.join(STATE, 'bili-dynamics-cache.json'));
}

const memory = createBiliMemory({ stateDir: STATE, biliDir: characterBili, log: () => {} });
const stats = await memory.refresh({ force: true });
assert.equal(stats.ok, true, `记忆生成失败：${stats.error ?? ''}`);

const doc = fs.readFileSync(path.join(STATE, 'bili-memory.md'), 'utf8');
const brief = fs.readFileSync(path.join(STATE, 'bili-memory-brief.md'), 'utf8');
const index = JSON.parse(fs.readFileSync(path.join(STATE, 'bili-memory.json'), 'utf8'));

assert.ok(brief.length >= 800 && brief.length <= 2800, `简报长度异常：${brief.length}`);
assert.match(brief, /我的 B 站账号叫「[^」]+」/, '简报缺少 B 站账号名');
assert.ok(brief.includes('就是**我本人**') || brief.includes('就是我本人'), '简报没有明确“B站账号就是我本人”');
assert.ok(brief.includes('QQ 和 B 站是同一个人'), '简报没有说明两个身份是同一个人');
// 「认得出自己」必须有可核对的锚点：群友经常直接甩一张 B 站主页截图进群，
// 只写「账号叫测试肥鱼」不够——模型看到图里那一串数字/空间地址才能对上号。
assert.ok(brief.includes('我自己的 B 站主页'), '简报缺少「我自己的 B 站主页」锚点，截图里认不出自己');
assert.ok(/space\.bilibili\.com\/\d+/.test(brief), '简报没有给出自己的 B 站空间地址');
assert.ok(brief.includes('那就是**我自己**'), '简报没有写「图里出现这个昵称/头像就是我自己」');
assert.ok(brief.includes('这是 wo'), '简报没有给出认出自己时的说法');

// 角色卡是用户内容（每张卡叫什么、写不写 B站 由用户定），这里不做具体断言：
// 身份认知由上面自动生成的简报保证；角色卡只在本机用户自己维护。

// 私信原句 / 陌生人身份 / owner 的 B 站昵称都不应出现在注入文本里。
const forbidden = [
  '我是谁！', '我是谁呀', '喂喂喂，听得到吗', '看5个！', '怎么不回我？',
  '我是zzx', '454375791', '42951042', '测试B站昵称', '看视频的你，会有什么感觉',
  '不干活就不给你大米饭吃', '那看视频的你会有什么感觉',
];
const combined = `${doc}\n${brief}\n${JSON.stringify(index)}`;
for (const needle of forbidden) {
  assert.ok(!combined.includes(needle), `疑似私信内容泄漏：${needle}`);
}
assert.ok(!/mid\s*\d{5,}/i.test(brief), '简报不应包含陌生人 mid');
// 章节标题会写「不涉及私信」；只在正文行上检查转述，避免标题自触发。
const docBody = doc.split('\n').filter((line) => !line.trimStart().startsWith('##')).join('\n');
assert.ok(!/私信[^。]{0,40}(说|发|回)/.test(docBody), '长记忆里出现了私信转述');

// 分享池：数量、类型、政治/娱乐圈过滤。
const shareable = index.entries.filter((e) => e.shareable);
assert.ok(shareable.length >= 8, `可分享素材不足：${shareable.length}`);
for (const e of shareable) {
  assert.notEqual(e.type, 'dynamic', '动态已由动态同步负责，不应重复作为分享卡');
  assert.ok(!isBlockedContent(`${e.title} ${e.text} ${e.quote}`), `分享池混入敏感内容：${e.title}`);
  assert.ok((e.url || '').includes('bilibili.com/video/'), `分享卡缺少视频链接：${e.title}`);
}

// 用临时 state 模拟“一天 8 个时间点依次分享”：每次记录已用，下一次必须拿不同的。
const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-share-pick-'));
fs.copyFileSync(path.join(STATE, 'bili-memory.json'), path.join(tmpState, 'bili-memory.json'));
const pickMemory = createBiliMemory({ stateDir: tmpState, log: () => {} });
const picks = [];
for (let i = 0; i < 8; i += 1) {
  const card = pickMemory.pickShareCard({ slotIndex: i, dateKey: '2026-10-22' });
  assert.ok(card, `第 ${i} 个时间点没有可分享素材`);
  picks.push(card.id);
  pickMemory.recordShare(card.id, `2026-10-22 ${i}`);
  assert.ok(!isBlockedContent(`${card.title} ${card.text} ${card.quote}`), 'pickShareCard 返回了敏感素材');
}
fs.rmSync(tmpState, { recursive: true, force: true });
assert.equal(new Set(picks).size, 8, `一天 8 个时间点重复太多：${new Set(picks).size} 个不同素材`);

// 检索：问到具体视频要能捞到；闲聊不要硬塞。
const r1 = memory.recallBlock('你还记得B站那个杀戮尖塔大肥鱼mod吗');
assert.ok(r1.includes('杀戮尖塔') || r1.includes('大肥鱼'), '检索没有命中杀戮尖塔视频');
// 用当前记忆里真实存在的视频标题做检索断言（不同机器的数据不同，不写死作者数据）。
const sampleVideo = index.entries
  .filter((e) => e.type === 'video' && e.title && e.title.length >= 4 && !isBlockedContent(e.title))
  .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))[0];
if (sampleVideo) {
  const r2 = memory.recallBlock(`B站那个视频《${sampleVideo.title}》你还记得吗`);
  assert.ok(r2.includes(sampleVideo.title.slice(0, Math.min(6, sampleVideo.title.length))), `检索没有命中视频：${sampleVideo.title}`);
} else {
  console.warn('（跳过检索断言：当前记忆里没有视频条目）');
}
const r3 = memory.recallBlock('今天吃什么');
assert.equal(r3, '', '普通闲聊不应触发 B 站记忆检索');

// 分享提示词：包含标题/链接，且强调 50~100 字与“你自己的口吻”。
const prompt = buildSharePrompt(shareable[0], '07:00');
assert.ok(prompt.includes(shareable[0].title), '分享提示词缺少素材标题');
assert.ok(prompt.includes('50~100 字'), '分享提示词缺少字数要求');
assert.ok(prompt.includes('你自己的口吻'), '分享提示词缺少口吻要求');
const cardPrompt = buildSharePrompt(shareable[0], '07:00', { cardSent: true });
assert.ok(cardPrompt.includes('已经由系统发到群里'), '分享已发时提示词没有说明状态');
assert.ok(cardPrompt.includes('不要再发链接'), '分享已发时提示词仍要求带链接');
assert.ok(!cardPrompt.includes('先用一句话说清是什么'), '卡片已发时不应再要求复述标题');
assert.ok(shareable.some((e) => e.pic), '分享卡缺少封面（pic）');

// 动态同步消息格式。
const dyn = formatDynamicMessage({ text: '今天刷到一条好玩的 mer。', url: 'https://t.bilibili.com/123' });
assert.ok(dyn.includes('【B站动态】') && dyn.includes('今天刷到一条好玩的') && dyn.includes('https://t.bilibili.com/123'));

console.log('✅ B站记忆测试通过');
console.log(`   记忆 ${stats.entries} 条 / 可分享 ${stats.shareable} 条 / 简报 ${brief.length} 字 / 长记忆 ${doc.length} 字`);
console.log(`   8 个时间点素材：${new Set(picks).size} 个不同`);
