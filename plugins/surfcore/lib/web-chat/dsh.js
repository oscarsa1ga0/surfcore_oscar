import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dialogueEmotionScope } from '../../../../src/emotion-events.js';
import { WEB_IMAGE_LIMIT, parseWebImage, webImagePrompt } from './media.js';

const textBlocks = (blocks) => (blocks ?? []).filter((part) => part.type === 'text' && typeof part.text === 'string')
  .map((part) => part.text).join('');
const defaultHint = '可以稍后重试，或在 DSH 中查看鱼姬之家会话。';
export const chatError = (status, code, message, hint = defaultHint) => Object.assign(new Error(message), { status, code, hint });
export const webSessionId = (chat) => 'surfcore-web-' + createHash('sha256').update(chat).digest('hex').slice(0, 32);

export function createWebDsh({ ctx, store, dispatch, identity, config, context, recall, budget, onMessage, onChange, log }) {
  const controller = ctx.sessionController;
  const active = new Map();
  const pending = new Map();
  const lifecycle = new AbortController();
  const disposers = [];

  function current() {
    const { role, name } = identity();
    return { role, name, chat: role.characterId };
  }

  const isActive = (run) => active.get(run.session) === run;

  function closeRequests(run) {
    for (const request of pending.values()) if (request.run === run) request.finish(request.fallback);
  }

  function finish(run, state, failure = '') {
    if (!isActive(run)) return;
    const message = store.finalize(run.id, {
      text: state === 'done' ? run.parts.join('\n\n').trim() : '',
      files: state === 'done' ? run.files : [],
      state, failure, note: run.note,
    });
    active.delete(run.session);
    closeRequests(run);
    if (message) onMessage(message, run);
    onChange();
  }

  function applyEvent(run, event) {
    if (!event || (Number.isSafeInteger(event.seq) && event.seq <= run.seq)) return;
    if (Number.isSafeInteger(event.seq)) run.seq = event.seq;
    const data = event.data ?? {};
    if (event.type === 'turn/start') run.latestTurn = data.turn;
    if (event.type === 'user/message' && data.source?.rpcId === run.id) {
      run.turn = data.turn ?? run.latestTurn;
      run.admitted = true;
    }
    if (event.type === 'agent/inbox/spliced' && data.inserted?.some((message) => message.source?.rpcId === run.id)) {
      run.admitted = true;
      run.turn = data.turn ?? run.latestTurn;
    }
    if (!run.admitted) return;
    if (run.turn !== undefined && data.turn !== undefined && data.turn !== run.turn) return;
    if (event.type === 'assistant/message') {
      const blocks = data.message?.content;
      const text = textBlocks(blocks);
      if (text.trim()) run.parts.push(text);
      for (const block of (blocks ?? []).filter((part) => part.type === 'image')) {
        if (run.files.length >= 4) break;
        const file = parseWebImage(block.data);
        if (file) run.files.push(file);
      }
      run.draft = '';
      run.phase = 'running';
    } else if (event.type === 'tool/call') {
      run.phase = 'tool';
      run.tool = String(data.toolName ?? data.name ?? data.call?.name ?? '').slice(0, 120);
    } else if (event.type === 'tool/result') {
      run.phase = 'running';
    } else if (event.type === 'turn/end') {
      const reason = data.reason?.kind;
      if (reason === 'completed') finish(run, 'done');
      else finish(run, 'failed', reason === 'aborted' ? '回合已停止。可以重新发送。' : 'DSH 回合失败。请检查模型、图片能力或工具权限，再重试。');
    }
  }

  function guard(fn) {
    return (...args) => {
      try { fn(...args); } catch (error) { log('读取 DSH 事件失败', error); }
    };
  }
  const event = guard((session, entry) => {
    const run = active.get(session.id);
    if (!run) return;
    applyEvent(run, entry);
    onChange();
  });
  const stream = guard(({ agent, frame }) => {
    const run = active.get(agent.session.id);
    if (!run || !run.admitted) return;
    if (run.turn !== undefined && run.turn !== frame.turn) return;
    if (frame.type === 'start') {
      run.attempt = frame.attemptId;
      run.draft = '';
      run.phase = 'running';
    }
    if (frame.type === 'chunk' && frame.attemptId === run.attempt && frame.chunk?.type === 'text-delta') {
      run.draft = (run.draft + frame.chunk.text).slice(0, 100_000);
    }
    onChange();
  });

  function ask(kind, request, next) {
    const run = active.get(request.agent?.session?.id);
    if (!run?.admitted) return next();
    const { chat, role } = current();
    if (run.chat !== chat || run.epoch !== role.epoch) return next();
    const id = randomUUID();
    const questions = kind === 'question' ? request.questions : [];
    const card = kind === 'approval'
      ? { id, kind, tool: String(request.toolName ?? '').slice(0, 200), reason: String(request.reason ?? '').slice(0, 4000) }
      : { id, kind, questions: (questions ?? []).map((question) => ({
        id: question.id, title: question.header, text: question.question, detail: question.detail?.text,
        multiple: question.multiSelect === true, options: (question.options ?? []).map((option) => ({
          label: option.label, description: option.description,
        })),
      })) };
    const fallback = kind === 'approval' ? 'rejected' : { answers: [] };
    if (request.signal?.aborted) return fallback;
    return new Promise((resolve) => {
      const abort = () => finishRequest(fallback);
      const timeout = setTimeout(abort, 5 * 60_000);
      timeout.unref?.();
      function finishRequest(value) {
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', abort);
        pending.delete(id);
        resolve(value);
        onChange();
      }
      pending.set(id, { run, card, fallback, finish: finishRequest });
      request.signal?.addEventListener('abort', abort, { once: true });
      onChange();
    });
  }

  function answer(id, value) {
    const request = pending.get(id);
    const role = current();
    if (!request || request.run.chat !== role.chat || request.run.epoch !== role.role.epoch) {
      throw chatError(409, 'WEB_REQUEST_EXPIRED', '这条请求已结束。', '查看当前消息，再回答新的请求。');
    }
    if (request.card.kind === 'approval') {
      if (typeof value?.allow !== 'boolean') throw chatError(400, 'WEB_APPROVAL_INVALID', '请选择批准或拒绝。');
      request.finish(value.allow ? 'allowed-once' : 'rejected');
      return;
    }
    if (value?.skip === true) {
      request.finish(request.fallback);
      return;
    }
    const answers = request.card.questions.map((question) => {
      const input = value?.answers?.find?.((item) => item?.id === question.id);
      const selected = Array.isArray(input?.selected) ? [...new Set(input.selected)] : [];
      const custom = typeof input?.custom === 'string' ? input.custom.slice(0, 4000) : '';
      if (selected.some((label) => !question.options.some((option) => option.label === label))
          || (!question.multiple && selected.length > 1) || (!selected.length && !custom.trim())) {
        throw chatError(400, 'WEB_ANSWER_INVALID', '请为每道问题选择选项或填写回答。');
      }
      return { id: question.id, selected, custom };
    });
    request.finish({ answers });
  }

  async function history(session) {
    return controller.events({ address: { kind: 'session', sessionId: session }, maxMessages: 50 }, AbortSignal.timeout(5000));
  }

  async function ensureSession(session) {
    try { return await history(session); }
    catch (error) { if (error?.code !== 'session/not-found') throw error; }
    await controller.create({ sessionId: session, cwd: config().cwd });
    return history(session);
  }

  async function submit(run, job, role) {
    const signal = lifecycle.signal;
    return dispatch.enqueue({ id: job.id, role, source: 'web', priority: job.kind !== 'user' ? 'scheduled' : 'manual', signal }, async (send) => {
      if (current().role.epoch !== role.epoch || current().chat !== run.chat) {
        throw chatError(409, 'WEB_ROLE_CHANGED', '角色已切换。');
      }
      if (job.kind !== 'user' && !config().proactive) throw chatError(409, 'WEB_CARRIER_CHANGED', '主动投递已切换。');
      if ((await budget?.block('other'))?.blocked) throw chatError(429, 'WEB_BUDGET', '已达到模型用量上限。', '在 SurfCore 用量页检查预算，再重试。');
      const user = store.message(job.id);
      const content = [];
      if (job.kind !== 'user') content.push({ type: 'text', text: job.purpose.prompt });
      else {
        if (user.text) content.push({ type: 'text', text: user.text });
        for (const { id } of user.attachments) {
          const file = store.attachment(run.chat, id);
          const { blocks, note } = await webImagePrompt(file, config());
          content.push(...blocks);
          if (note) run.note = note;
        }
      }
      run.recall = user?.text ? await recall?.(user.text) : '';
      const previous = await ensureSession(run.session);
      signal.throwIfAborted();
      run.seq = Number(previous.cursor);
      if (!Number.isSafeInteger(run.seq)) throw chatError(502, 'WEB_DSH_EVENTS', '无法读取 DSH 会话游标。');
      store.update(job.id, 'submitted', { cursor: run.seq, note: run.note, epoch: role.epoch });
      run.phase = 'starting';
      onChange();
      try {
        const result = await send({ sessionId: run.session, content: [...content, ...context(run.session, run.recall)],
          emotion: dialogueEmotionScope('web', run.session, 'owner') }, signal);
        const receipt = result?.result?.value ?? result;
        if (result?.result?.ok === false || !(receipt?.accepted === true || receipt?.command)) {
          throw chatError(502, 'WEB_DSH_REJECTED', 'DSH 拒绝接收这一轮。');
        }
      } finally {
        if (isActive(run)) run.checkAfter = Date.now() + 5000;
      }
    });
  }

  async function reconcile(run) {
    try {
      const result = await history(run.session);
      if (result.hasMore && result.records?.[0]?.event?.seq > run.seq + 1) {
        finish(run, 'failed', '旧回合超出自动恢复范围。请在 DSH 中查看已完成的操作。');
        return;
      }
      for (const entry of result.records) {
        if (!isActive(run)) return;
        applyEvent(run, entry.event);
      }
      if (!isActive(run)) return;
      const state = await controller.state({ sessionId: run.session }, AbortSignal.timeout(5000));
      if (!isActive(run)) return;
      if (state.running === false && !state.pendingInput?.length && !state.queue?.length && !state.active) {
        // An idle host with no terminal event cannot prove that a tool never ran.
        // Explicit resend is available; recovery itself never resubmits an uncertain turn.
        finish(run, 'failed', 'DSH 已空闲，但上轮结果无法确认。请先核对已执行的工具，再决定是否重发。');
      }
    } catch (error) {
      if (error?.code === 'session/not-found') finish(run, 'failed', 'DSH 会话已经不存在。请重新发送。');
      else log('暂时无法恢复 DSH 回合', error);
    }
  }

  let working = false;
  async function tick() {
    if (working || lifecycle.signal.aborted) return;
    working = true;
    try {
      const { chat, role } = current();
      const session = webSessionId(chat);
      for (const run of active.values()) {
        if (run.chat !== chat || run.epoch !== role.epoch) closeRequests(run);
        if (run.checkAfter && run.checkAfter <= Date.now()) {
          run.checkAfter = Date.now() + 5000;
          await reconcile(run);
        }
      }
      if (active.has(session) || lifecycle.signal.aborted) return;
      const id = store.queue(chat);
      if (!id) return;
      const job = store.turn(id);
      const run = { id, chat, session, kind: job.kind, epoch: job.epoch ?? role.epoch, parts: [], files: [], draft: '', note: job.note || '',
        phase: job.state === 'queued' ? 'queued' : 'recovering', seq: job.cursor ?? -1, tool: '', checkAfter: 0 };
      active.set(session, run);
      if (job.state === 'submitted') {
        run.checkAfter = Date.now();
        return;
      }
      onChange();
      void submit(run, job, role).catch((error) => {
        if (!isActive(run) || lifecycle.signal.aborted) return;
        if (store.turn(id)?.state === 'submitted' && error?.code !== 'WEB_DSH_REJECTED') {
          run.phase = 'recovering';
          run.checkAfter = Date.now();
          onChange();
        } else finish(run, 'failed', error?.hint ? error.message + ' ' + error.hint : '无法启动 DSH 回合。' + defaultHint);
        log('DSH 回合提交失败', error);
      });
    } finally {
      working = false;
    }
  }

  try {
    disposers.push(ctx.on('session/event', event, { global: true }));
    disposers.push(ctx.on('agent/assistant-stream', stream, { global: true }));
    disposers.push(ctx.on('approval/request', (request, next) => ask('approval', request, next), { global: true, prepend: true }));
    disposers.push(ctx.on('user-questions/request', (request, next) => ask('question', request, next), { global: true, prepend: true }));
  } catch (error) {
    for (const dispose of disposers) dispose?.();
    throw error;
  }

  return {
    session: () => webSessionId(current().chat),
    recallFor: (id) => active.get(id)?.recall || '',
    knownSession(id) {
      const run = active.get(id);
      if (!run) return false;
      const { chat, role } = current();
      return Boolean(chat === run.chat && role.epoch === run.epoch);
    },
    sendImage({ file, caption }, execution) {
      const run = active.get(execution?.agent?.session?.id);
      const { chat, role } = current();
      if (!run?.admitted || run.chat !== chat || run.epoch !== role.epoch || !execution.callId) {
        throw chatError(403, 'WEB_IMAGE_SCOPE', '只有当前网页私聊回合可以发送图片。');
      }
      try {
        const workspace = fs.realpathSync(config().cwd);
        const source = fs.realpathSync(path.resolve(workspace, String(file ?? '')));
        if (!source.startsWith(workspace + path.sep)) throw new Error('path');
        const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        let image;
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || stat.size > WEB_IMAGE_LIMIT) throw new Error('size');
          const bytes = Buffer.alloc(stat.size);
          if (fs.readSync(fd, bytes, 0, stat.size, 0) !== stat.size) throw new Error('read');
          image = parseWebImage(bytes.toString('base64'));
        } finally { fs.closeSync(fd); }
        if (!image) throw new Error('format');
        const id = 'web-file-' + createHash('sha256').update(JSON.stringify([run.id, execution.callId])).digest('hex');
        store.publishImage(chat, run.id, id, image, typeof caption === 'string' ? caption.slice(0, 2000) : '');
        onChange();
        return { ok: true };
      } catch {
        throw chatError(400, 'WEB_IMAGE_FILE', '无法发送这张本地图片。', '请使用当前会话工作目录中 8 MB 内的 PNG、JPEG、GIF 或 WebP 文件。');
      }
    },
    answer,
    tick,
    status(chat) {
      const run = active.get(webSessionId(chat));
      const requests = [...pending.values()].filter((item) => item.run === run).map((item) => item.card);
      if (!run) return { phase: store.queue(chat) ? 'queued' : 'idle', requests };
      return { id: run.id, phase: requests.length ? 'approval' : run.phase, tool: run.tool,
        draft: [...run.parts, run.draft].filter(Boolean).join('\n\n'), note: run.note, requests };
    },
    dispose() {
      lifecycle.abort();
      for (const dispose of disposers) dispose?.();
      for (const request of pending.values()) request.finish(request.fallback);
      active.clear();
    },
  };
}
