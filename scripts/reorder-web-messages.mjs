#!/usr/bin/env node
// 把网页私聊消息按时间（payload.at）重新排 seq：导入 QQ 历史后保证时间线正确。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SURF = path.join(os.homedir(), '.dsh', 'surfcore');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(SURF, 'web-chat', 'chat.sqlite'));
db.exec('PRAGMA foreign_keys=ON');
const chat = db.prepare('SELECT chat FROM messages LIMIT 1').get()?.chat;
if (!chat) { console.error('没有消息'); process.exit(1); }

const messages = db.prepare('SELECT payload FROM messages ORDER BY seq').all().map((row) => JSON.parse(row.payload));
const attachments = db.prepare('SELECT id, message_id, type, bytes FROM attachments').all();
const byMessage = new Map();
for (const item of attachments) {
  const list = byMessage.get(item.message_id) ?? [];
  list.push(item);
  byMessage.set(item.message_id, list);
}
messages.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0) || String(a.id).localeCompare(String(b.id)));

db.exec('BEGIN IMMEDIATE');
try {
  db.exec('DELETE FROM attachments; DELETE FROM messages; DELETE FROM events;');
  const addEvent = db.prepare('INSERT INTO events(chat) VALUES (?)');
  const addMessage = db.prepare('INSERT INTO messages(seq, id, chat, turn_id, payload) VALUES (?, ?, ?, ?, ?)');
  const addAttachment = db.prepare('INSERT INTO attachments(id, message_id, type, bytes) VALUES (?, ?, ?, ?)');
  for (const message of messages) {
    const seq = Number(addEvent.run(chat).lastInsertRowid);
    message.seq = seq;
    addMessage.run(seq, message.id, chat, message.turnId ?? null, JSON.stringify(message));
    for (const file of byMessage.get(message.id) ?? []) addAttachment.run(file.id, message.id, file.type, file.bytes);
  }
  db.exec('COMMIT');
  console.log(`已按时间重排 ${messages.length} 条`);
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally { db.close(); }
