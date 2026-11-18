#!/usr/bin/env node
// 把 QQ 私聊的历史记录导入鱼姬之家网页端的 SQLite（只做展示历史，不动 DSH 会话）。
//
// 来源：DSH 那条 QQ 私聊会话的日志（state/sessions.json 映射 key → sessionId）。
//   · 主人消息：唤醒提示里的【本次消息快照】JSON（含 messageId / time / text）。
//   · 她的消息：mcp__snowluma__qq_send_message / qq_reply / qq_send_burst 的调用参数。
// 幂等：每条导入消息用来源 id 生成固定 id，重复运行会跳过。
//
// 用法：node scripts/import-qq-private-to-web.mjs [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const SURF = path.join(HOME, '.dsh', 'surfcore');
const dryRun = process.argv.includes('--dry-run');

const readJson = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

const config = readJson(path.join(SURF, 'config.json'), {}) ?? {};
const ownerQQ = String(config.ownerQQ ?? config.admin?.ownerQQ ?? '').trim();
const sessions = readJson(path.join(ROOT, 'state', 'sessions.json'), {})?.sessions ?? {};
const ownerKey = ownerQQ && sessions[`private:${ownerQQ}`] ? `private:${ownerQQ}` : Object.keys(sessions).find((key) => key.startsWith('private:'));
if (!ownerKey) {
  console.error('没有找到 QQ 私聊会话（state/sessions.json）');
  process.exit(1);
}
const sessionId = sessions[ownerKey];
console.log(`来源：${ownerKey} → ${sessionId}`);

function sessionFile(id) {
  const root = path.join(HOME, '.dsh', 'sessions');
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, id, 'session.v4.jsonl.zstd');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function zstdCommand() {
  for (const candidate of ['zstd', '/Users/wangyiyi/miniforge3/bin/zstd', '/opt/homebrew/bin/zstd', '/usr/local/bin/zstd']) {
    try { execFileSync(candidate, ['--version'], { stdio: 'ignore' }); return candidate; } catch {}
  }
  return null;
}

const zstd = zstdCommand();
if (!zstd) {
  console.error('找不到 zstd，无法解压会话日志');
  process.exit(1);
}

// 私聊历史可能跨多条被轮换过的 DSH 会话：全部扫，按 messageId / 发送时间+文本去重。
function allSessionFiles() {
  const root = path.join(HOME, '.dsh', 'sessions');
  const files = [];
  for (const dir of fs.readdirSync(root)) {
    const base = path.join(root, dir);
    let ids = [];
    try { ids = fs.readdirSync(base); } catch { continue; }
    for (const id of ids) {
      const file = path.join(base, id, 'session.v4.jsonl.zstd');
      if (fs.existsSync(file)) files.push(file);
    }
  }
  return files;
}

function parseSnapshot(text) {
  const marker = '【本次消息快照】';
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf('{', at + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const ownerMessages = new Map();
const herMessages = new Map();
const imageCallTargets = new Map(); // callId -> messageId
const imagesByMessage = new Map();  // messageId -> [{type, bytes}]
let scanned = 0;
for (const file of allSessionFiles()) {
  let raw;
  try { raw = execFileSync(zstd, ['-dc', file], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8'); } catch { continue; }
  if (!raw.includes(ownerKey)) continue;
  scanned += 1;
  for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  const time = Number(event.time) || 0;
  const data = typeof event.data === 'string' ? (() => { try { return JSON.parse(event.data); } catch { return null; } })() : event.data;
  if (!data || typeof data !== 'object') continue;

  if (event.type === 'agent/inbox/spliced' || event.type === 'user/message') {
    const blocks = event.type === 'user/message' ? data.content : (data.inserted ?? []).flatMap((item) => item?.content ?? []);
    const text = (Array.isArray(blocks) ? blocks : []).filter((part) => part?.type === 'text').map((part) => part.text).join('');
    const snapshot = text ? parseSnapshot(text) : null;
    // snapshot 同时有 messages（未读/补历史）和 recent（最近几条）；两边都要，
    // 否则只出现在 recent 里的离线消息会漏。isSelf 是她自己，交给发送工具那条线。
    const candidates = [...(snapshot?.messages ?? []), ...(snapshot?.recent ?? [])];
    for (const message of candidates) {
      if (!message?.isOwner || message?.isSelf || !message.messageId) continue;
      ownerMessages.set(String(message.messageId), {
        id: 'imp-qq-u-' + String(message.messageId),
        author: 'user', text: String(message.text ?? ''), at: Number(message.time) || time,
      });
    }
    continue;
  }

  if (event.type === 'tool/result') {
    const blocks = data.message?.content ?? [];
    if (blocks.some((block) => block?.type === 'image')) {
      const callId = String(data.message?.toolCallId ?? data.message?.source?.callId ?? '');
      const target = imageCallTargets.get(callId);
      if (target) {
        const list = imagesByMessage.get(target) ?? [];
        for (const block of blocks) {
          if (block?.type !== 'image') continue;
          if (typeof block.data === 'string') {
            list.push({ type: String(block.mediaType || 'image/jpeg'), bytes: Buffer.from(block.data, 'base64') });
            continue;
          }
          const attachment = block.attachment;
          if (!attachment?.attachmentId) continue;
          const hash = String(attachment.attachmentId).replace(/^sha256:/, '');
          const file = path.join(HOME, '.dsh', 'attachments', 'v1', 'objects', hash.slice(0, 2), hash);
          try { list.push({ type: String(attachment.mediaType || 'image/jpeg'), bytes: fs.readFileSync(file) }); } catch {}
        }
        imagesByMessage.set(target, list);
      }
    }
    for (const block of blocks) {
      if (block?.type !== 'text') continue;
      let obj;
      try { obj = JSON.parse(block.text); } catch { continue; }
      if (obj?.key && String(obj.key) !== ownerKey) continue;
      const arrays = [obj.newMessages, obj.unread, obj.messages, obj.recent,
        obj.snapshot?.unread, obj.snapshot?.recent, obj.data?.unread, obj.data?.recent].filter(Array.isArray);
      for (const list of arrays) {
        for (const message of list) {
          if (!message?.isOwner || message?.isSelf || !message?.messageId) continue;
          ownerMessages.set(String(message.messageId), {
            id: 'imp-qq-u-' + String(message.messageId),
            author: 'user', text: String(message.text ?? ''), at: Number(message.time) || time,
          });
        }
      }
    }
    continue;
  }

  if (event.type !== 'tool/call') continue;
  const name = String(data.name ?? '');
  if (name.endsWith('qq_get_message_images')) {
    let args = data.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (args && String(args.key ?? '') === ownerKey && args.messageId) {
      imageCallTargets.set(String(data.callId ?? ''), String(args.messageId));
    }
  }
  if (!/qq_(send_message|reply|send_burst|reply_and_finish)$/.test(name)) continue;
  let args = data.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { continue; } }
  if (!args || String(args.key ?? '') !== ownerKey) continue;
  const list = [];
  const pushText = (value) => {
    if (Array.isArray(value)) value.forEach(pushText);
    else if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) return parsed.forEach(pushText); } catch {}
      }
      list.push(trimmed);
    }
  };
  pushText(args.messages);
  pushText(args.message);
  list.forEach((text, index) => {
    const id = 'imp-qq-a-' + (Number(time) + index) + '-' + Buffer.from(text).toString('base64').slice(0, 12);
    herMessages.set(id, { id, author: 'assistant', text, at: time + index * 1200 });
  });
  }
}
console.log(`扫描 ${scanned} 条包含该私聊的会话`);

