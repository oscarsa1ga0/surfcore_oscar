#!/usr/bin/env node
// 用真实数据拼一遍网页私聊的每轮提示词（只读，不调用模型、不写任何文件）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildWebPrompt, webStatusLine } from '../plugins/surfcore/lib/web-chat/prompt.js';
import { memoryCardPromptBlock } from '../plugins/surfcore/lib/memory-card.js';
import { createBiliMemory } from '../src/bili-memory.js';
import { readLightMemory, renderLightMemoryBlock } from '../plugins/surfcore/lib/web-chat/light-memory.js';
import { closureRecordBlock, readClosure } from '../plugins/surfcore/lib/web-chat/closure.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const SURF = path.join(HOME, '.dsh', 'surfcore');
const text = process.argv.slice(2).join(' ') || '早上好';

const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(SURF, 'web-chat', 'chat.sqlite'));
const chat = db.prepare('SELECT chat FROM messages LIMIT 1').get()?.chat;
const rows = db.prepare('SELECT payload FROM messages WHERE chat = ? ORDER BY seq DESC LIMIT 8').all(chat).map((row) => JSON.parse(row.payload)).reverse();
db.close();

const id = chat;
const character = path.join(SURF, 'characters', id);
const persona = (() => {
  try { return fs.readFileSync(path.join(character, 'persona.md'), 'utf8').trim(); } catch { return ''; }
})();
const messages = [...rows, { author: 'user', text, at: Date.now(), id: 'preview' }];

const bili = (() => { try { return createBiliMemory({ stateDir: path.join(ROOT, 'state'), biliDir: path.join(character, 'bili') }); } catch { return null; } })();
const biliBrief = (() => { try { return fs.readFileSync(path.join(character, 'bili', 'bili-memory-brief.md'), 'utf8').trim(); } catch { return ''; } })();
const biliRecall = (() => { try { return bili?.recallBlock(text) || ''; } catch { return ''; } })();
const biliDiary = (() => {
  const today = new Date().toLocaleDateString('sv-SE');
  for (const file of ['whale-diary.md', 'whale-diary-private.md']) {
    try {
      const body = fs.readFileSync(path.join(character, 'bili', file), 'utf8');
      const start = body.indexOf('## ' + today);
      if (start < 0) continue;
      const next = body.indexOf('\n## ', start + 3);
      return `【B站日记 · 今天】\n${body.slice(start, next > 0 ? next : body.length).trim().slice(0, 6000)}`;
    } catch {}
  }
  return '';
})();
const diary = (() => {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(character, 'diary', 'index.json'), 'utf8'));
    const recent = [...(index.entries ?? [])].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))).slice(0, 3);
    if (!recent.length) return '';
    const today = new Date().toLocaleDateString('sv-SE');
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE');
    const whenOf = (date) => date === today ? '今天' : date === yesterday ? '昨天' : String(date ?? '').slice(5);
    const parts = recent.map((entry) => `${whenOf(entry.date)}《${entry.title || '无题'}》（${entry.id}，${entry.visibility === 'shareable' ? '可分享' : '私人'}）`);
    return `【日记】你最近写过：${parts.join('；')}。任意一天都可以回顾：先用 diary_list / diary_search 找，再 diary_read（可传 date）；主人问起时由你决定给看、只给一段或拒绝。你也可以用 diary_write 写日记，想写才写。`;
  } catch { return ''; }
})();

const prompt = buildWebPrompt({
  owner: '主人', name: '鱼姬', persona,
  memory: memoryCardPromptBlock('web'),
  status: webStatusLine({ messages }), messages,
  biliBrief, biliRecall, biliDiary, diary,
  lightMemory: renderLightMemoryBlock(readLightMemory(path.join(SURF, 'web-chat', 'memory.json'))),
  closureRecord: closureRecordBlock(readClosure(path.join(SURF, 'web-chat', 'closure.json'))),
  voice: '【语音状态】语音合成可用（web_chat_send_voice，可选 tone：开心/温柔/委屈/生气/疲惫/撒娇/平静/兴奋，intensity 0~1 控强弱）；工具存在就正常用，不要因为旧记忆里的“不能发语音”拒绝，也不要假装发过。',
});
console.log(prompt);
