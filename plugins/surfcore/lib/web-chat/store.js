import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
export const webId = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

export function openWebChatStore(directory) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'chat.sqlite');
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY, chat TEXT NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL, fingerprint TEXT NOT NULL, detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, chat TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY REFERENCES events(seq), id TEXT NOT NULL UNIQUE,
      chat TEXT NOT NULL, turn_id TEXT REFERENCES turns(id), payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat, seq);
    CREATE INDEX IF NOT EXISTS turns_chat ON turns(chat, state);
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
      type TEXT NOT NULL, bytes BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS browser_sessions (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  `);

  function transaction(run) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const fingerprint = (text, files) => createHash('sha256')
    .update(JSON.stringify([text, ...files.map(({ bytes, type }) => [type, createHash('sha256').update(bytes).digest('hex')])])).digest('hex');
  const turn = (id) => {
    const row = db.prepare('SELECT id, chat, kind, state, detail FROM turns WHERE id = ?').get(id);
    return row ? { ...row, ...JSON.parse(row.detail) } : null;
  };
  function insertMessage({ chat, turnId = null, id = randomUUID(), author, text, files, note = '', quote = null, at = Date.now() }) {
    const seq = Number(db.prepare('INSERT INTO events(chat) VALUES (?)').run(chat).lastInsertRowid);
    const attachments = files.map(({ type }) => ({ id: randomUUID(), type }));
    const message = { id, seq, turnId, author, text, attachments, note, at, ...(quote ? { quote } : {}) };
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(seq, id, chat, turnId, JSON.stringify(message));
    const put = db.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?)');
    for (let i = 0; i < attachments.length; i++) {
      put.run(attachments[i].id, id, attachments[i].type, files[i].bytes);
    }
    return message;
  }
  const touch = (chat) => db.prepare('INSERT INTO events(chat) VALUES (?)').run(chat);
  const patch = (job, state, updates) => {
    const { id, chat, kind, state: oldState, detail, ...extra } = job;
    db.prepare('UPDATE turns SET state = ?, detail = ? WHERE id = ?').run(state, JSON.stringify({ ...extra, ...updates }), id);
    touch(chat);
  };

  return {
    turn,
    enqueue(chat, id, { text = '', files = [], kind = 'user', purpose = null, quote = null, dive = false }) {
      const key = fingerprint(text, files);
      return transaction(() => {
        const existing = db.prepare('SELECT chat, fingerprint FROM turns WHERE id = ?').get(id);
        if (existing) return { duplicate: true, conflict: existing.chat !== chat || existing.fingerprint !== key };
        const at = Date.now();
        db.prepare('INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?)').run(id, chat, kind, 'queued', key,
          JSON.stringify({ at, purpose, ...(quote ? { quote } : {}), ...(dive ? { dive: true } : {}) }));
        if (kind === 'user') insertMessage({ chat, turnId: id, id, author: 'user', text, files, quote, at });
        else touch(chat);
        return { duplicate: false, conflict: false };
      });
    },
    queuedUserTurns(chat) {
      return db.prepare("SELECT id, detail FROM turns WHERE chat = ? AND kind = 'user' AND state = 'queued' ORDER BY rowid")
        .all(chat).map((row) => ({ id: row.id, ...JSON.parse(row.detail) }));
    },
    queue(chat) {
      return db.prepare("SELECT id FROM turns WHERE chat = ? AND state IN ('queued', 'submitted') ORDER BY rowid LIMIT 1")
        .get(chat)?.id ?? null;
    },
    update(id, state, updates = {}) {
      transaction(() => patch(turn(id), state, updates));
    },
    finalize(id, { text = '', files = [], failure = '', state = failure ? 'failed' : 'done', note = '', closed = false, replied = false } = {}) {
      return transaction(() => {
        const job = turn(id);
        if (!job || !['queued', 'submitted'].includes(job.state)) return null;
        const message = (text || files.length) ? insertMessage({
          chat: job.chat, turnId: id, author: 'assistant', text, files, note,
        }) : null;
        if (failure && job.kind !== 'user') {
          insertMessage({ chat: job.chat, turnId: id, author: 'notice', text: '主动消息暂未送达。' + failure, files: [] });
        }
        patch(job, state, { failure, outcomePending: job.kind === 'purpose', replyText: text, closed, replied });
        return message;
      });
    },
    purposeOutcomes(chat) {
      return db.prepare("SELECT id FROM turns WHERE chat = ? AND json_extract(detail, '$.outcomePending') = 1 ORDER BY rowid")
        .all(chat).map(({ id }) => turn(id));
    },
    publishImage(chat, turnId, id, file, text) {
      return transaction(() => {
        const existing = db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id);
        return existing ? null : insertMessage({ id, chat, turnId, author: 'assistant', text, files: [file] });
      });
    },
    // 她通过 web_chat_send_message 说的一句话：和 QQ 一样按“一条消息”立即落库，
    // 页面通过 SSE 逐条收到；一条回复可以落多条。
    reply(chat, turnId, text, quote = null) {
      return transaction(() => insertMessage({ chat, turnId, author: 'assistant', text, files: [], quote }));
    },
    notice(chat, id, text) {
      return transaction(() => {
        if (db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id)) return false;
        insertMessage({ chat, id, author: 'notice', text, files: [] });
        return true;
      });
    },
    snapshot(chat, { before = null, after = null } = {}) {
      const cursor = Number(db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM events WHERE chat = ?').get(chat).seq);
      const rows = after !== null
        ? db.prepare('SELECT payload FROM messages WHERE chat = ? AND seq > ? ORDER BY seq LIMIT 301').all(chat, after)
        : db.prepare('SELECT payload FROM messages WHERE chat = ? AND seq < ? ORDER BY seq DESC LIMIT 51')
          .all(chat, before ?? Number.MAX_SAFE_INTEGER).reverse();
      const messages = rows.map((row) => JSON.parse(row.payload));
      const more = after === null && messages.length > 50;
      if (more) messages.shift();
      return { chat, cursor, messages, more, reset: after !== null && (messages.length > 300 || after > cursor) };
    },
    history(chat, { before = null, limit = 200 } = {}) {
      const take = Math.min(Math.max(Number(limit) || 200, 1), 500);
      const rows = db.prepare('SELECT payload FROM messages WHERE chat = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
        .all(chat, before ?? Number.MAX_SAFE_INTEGER, take).reverse();
      return rows.map((row) => JSON.parse(row.payload));
    },
    lastTurn(chat) {
      const row = db.prepare('SELECT id, kind, state, detail FROM turns WHERE chat = ? AND kind = \'user\' ORDER BY rowid DESC LIMIT 1').get(chat);
      if (!row) return null;
      const detail = JSON.parse(row.detail);
      return { id: row.id, kind: row.kind, state: row.state, replied: detail.replied === true, closed: detail.closed === true };
    },
    recentTurns(chat) {
      return db.prepare("SELECT id, state, json_extract(detail, '$.failure') AS failure FROM turns WHERE chat = ? AND kind = 'user' ORDER BY rowid DESC LIMIT 65")
        .all(chat);
    },
    cursor(chat) {
      return Number(db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM messages WHERE chat = ?').get(chat).seq);
    },
    userMessagesAfter(chat, seq) {
      return db.prepare("SELECT payload FROM messages WHERE chat = ? AND seq > ? ORDER BY seq")
        .all(chat, Number(seq) || 0)
        .map((row) => JSON.parse(row.payload))
        .filter((message) => message.author === 'user');
    },
    message(id) {
      const row = db.prepare('SELECT payload FROM messages WHERE id = ?').get(id);
      return row ? JSON.parse(row.payload) : null;
    },
    messageOf(chat, id) {
      const row = db.prepare('SELECT payload FROM messages WHERE id = ? AND chat = ?').get(id, chat);
      return row ? JSON.parse(row.payload) : null;
    },
    attachment(chat, id) {
      return db.prepare('SELECT a.type, a.bytes FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.chat = ? AND a.id = ?')
        .get(chat, id);
    },
    lastUserAt(chat) {
      return db.prepare("SELECT json_extract(detail, '$.at') AS at FROM turns WHERE chat = ? AND kind = 'user' ORDER BY rowid DESC LIMIT 1")
        .get(chat)?.at || 0;
    },
    addBrowserSession(token, expires) {
      db.prepare('DELETE FROM browser_sessions WHERE expires <= ?').run(Date.now());
      db.prepare('INSERT INTO browser_sessions VALUES (?, ?)').run(createHash('sha256').update(token).digest('hex'), expires);
    },
    hasBrowserSession(token) {
      return Boolean(db.prepare('SELECT 1 FROM browser_sessions WHERE digest = ? AND expires > ?')
        .get(createHash('sha256').update(token).digest('hex'), Date.now()));
    },
    close: () => db.close(),
  };
}
