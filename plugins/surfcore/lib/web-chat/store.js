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
    CREATE INDEX IF NOT EXISTS messages_turn ON messages(turn_id, seq);
    CREATE INDEX IF NOT EXISTS turns_chat ON turns(chat, state);
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
      type TEXT NOT NULL, bytes BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_transcripts (
      message_id TEXT PRIMARY KEY REFERENCES messages(id), text TEXT NOT NULL
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
  const fingerprint = (text, files, quote, action) => createHash('sha256').update(JSON.stringify([
    text, ...files.map(({ bytes, type }) => [type, createHash('sha256').update(bytes).digest('hex')]),
    ...(quote || action ? [{ quoteId: quote?.id ?? '', action }] : []),
  ])).digest('hex');
  const turn = (id) => {
    const row = db.prepare('SELECT id, chat, kind, state, detail FROM turns WHERE id = ?').get(id);
    return row ? { ...row, ...JSON.parse(row.detail) } : null;
  };
  function insertMessage({ chat, turnId = null, id = randomUUID(), author, text, files, note = '', quote = null, action = '', at = Date.now() }) {
    const seq = Number(db.prepare('INSERT INTO events(chat) VALUES (?)').run(chat).lastInsertRowid);
    const attachments = files.map(({ type }) => ({ id: randomUUID(), type }));
    const message = { id, seq, turnId, author, text, attachments, note, at, ...(quote ? { quote } : {}), ...(action ? { action } : {}) };
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

  const replyRows = (turnId) => db.prepare(
    "SELECT payload FROM messages WHERE turn_id = ? AND json_extract(payload, '$.author') = 'assistant' ORDER BY seq"
  ).all(turnId).map(({ payload }) => JSON.parse(payload));
  const group = (job) => [job, ...db.prepare(
    "SELECT id FROM turns WHERE chat = ? AND json_extract(detail, '$.primaryId') = ?"
  ).all(job.chat, job.id).map(({ id }) => turn(id))];
  const open = (job) => job && ['queued', 'submitted'].includes(job.state);
  const summary = (job) => {
    const replied = job.replied === true || (job.state === 'failed' && replyRows(job.primaryId ?? job.id).length > 0);
    return {
      id: job.id, state: job.state, failure: job.failure, replied, note: job.note,
      retryable: job.retryable ?? (!replied && job.cursor == null && !job.admitted),
    };
  };

  return {
    turn,
    enqueue(chat, id, { text = '', files = [], kind = 'user', purpose = null, quote = null, action = '', dive = false, dueAt = 0, closeId }) {
      const key = fingerprint(text, files, quote, action);
      return transaction(() => {
        const existing = db.prepare('SELECT chat, fingerprint, detail FROM turns WHERE id = ?').get(id);
        if (existing) {
          const oldQuote = JSON.parse(existing.detail).quote;
          const legacyMatch = !action && oldQuote?.id === quote?.id && existing.fingerprint === fingerprint(text, files);
          return { duplicate: true, conflict: existing.chat !== chat || (existing.fingerprint !== key && !legacyMatch) };
        }
        if (dive) {
          const parent = turn(closeId);
          if (parent?.chat !== chat || parent.state !== 'submitted') throw new Error('Cannot schedule a return from a closed web turn');
          patch(parent, 'submitted', { closed: true });
          for (const old of db.prepare("SELECT id FROM turns WHERE chat = ? AND state = 'queued' AND json_extract(detail, '$.dive') = 1").all(chat)) {
            patch(turn(old.id), 'cancelled', {});
          }
        }
        const at = Date.now();
        db.prepare('INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?)').run(id, chat, kind, 'queued', key,
          JSON.stringify({ at, purpose, ...(quote ? { quote } : {}), ...(dive ? { dive: true, dueAt } : {}) }));
        if (kind === 'user') insertMessage({ chat, turnId: id, id, author: 'user', text, files, quote, action, at });
        else touch(chat);
        return { duplicate: false, conflict: false };
      });
    },
    queuedUserTurns(chat) {
      return db.prepare("SELECT id FROM turns WHERE chat = ? AND kind = 'user' AND state = 'queued' ORDER BY rowid")
        .all(chat).map(({ id }) => turn(id));
    },
    queue(chat) {
      return db.prepare(`SELECT id FROM turns WHERE chat = ? AND state IN ('queued', 'submitted')
        AND json_extract(detail, '$.primaryId') IS NULL
        AND (state = 'submitted' OR coalesce(json_extract(detail, '$.dueAt'), 0) <= ?)
        ORDER BY CASE WHEN state = 'submitted' THEN 0 WHEN kind = 'user' THEN 1 ELSE 2 END, rowid LIMIT 1`)
        .get(chat, Date.now())?.id ?? null;
    },
    update(id, state, updates = {}) {
      transaction(() => patch(turn(id), state, updates));
    },
    submit(id, ids, updates) {
      return transaction(() => {
        const job = turn(id);
        if (job?.state !== 'queued') throw new Error('Web turn is no longer queued');
        patch(job, 'submitted', updates);
        for (const childId of ids) {
          const child = turn(childId);
          if (child?.chat === job.chat && child.state === 'queued') patch(child, 'submitted', { primaryId: id });
        }
      });
    },
    absorb(id, ids, readSeq) {
      return transaction(() => {
        const job = turn(id);
        if (job?.state !== 'submitted') return [];
        const attached = [];
        for (const childId of ids) {
          const child = turn(childId);
          if (child?.chat !== job.chat || child.state !== 'queued') continue;
          patch(child, 'submitted', { primaryId: id });
          attached.push(childId);
        }
        if (readSeq > (job.readSeq ?? 0)) patch(job, 'submitted', { readSeq });
        return attached;
      });
    },
    publishedReplies: replyRows,
    finalize(id, { failure = '', state = failure ? 'failed' : 'done', closed, retryable = true, note, memo, queuedIds = [] } = {}) {
      return transaction(() => {
        const job = turn(id);
        if (!open(job)) return;
        const replies = replyRows(id);
        const replied = replies.length > 0;
        const replyText = replies.map(({ text }) => text).filter(Boolean).join('\n');
        const updates = {
          failure, outcomePending: job.kind === 'purpose' && !job.dive,
          replyText, closed: closed ?? job.closed ?? false, replied, retryable: retryable && !replied,
          ...(note ? { note } : {}), ...(memo ? { memo } : {}),
        };
        const members = group(job);
        const memberIds = new Set(members.map(({ id }) => id));
        for (const childId of queuedIds) {
          if (memberIds.has(childId)) continue;
          const child = turn(childId);
          if (child?.chat === job.chat && child.state === 'queued') {
            members.push({ ...child, primaryId: id });
          }
        }
        if (failure && job.kind !== 'user') {
          const text = (replied ? '主动消息已发出一部分。' : '主动消息暂未送达。') + failure;
          insertMessage({ chat: job.chat, turnId: id, author: 'notice', text, files: [] });
        }
        for (const member of members) {
          if (open(member)) patch(member, state, member.id === id ? updates : { ...updates, outcomePending: false, replyText: '' });
        }
      });
    },
    purposeOutcomes(chat) {
      return db.prepare("SELECT id FROM turns WHERE chat = ? AND json_extract(detail, '$.outcomePending') = 1 ORDER BY rowid")
        .all(chat).map(({ id }) => turn(id));
    },
    transcript(chat, id) {
      return db.prepare(`SELECT t.text FROM memory_transcripts t JOIN messages m ON m.id = t.message_id
        WHERE m.chat = ? AND m.id = ?`).get(chat, id)?.text ?? '';
    },
    rememberTranscript(chat, id, text) {
      return db.prepare(`INSERT OR IGNORE INTO memory_transcripts SELECT id, ? FROM messages
        WHERE chat = ? AND id = ?`).run(text, chat, id).changes > 0;
    },
    publishReply(chat, turnId, id, { text = '', quote = null, files = [], action = '', transcript = '' }) {
      return transaction(() => {
        if (db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id)) return null;
        const job = turn(turnId);
        if (job?.chat !== chat || job.state !== 'submitted') return null;
        const message = insertMessage({ id, chat, turnId, author: 'assistant', text, files, quote, action });
        if (transcript) db.prepare('INSERT INTO memory_transcripts VALUES (?, ?)').run(id, transcript);
        return message;
      });
    },
    notice(chat, id, text) {
      return transaction(() => {
        if (db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id)) return false;
        insertMessage({ chat, id, author: 'notice', text, files: [] });
        return true;
      });
    },
    snapshot(chat, { before = null, after = null } = {}) {
      const latest = Number(db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM events WHERE chat = ?').get(chat).seq);
      const reset = after !== null && after > latest;
      const incremental = after !== null && !reset;
      const page = this.history(chat, incremental ? { after, limit: 100 } : { before, limit: 50 });
      const more = !incremental && page.more;
      const pending = incremental && page.more;
      return { chat, cursor: pending ? page.messages.at(-1).seq : latest, messages: page.messages, more, pending, reset };
    },
    history(chat, { before = null, after = null, limit = 50 } = {}) {
      const take = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 500);
      const forward = before === null && after !== null;
      const rows = forward
        ? db.prepare('SELECT payload FROM messages WHERE chat = ? AND seq > ? ORDER BY seq LIMIT ?').all(chat, after, take + 1)
        : db.prepare('SELECT payload FROM messages WHERE chat = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
          .all(chat, before ?? Number.MAX_SAFE_INTEGER, take + 1);
      const messages = rows.slice(0, take).map(({ payload }) => JSON.parse(payload));
      return { messages: forward ? messages : messages.reverse(), more: rows.length > take };
    },
    search(chat, query, { before = null, kind = '', limit = 30 } = {}) {
      const take = Math.min(Math.max(Number(limit) || 30, 1), 50);
      const rows = db.prepare(`
        SELECT m.payload FROM messages m WHERE m.chat = ? AND m.seq < ?
        AND (? = '' OR instr(lower(coalesce(json_extract(m.payload, '$.text'), '')), lower(?)) > 0)
        AND (? = '' OR (? = 'sticker' AND json_extract(m.payload, '$.action') = 'sticker')
          OR (? IN ('image','audio') AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.type LIKE ?)))
        ORDER BY m.seq DESC LIMIT ?
      `).all(chat, before ?? Number.MAX_SAFE_INTEGER, query, query, kind, kind, kind, kind + '/%', take + 1);
      return { messages: rows.slice(0, take).map(({ payload }) => JSON.parse(payload)), more: rows.length > take };
    },
    around(chat, id) {
      const target = this.messageOf(chat, id);
      if (!target) return null;
      const older = this.history(chat, { before: target.seq, limit: 15 });
      const newer = this.history(chat, { after: target.seq, limit: 15 });
      return { target: target.id, messages: [...older.messages, target, ...newer.messages] };
    },
    beforeFirstQueuedUser(chat) {
      const earliest = db.prepare(`SELECT min(m.seq) AS seq FROM messages m JOIN turns t ON m.turn_id = t.id
        WHERE m.chat = ? AND t.kind = 'user' AND t.state = 'queued'`).get(chat)?.seq;
      return earliest == null ? this.cursor(chat) : earliest - 1;
    },
    messageByAttachment(chat, attachmentId) {
      const row = db.prepare('SELECT m.payload FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.chat = ? AND a.id = ?')
        .get(chat, attachmentId);
      return row ? JSON.parse(row.payload) : null;
    },
    lastTurn(chat) {
      const row = db.prepare("SELECT id FROM turns WHERE chat = ? AND kind = 'user' ORDER BY rowid DESC LIMIT 1").get(chat);
      if (!row) return null;
      const job = turn(row.id);
      return { ...summary(job), closed: job.closed === true };
    },
    messageTurns(chat, messages, { live = false } = {}) {
      const ids = new Set(messages.filter(({ author, turnId }) => author === 'user' && turnId).map(({ turnId }) => turnId));
      if (live) {
        for (const row of db.prepare("SELECT id FROM turns WHERE chat = ? AND kind = 'user' ORDER BY rowid DESC LIMIT 65").all(chat)) ids.add(row.id);
      }
      return [...ids].map(turn).filter((job) => job?.chat === chat).map(summary);
    },
    cursor(chat) {
      return Number(db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM messages WHERE chat = ?').get(chat).seq);
    },
    userMessagesAfter(chat, seq) {
      return db.prepare("SELECT payload FROM messages WHERE chat = ? AND seq > ? AND json_extract(payload, '$.author') = 'user' ORDER BY seq")
        .all(chat, Number(seq) || 0).map(({ payload }) => JSON.parse(payload));
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
