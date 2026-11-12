/**
 * 出站消息 outbox：连接类失败时暂存，账号上线后补发。
 * 不做业务判断；只负责持久化、去重、上限/过期、按顺序补发和失败分类。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEDUPE_MS = 10 * 60_000;
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX = 60;
const DEFAULT_MAX_TRIES = 12;

const PRE_DISPATCH_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
]);

// A lost response can occur after QQ has accepted the message.
export function neverDispatched(error) {
  return PRE_DISPATCH_CODES.has(error?.cause?.code ?? error?.code)
    || error?.message === 'SnowLuma WebSocket is not open';
}

/** QQ timestamps have second precision, so only known message IDs are safe in the same second. */
export function historyAllowsReplay(messages, createdAt, knownIds) {
  const startedSecond = Math.floor(createdAt / 1000);
  return Array.isArray(messages) && messages.length > 0 && messages.every((message) => {
    const time = Number(message?.time);
    const id = String(message?.message_id ?? message?.real_id ?? message?.message_seq ?? '');
    return Number.isFinite(time) && time > 0 && (time < startedSecond || (id && knownIds.has(id)));
  });
}

function safeRead(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data.filter((entry) => entry && typeof entry === 'object') : [];
  } catch { return []; }
}

function hashOf(kind, id, text) {
  return crypto.createHash('sha256').update(`${kind}\0${id}\0${text}`).digest('hex').slice(0, 24);
}

export function createOutbox({
  file,
  send,
  isConnectionError = () => false,
  now = () => Date.now(),
  max = DEFAULT_MAX,
  ttlMs = DEFAULT_TTL_MS,
  maxTries = DEFAULT_MAX_TRIES,
  log = () => {},
} = {}) {
  if (!file || typeof send !== 'function') throw new Error('outbox 需要 file 和 send');
  let entries = safeRead(file);
  const recent = new Map(); // hash -> sentAt
  let flushing = false;

  function cleanRecent(t) {
    for (const [key, at] of recent) if (t - at > DEDUPE_MS) recent.delete(key);
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      log(`[outbox] 写入失败：${String(error?.message ?? error)}`);
    }
  }

  function push(kind, id, text, { replyToMessageId = null, atUserId = null, context, createdAt = now() } = {}) {
    const body = String(text ?? '');
    if (!body || !kind || id == null) return false;
    const t = now();
    cleanRecent(t);
    const hash = hashOf(kind, String(id), body);
    if (!Number.isFinite(createdAt) || createdAt > t || t - createdAt > ttlMs || recent.has(hash)) return false;
    if (entries.some((e) => e.hash === hash && t - Number(e.at) < DEDUPE_MS)) return false;
    if (entries.length >= max) {
      entries.shift();
      log('[outbox] 队列已满，丢弃最旧一条');
    }
    entries.push({
      hash, kind: String(kind), id: String(id), text: body,
      replyToMessageId, atUserId, context, at: createdAt, tries: 0,
    });
    save();
    return true;
  }

  /** 正常发送成功后调用：记指纹，并清掉同文本的待补发项（模型自己重试成功时避免双发）。 */
  function markSent(kind, id, text) {
    const body = String(text ?? '');
    if (!body || !kind || id == null) return;
    const hash = hashOf(kind, String(id), body);
    recent.set(hash, now());
    const before = entries.length;
    entries = entries.filter((e) => e.hash !== hash);
    if (entries.length !== before) save();
  }

  function stats() {
    return { count: entries.length, flushing };
  }

  async function flush(reason = 'manual') {
    if (flushing) return { ok: false, skipped: 'busy', sent: 0, left: entries.length };
    if (!entries.length) return { ok: true, sent: 0, left: 0 };
    flushing = true;
    let sent = 0;
    function remove(entry) {
      entries = entries.filter((item) => item !== entry);
      save();
    }
    try {
      // 正常发送可能清掉待补项，新的失败也可能在 await 期间入队。
      for (const entry of entries.slice()) {
        if (!entries.includes(entry)) continue;
        const age = now() - Number(entry.at);
        if (!Number.isFinite(age) || age < 0 || age > ttlMs || Number(entry.tries) >= maxTries) {
          remove(entry);
          log(`[outbox] 过期或超过重试上限，跳过 ${entry.kind}:${entry.id}`);
          continue;
        }
        try {
          const result = await send(entry, () => entries.includes(entry));
          remove(entry);
          if (result === false) {
            log(`[outbox] 对话已变化或无法核验，跳过旧回复 ${entry.kind}:${entry.id}`);
            continue;
          }
          sent += 1;
          recent.set(entry.hash, now());
          log(`[outbox] 补发成功 ${entry.kind}:${entry.id}`);
        } catch (error) {
          if (isConnectionError(error)) {
            entry.tries = Number(entry.tries || 0) + 1;
            entry.lastError = String(error?.message ?? error).slice(0, 300);
            save();
            log(`[outbox] 补发遇到连接错误，保留 ${entry.kind}:${entry.id}（第 ${entry.tries}/${maxTries} 次）`);
            break;
          } else {
            remove(entry);
            log(`[outbox] 非连接错误，丢弃 ${entry.kind}:${entry.id}：${String(error?.message ?? error).slice(0, 200)}`);
          }
        }
      }
      log(`[outbox] 补发结束（触发：${reason}）：成功 ${sent}，剩余 ${entries.length}`);
      return { ok: true, sent, left: entries.length };
    } finally {
      flushing = false;
    }
  }

  return { push, markSent, flush, stats, _entries: () => entries.slice() };
}
