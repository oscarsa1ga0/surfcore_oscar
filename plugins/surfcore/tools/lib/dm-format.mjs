// dm-await 的文本输出排版。
//
// 她和 comment-digest / fans 犯的是同一个错：命令后面固定接 `| tail -2`。
// dm-await 原来的排版是「一行 DM_HIT 汇总 + 若干条明细」，tail 之后明细还在、
// 但「一共几条 / 是谁」被切掉；--any 模式下更是把前面几个人的消息整段丢掉。
//
// 规则：每条明细自带「谁 + 时间」，最后一行再压一句结论（共几条 + 最新时间 + 别截断）。

import { stampLocal } from './fans-format.mjs';

const clean = (value) => String(value ?? '').replace(/\n/g, ' ').slice(0, 200);

/** 一条新私信：`[18:39] 主人：正文 → 链接` */
export function dmItemLine({ name, ts, text, url }) {
  const time = stampLocal(ts).split(' ').pop() || '';
  const who = name ? `${name}：` : '';
  return `  [${time}] ${who}${clean(text)}${url ? ` → ${url}` : ''}`;
}

/**
 * 结尾结论行：即使被 tail -1 截断，也知道「有几条、谁发的、最新什么时候」。
 * @param {Array<{name?:string, ts?:number}>} items
 * @param {string} hint 额外提示（例如"别用 tail 截断"）
 */
export function dmSummaryLine(items = [], hint = '') {
  const list = items.filter(Boolean);
  if (!list.length) return '新私信 0 条';
  const byWho = new Map();
  for (const item of list) {
    const who = item.name || '未知';
    byWho.set(who, (byWho.get(who) || 0) + 1);
  }
  const whoText = [...byWho.entries()].map(([who, n]) => `${who}（${n} 条）`).join('、');
  const latest = Math.max(...list.map((item) => Number(item.ts) || 0));
  const time = latest ? stampLocal(latest).split(' ').pop() : '';
  return `共 ${list.length} 条新私信：${whoText}${time ? ` ｜ 最新 ${time}` : ''}${hint ? ` ｜ ${hint}` : ''}`;
}