const all = [...ownerMessages.values(), ...herMessages.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
console.log(`解析到：主人 ${ownerMessages.size} 条，她 ${herMessages.size} 条，合计 ${all.length} 条`);

const chat = (() => {
  try {
    const dbFile = path.join(SURF, 'web-chat', 'chat.sqlite');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbFile);
    const row = db.prepare('SELECT chat FROM messages LIMIT 1').get();
    db.close();
    return row?.chat;
  } catch {}
})() || (fs.readdirSync(path.join(SURF, 'characters'))[0] ?? '');
console.log(`写入网页会话 chat=${chat}${dryRun ? '（dry-run）' : ''}`);

if (!dryRun && all.length) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(SURF, 'web-chat', 'chat.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  let inserted = 0;
  let skipped = 0;
  const exists = db.prepare('SELECT 1 FROM messages WHERE id = ?');
  const addEvent = db.prepare('INSERT INTO events(chat) VALUES (?)');
  const addMessage = db.prepare('INSERT INTO messages(seq, id, chat, turn_id, payload) VALUES (?, ?, ?, NULL, ?)');
  const addAttachment = db.prepare('INSERT INTO attachments(id, message_id, type, bytes) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const message of all) {
      if (exists.get(message.id)) { skipped += 1; continue; }
      const seq = Number(addEvent.run(chat).lastInsertRowid);
      const files = message.author === 'user' && /^\[图片\]$/.test(message.text)
        ? (imagesByMessage.get(message.id.replace('imp-qq-u-', '')) ?? [])
        : [];
      const attachments = files.map((file) => ({ id: require('node:crypto').randomUUID(), type: file.type }));
      addMessage.run(seq, message.id, chat, JSON.stringify({
        id: message.id, seq, turnId: null, author: message.author, text: message.text,
        attachments, note: '', at: message.at,
      }));
      for (let i = 0; i < attachments.length; i += 1) {
        addAttachment.run(attachments[i].id, message.id, files[i].type, files[i].bytes);
      }
      inserted += 1;
    }
    // 已导入的 [图片] 消息：补附件（第二次运行时也能补）。
    let attached = 0;
    for (const [messageId, files] of imagesByMessage) {
      const id = 'imp-qq-u-' + messageId;
      if (db.prepare('SELECT 1 FROM attachments WHERE message_id = ?').get(id)) continue;
      const row = db.prepare('SELECT payload FROM messages WHERE id = ?').get(id);
      if (!row) continue;
      const payload = JSON.parse(row.payload);
      payload.attachments = files.map((file) => ({ id: require('node:crypto').randomUUID(), type: file.type }));
      db.prepare('UPDATE messages SET payload = ? WHERE id = ?').run(JSON.stringify(payload), id);
      for (let i = 0; i < files.length; i += 1) {
        addAttachment.run(payload.attachments[i].id, id, files[i].type, files[i].bytes);
      }
      attached += 1;
    }
    if (attached) console.log(`补上图片附件 ${attached} 条消息`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
  console.log(`已导入 ${inserted} 条，跳过 ${skipped} 条（已存在）`);
}
