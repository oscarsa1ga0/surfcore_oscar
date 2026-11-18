// 上次收尾记录（对应 QQ 的 closure record）：收在哪儿、下次怎么接、冷却期、重新开口时间。
import fs from 'node:fs';
import path from 'node:path';

export const COOLDOWN_MS = 20 * 60 * 1000;

export function readClosure(file) {
  try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); return data && data.at ? data : null; } catch { return null; }
}

function save(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
}

export function writeClosure(file, { reason = 'natural', summary = '', nextOpening = '' } = {}) {
  const at = Date.now();
  const record = {
    at, reason,
    summary: String(summary ?? '').slice(0, 160),
    nextOpening: String(nextOpening ?? '').slice(0, 120),
    cooldownUntil: at + COOLDOWN_MS,
  };
  save(file, record);
  return record;
}

/** 她收尾后，主人又开口：冷却期内标记 reopenedAt（对应 QQ 的 reopenedAt）。 */
export function markReopened(file) {
  const record = readClosure(file);
  if (!record) return null;
  if (Date.now() > Number(record.cooldownUntil || record.at + COOLDOWN_MS)) return record;
  record.reopenedAt = Date.now();
  save(file, record);
  return record;
}

const minutesAgo = (ms) => {
  const minutes = Math.round(ms / 60000);
  if (minutes <= 0) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  return Math.round(minutes / 60) + ' 小时前';
};

/** 和 QQ 的 formatClosureRecord 同一套措辞。 */
export function formatClosureRecord(record, now = Date.now()) {
  if (!record?.at) return '';
  const reasonText = {
    natural: '自然收尾', 'topic-done': '话题聊完', 'explicit-end': '对方道别',
    busy: '各自去忙', tired: '聊累了', other: '自然收尾',
  }[record.reason] ?? '自然收尾';
  const parts = [`上次这段在${minutesAgo(Math.max(0, now - Number(record.at)))}${reasonText}`];
  if (record.summary) parts.push(`收在「${record.summary}」`);
  if (record.nextOpening) parts.push(`下次可以这样接「${record.nextOpening}」`);
  return parts.join('；') + '。';
}

export function closureRecordBlock(record, now = Date.now()) {
  if (!record?.at) return '';
  const lines = [];
  if (record.reopenedAt && now - Number(record.reopenedAt) < 10 * 60 * 1000) {
    lines.push('上次这段刚收过尾，现在对方又开口了：这是新的开始，别复读上次的结尾。');
  }
  const text = formatClosureRecord(record, now);
  if (text) lines.push(text);
  return `【上次收尾】${lines.join('')}`;
}
