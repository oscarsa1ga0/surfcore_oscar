import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizeText, scanText } from '../privacy.js';

const require = createRequire(import.meta.url);
const DAY = 24 * 60 * 60 * 1000;

function readChat(directory, select) {
  const file = path.join(directory, 'chat.sqlite');
  if (!fs.existsSync(file)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try { return select(db); }
  finally { db.close(); }
}

/** Private review material can be read when the HTTP gateway is stopped. */
export function readWebDiaryHistory(directory, role, day) {
  if (!role || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const [year, month, date] = day.split('-').map(Number);
  const from = new Date(year, month - 1, date).getTime();
  const until = new Date(year, month - 1, date + 1).getTime();
  return readChat(directory, (db) => {
    const hasTranscripts = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_transcripts'").get();
    const rows = db.prepare(`
      SELECT m.payload, ${hasTranscripts ? 't.text' : "''"} AS transcript
      FROM messages m ${hasTranscripts ? 'LEFT JOIN memory_transcripts t ON t.message_id = m.id' : ''}
      WHERE m.chat = ? AND json_extract(m.payload, '$.at') >= ? AND json_extract(m.payload, '$.at') < ?
        AND json_extract(m.payload, '$.author') IN ('user', 'assistant')
      ORDER BY m.seq
    `).all(role, from, until);
    return rows.map(({ payload, transcript }) => {
      const message = JSON.parse(payload);
      const text = [message.text, transcript ? `语音：${transcript}` : ''].filter(Boolean).join('。')
        || (message.attachments?.length ? '发了附件' : '');
      return { time: message.at, isSelf: message.author === 'assistant', sender: '主人', text };
    }).filter(({ text }) => text);
  }) ?? [];
}

export function publicWebHandoff(text, { identities = [], isPrivateDiary = () => false, now = Date.now() } = {}) {
  const summary = normalizeText(text).slice(0, 550);
  if (!summary || scanText(summary).severe || /https?:|@|\d{5,}|主人|私聊原文/.test(summary)
      || identities.some((name) => name && summary.includes(name)) || isPrivateDiary(summary)) return null;
  return { at: now, summary };
}

export function readWebHandoff(directory, role, now = Date.now()) {
  if (!role) return null;
  return readChat(directory, (db) => {
    const row = db.prepare(`
      SELECT json_extract(detail, '$.webHandoff') AS handoff
      FROM turns WHERE chat = ? AND kind = 'user' AND json_type(detail, '$.webCloseAt') IS NOT NULL
      ORDER BY json_extract(detail, '$.webCloseAt') DESC, rowid DESC LIMIT 1
    `).get(role);
    if (!row?.handoff) return null;
    const { at, summary } = JSON.parse(row.handoff);
    if (!Number.isFinite(at) || at > now || now - at > 7 * DAY || typeof summary !== 'string' || !summary.trim()) return null;
    return { at, summary };
  });
}
