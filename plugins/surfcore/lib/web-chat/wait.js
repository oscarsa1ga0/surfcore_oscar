import { setTimeout as delay } from 'node:timers/promises';

const MAX_ROUND_WAIT_MS = 120_000;
const MAX_SINGLE_WAIT_MS = 30_000;
const EMPTY_WAIT_LIMIT = 2;

/** Poll a single admitted round, and attach only the messages returned to the model. */
export async function waitForWebMessages(run, { timeoutMs, quietMs, purpose }, { store, signal, ensureActive, toSnapshot, onChange }) {
  const mode = purpose === 'reply' ? 'reply' : 'messages';
  const started = Date.now();
  const totalDeadline = (run.admittedAt ?? started) + MAX_ROUND_WAIT_MS;
  const cappedReason = (now) => now >= totalDeadline ? 'round-wait-budget'
    : (run.emptyWaits ?? 0) >= EMPTY_WAIT_LIMIT ? 'consecutive-wait-limit' : '';
  const stopped = (reason) => ({
    ok: true, stopped: true, reason, shouldClose: true, quiet: false, timeout: false,
    messages: [], newMessages: [], hint: '先回复已读到的内容，然后结束本轮。新消息会开启下一轮，请勿继续调用等待。',
  });
  const initialStop = cappedReason(started);
  if (initialStop) return stopped(initialStop);
  const limit = Math.min(Math.max(Number(timeoutMs) || MAX_SINGLE_WAIT_MS, 1000), MAX_SINGLE_WAIT_MS);
  const quiet = Math.min(Math.max(Number(quietMs) || 10000, 10000), MAX_SINGLE_WAIT_MS);
  const deadline = Math.min(started + limit, totalDeadline);
  let lastAt = mode === 'reply' ? Number(store.lastUserAt(run.chat)) || 0 : 0;
  const found = [];
  let scanSeq = run.readSeq;
  let quietReached = false;
  run.waiting = true;
  try {
    while (true) {
      signal.throwIfAborted();
      ensureActive();
      const fresh = store.userMessagesAfter(run.chat, scanSeq);
      for (const message of fresh) {
        if (!message.turnId || store.turn(message.turnId)?.state !== 'queued') continue;
        found.push(message);
        lastAt = Math.max(lastAt, Number(message.at) || 0);
      }
      scanSeq = fresh.at(-1)?.seq ?? scanSeq;
      const now = Date.now();
      quietReached = (lastAt > 0 || mode === 'reply') && now - lastAt >= quiet;
      if (quietReached || now >= deadline) break;
      await delay(Math.min(250, deadline - now), undefined, { signal });
    }
    signal.throwIfAborted();
    const snapshots = await Promise.all(found.map(toSnapshot));
    signal.throwIfAborted();
    ensureActive();
    const attached = new Set(store.absorb(run.id, found.map(({ turnId }) => turnId), scanSeq));
    run.readSeq = Math.max(run.readSeq, scanSeq);
    const list = snapshots.filter((_, index) => attached.has(found[index].turnId));
    const timeout = !list.length && !quietReached;
    if (list.length) {
      run.emptyWaits = 0;
      onChange();
    } else if (mode === 'messages' && timeout) run.emptyWaits = (run.emptyWaits ?? 0) + 1;
    const stop = cappedReason(Date.now());
    if (stop && !list.length) return stopped(stop);
    return {
      ok: true, timeout, quiet: quietReached, messages: list, newMessages: list,
      ...(stop ? { stopped: true, reason: stop, shouldClose: true, hint: '接住这些补发后结束本轮，请勿继续等待。' } : {}),
      ...(list.some((item) => item.media?.some(({ kind }) => kind === 'image'))
        ? { imageHint: '先用 web_chat_image_ticket 获取凭证，再调用 mcp__web-images__web_read_images 看图。' } : {}),
    };
  } finally {
    run.waiting = false;
  }
}
