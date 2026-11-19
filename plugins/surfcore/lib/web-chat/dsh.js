import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parsePurposeMemo } from '../../../../src/purpose-engine.js';
import { dialogueEmotionScope } from '../../../../src/emotion-events.js';
import { WEB_IMAGE_LIMIT, parseWebImage, webImagePrompt, webQuote, webContextMessage } from './media.js';
import { waitForWebMessages } from './wait.js';
import { imageTypeOf, webStickerCatalog, loadWebSticker, readRawStickerStore, webStickerEntries, writeStickerNote } from './stickers.js';
import { listVoiceFiles, readVoiceFile, synthesizeVoice, transcribeWebAudio } from './voice.js';
import { markReopened, writeClosure } from './closure.js';
import { listWorkspaceImages } from './workspace.js';

const defaultHint = '可以稍后重试，或在 DSH 中查看鱼姬之家会话。';
export const chatError = (status, code, message, hint = defaultHint) => Object.assign(new Error(message), { status, code, hint });
// 保留已安装会话的 ID。每轮上下文带上当前发言协议。
const SESSION_TAG = '7eec0b8f';
export const webSessionId = (chat) => `surfcore-web5-${SESSION_TAG}-${createHash('sha256').update(chat).digest('hex').slice(0, 24)}`;
export const WEB_PRESET = 'web-chat';

export function createWebDsh({ ctx, store, dispatch, identity, config, context, recall, budget, onMessage, onChange, log, guardOutput, makeHandoff }) {
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

  function finish(run, state, failure = '', retryable = !run.admitted) {
    if (!isActive(run)) return;
    const job = store.turn(run.id);
    if (state === 'done' && job.kind === 'user' && !job.closed && !store.publishedReplies(run.id).length) {
      state = 'failed';
      failure = '这一轮结束时没有发出聊天消息。可以在 DSH 检查这轮，再发起新消息。';
    }
    store.finalize(run.id, { state, failure, note: run.note, memo: run.memo, retryable,
      queuedIds: run.jobs.slice(1).map(({ id }) => id) });
    active.delete(run.session);
    closeRequests(run);
    onChange();
  }

  function admit(run, turn) {
    if (run.admitted && run.turn !== undefined) return;
    run.turn = turn ?? run.latestTurn;
    run.admitted = true;
    run.admittedAt ??= Date.now();
    store.update(run.id, 'submitted', { admitted: true, dshTurn: run.turn, admittedAt: run.admittedAt });
  }

  function applyEvent(run, event) {
    if (!event || (Number.isSafeInteger(event.seq) && event.seq <= run.seq)) return;
    if (Number.isSafeInteger(event.seq)) run.seq = event.seq;
    const data = event.data ?? {};
    if (event.type === 'turn/start') run.latestTurn = data.turn;
    if (event.type === 'user/message' && data.source?.rpcId === run.id) {
      admit(run, data.turn);
    }
    if (event.type === 'agent/inbox/spliced' && data.inserted?.some((message) => message.source?.rpcId === run.id)) {
      admit(run, data.turn);
    }
    if (!run.admitted) return;
    if (run.turn !== undefined && data.turn !== undefined && data.turn !== run.turn) return;
    if (data.turn !== undefined && run.recovery) run.recovery = null;
    if (event.type === 'assistant/message') {
      if (run.kind === 'purpose') {
        const text = data.message?.content?.filter(({ type }) => type === 'text').map(({ text: value }) => value).join('\n') ?? '';
        run.memo = parsePurposeMemo(text.slice(-2400)) ?? run.memo;
      }
      run.phase = 'running';
    } else if (event.type === 'tool/call') {
      run.phase = 'tool';
      run.tool = String(data.toolName ?? data.name ?? data.call?.name ?? '').slice(0, 120);
    } else if (event.type === 'tool/result') {
      run.phase = 'running';
    } else if (event.type === 'turn/end') {
      const reason = data.reason?.kind;
      if (reason === 'completed') finish(run, 'done');
      else finish(run, 'failed', reason === 'aborted' ? '回合已停止。请在 DSH 核对本轮进度后再发消息。' : 'DSH 回合失败。请在 DSH 检查模型、图片能力或工具权限。');
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
    if (frame.type === 'start' && run.phase !== 'running') {
      run.phase = 'running';
      onChange();
    }
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

  // 网页会话挂进 DSH 的「鱼姬之家」工作区，否则侧栏看不到这段对话。
  let workspaceId = null;
  let workspaceBusy = null;
  async function ensureWorkspace() {
    if (workspaceId) return workspaceId;
    if (workspaceBusy) return workspaceBusy;
    workspaceBusy = (async () => {
      try {
        const controller = ctx.get?.('workspaceController') ?? ctx.workspaceController;
        if (!controller?.create) return null;
        const dir = config().cwd;
        fs.mkdirSync(dir, { recursive: true });
        const value = await controller.create({ path: dir });
        const workspace = value?.workspace ?? value?.data?.workspace ?? value;
        const id = String(workspace?.workspaceId ?? '').trim();
        if (!id) return null;
        workspaceId = id;
        if (value?.created && typeof controller.rename === 'function') {
          try { await controller.rename({ workspaceId: id, title: '鱼姬之家' }); } catch {}
        }
        return id;
      } catch (error) {
        log('网页私聊工作区创建失败，退回 cwd', error);
        workspaceBusy = null;
        return null;
      }
    })();
    return workspaceBusy;
  }

  async function sessionPreset() {
    try {
      const service = ctx.get?.('agentPresets') ?? ctx.agentPresets;
      const listed = typeof service?.list === 'function' ? await service.list() : null;
      const rows = Array.isArray(listed) ? listed : (Array.isArray(listed?.presets) ? listed.presets : []);
      return rows.some((row) => String(row?.id ?? '') === WEB_PRESET) ? WEB_PRESET : '';
    } catch { return ''; }
  }

  async function ensureSession(session) {
    try { return await history(session); }
    catch (error) { if (error?.code !== 'session/not-found') throw error; }
    const params = { sessionId: session };
    const id = await ensureWorkspace();
    if (id) params.workspaceId = id;
    else params.cwd = config().cwd;
    const preset = await sessionPreset();
    if (!preset) throw chatError(503, 'WEB_PRESET_UNAVAILABLE', 'DSH 尚未加载网页私聊预设。', '重开 DSH 后再试。');
    await controller.create({ ...params, agentPreset: preset });
    return history(session);
  }

  async function userContext(run, message, signal = lifecycle.signal) {
    const value = webContextMessage(message, 20_000);
    const audio = value.media?.find(({ kind }) => kind === 'audio');
    if (!audio) return value;
    const saved = store.transcript(run.chat, message.id);
    if (saved) return { ...value, transcript: saved };
    const file = store.attachment(run.chat, audio.id);
    try {
      if (file) {
        const { text, clipped } = await transcribeWebAudio(file, config(), signal);
        if (text) {
          value.transcript = text;
          if (!signal.aborted && current().chat === run.chat && current().role.epoch === run.epoch
              && store.rememberTranscript(run.chat, message.id, text)) {
            onMessage({ ...message, transcript: text, transcriptOnly: true }, run);
          }
        }
        if (clipped) {
          value.audioStatus = '转写限制在前 90 秒和 2000 字，后续内容未提供。';
          run.note = '这条语音的转写最多保留前 90 秒和 2000 字。';
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      log('网页语音转写失败', error);
    }
    if (!value.transcript) {
      value.audioStatus = '本地转写不可用。只按用户附言接话，必要时请用户补一句文字。';
      run.note = '这条语音未能转写，鱼姬可以阅读你填写的附言。';
    }
    return value;
  }

  async function submit(run, job, role) {
    const signal = lifecycle.signal;
    return dispatch.enqueue({ id: job.id, role, source: 'web', priority: job.kind !== 'user' ? 'scheduled' : 'manual', signal }, async (send) => {
      if (current().role.epoch !== role.epoch || current().chat !== run.chat) {
        throw chatError(409, 'WEB_ROLE_CHANGED', '角色已切换。');
      }
      if (job.kind !== 'user' && !job.dive && !config().proactive) throw chatError(409, 'WEB_CARRIER_CHANGED', '主动投递已切换。');
      if ((await budget?.block('other'))?.blocked) throw chatError(429, 'WEB_BUDGET', '已达到模型用量上限。', '在 SurfCore 用量页检查预算，再重试。');
      const userJobs = run.jobs ?? [job];
      const content = [];
      const imageIds = [];
      const snapshotMessages = [];
      let lastText = '';
      if (job.kind !== 'user') content.push({ type: 'text', text: job.purpose.prompt });
      else {
        for (const item of userJobs) {
          const user = store.message(item.id);
          if (!user) continue;
          snapshotMessages.push({ ...await userContext(run, user, signal), sender: '私聊', userId: 'web-owner', isOwner: true, time: user.at });
          lastText = snapshotMessages.at(-1)?.transcript || user.text || lastText;
          for (const { id } of user.attachments.filter(({ type }) => type.startsWith('image/'))) imageIds.push(id);
        }
        if (snapshotMessages.length) {
          const snapshot = {
            conversationKey: `web:${run.session}`, messages: snapshotMessages,
            unreadCount: snapshotMessages.length,
            readThroughSeq: Math.max(...snapshotMessages.map((message) => Number(message.seq) || 0)),
            partial: false,
          };
          content.push({ type: 'text', text: `【本次消息快照】\n${JSON.stringify(snapshot)}\n以上消息已提供，无需重复查询；先处理当前消息；回复前如需确认后续补充，用 web_chat_wait(purpose=\"reply\") 补足短静默，已安静够久会立即返回，不要先长等。\n回合最后另起一段写「内部备忘」——这段不会发到网页，千万别写进 message：\n【目的】一句话说清你这次想做什么\n【需求】玩 / 学 / 装 / 陪 / 关心 / 分享 / 自我 / 创作 / 体验\n【情绪】一句话（可选；不用硬编）\n【类型】分享 / 索取 / 关心 / 好奇\n【状态】完成 / 待续 / 跳过\n【待续】下次还想追问什么；没有就写「无」` });
        }
        if (imageIds.length > 4) {
          content.push({ type: 'text', text: '只随回合附最后四张图。较早的可用附件 ID 获取看图凭证。' });
        }
        const files = imageIds.slice(-4).map((id) => store.attachment(run.chat, id)).filter(Boolean);
        const images = await Promise.all(files.map((file) => webImagePrompt(file, config())));
        for (const { blocks, note } of images) {
          content.push(...blocks);
          if (note) run.note = note;
        }
      }
      run.recall = lastText ? await recall?.(lastText) : '';
      const previous = await ensureSession(run.session);
      signal.throwIfAborted();
      run.seq = Number(previous.cursor);
      if (!Number.isSafeInteger(run.seq)) throw chatError(502, 'WEB_DSH_EVENTS', '无法读取 DSH 会话游标。');
      run.readSeq = job.kind === 'user' ? Math.max(0, ...snapshotMessages.map(({ seq }) => seq)) : store.beforeFirstQueuedUser(run.chat);
      const head = context(run.session, run.recall, run.readSeq, lastText);
      store.submit(run.id, userJobs.slice(1).map(({ id }) => id),
        { cursor: run.seq, readSeq: run.readSeq, note: run.note, epoch: role.epoch });
      run.phase = 'starting';
      onChange();
      try {
        const result = await send({ sessionId: run.session, content: [...head, ...content],
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
    let historyFailed = false;
    try {
      const result = await history(run.session);
      if (result.hasMore && result.records?.[0]?.event?.seq > run.seq + 1) {
        historyFailed = true;
      } else {
        for (const entry of result.records) {
          if (!isActive(run)) return;
          applyEvent(run, entry.event);
        }
      }
    } catch (error) {
      if (!isActive(run)) return;
      if (error?.code === 'session/not-found') {
        finish(run, 'failed', 'DSH 会话已经不存在。请先核对这一轮的结果，再发起新消息。', false);
        return;
      }
      historyFailed = true;
      log('网页回合历史回读失败', error);
    }
    if (!isActive(run)) return;

    let stateFailed = false;
    try {
      const state = await controller.state({ sessionId: run.session }, AbortSignal.timeout(5000));
      if (!isActive(run)) return;
      const idle = state.running === false && Array.isArray(state.pendingInput) && !state.pendingInput.length
        && (Array.isArray(state.queue) ? !state.queue.length : state.queue === null && state.active === false)
        && !state.active;
      if (idle) {
        const message = historyFailed ? 'DSH 已空闲，但会话历史不可读。请核对这一轮的结果，再发起新消息。'
          : 'DSH 已空闲，但上轮结果无法确认。请在 DSH 核对后再发起新消息。';
        finish(run, 'failed', message, false);
        return;
      }
    } catch (error) {
      if (!isActive(run)) return;
      if (error?.code === 'session/not-found') {
        finish(run, 'failed', 'DSH 会话已经不存在。请先核对这一轮的结果，再发起新消息。', false);
        return;
      }
      stateFailed = true;
      log('网页回合状态回读失败', error);
    }
    const recovery = historyFailed || stateFailed ? {
      code: 'WEB_DSH_RECOVERY',
      error: stateFailed ? '暂时无法确认 DSH 回合状态。后续消息已保存。' : 'DSH 会话历史暂不可读。后续消息已保存。',
      hint: '网页会继续核对。若一直未恢复，请在 SurfCore → 概览检查调度，或在 DSH 检查该会话。',
    } : null;
    if (run.recovery?.error !== recovery?.error) {
      run.recovery = recovery;
      onChange();
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
        if (run.chat !== chat || run.epoch !== role.epoch) {
          finish(run, 'failed', '角色已切换，请在原角色的 DSH 会话核对这一轮。', false);
          continue;
        }
        if (run.checkAfter && run.checkAfter <= Date.now()) {
          run.checkAfter = Date.now() + 5000;
          await reconcile(run);
        }
      }
      if (active.has(session) || lifecycle.signal.aborted) return;
      const id = store.queue(chat);
      if (!id) return;
      const job = store.turn(id);
      // 连发合并：等最后一条消息安静 batchMs 再开始；这期间的新消息并进同一轮。
      const batchMs = Math.max(0, Number(config().batchMs) || 0);
      let jobs = [job];
      if (job.state === 'queued' && batchMs > 0 && job.kind === 'user') {
        const queued = store.queuedUserTurns(chat);
        const window = queued.length ? queued.slice(0, 12) : [job];
        const lastAt = Math.max(...window.map((item) => Number(item.at) || 0));
        if (window.length < 12 && Date.now() - lastAt < batchMs && Date.now() - window[0].at < 2 * batchMs) return;
        jobs = window;
      }
      const run = { id, chat, session, kind: job.kind, epoch: job.epoch ?? role.epoch, note: job.note || '',
        jobs, readSeq: job.readSeq ?? store.message(id)?.seq ?? store.cursor(chat),
        admitted: job.admitted === true, admittedAt: job.state === 'submitted' ? (job.admittedAt ?? job.at) : undefined, turn: job.dshTurn, closed: job.closed === true,
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

  // 只有当前网页回合能发言/收尾；和 sendImage 同一把锁（chat + 角色 epoch + admitted）。
  function runFor(execution, code, message) {
    const run = active.get(execution?.agent?.session?.id);
    const { chat, role } = current();
    if (!run?.admitted || run.chat !== chat || run.epoch !== role.epoch) {
      throw chatError(403, code, message);
    }
    return run;
  }

  function publish(run, execution, channel, item, payload) {
    const bound = runFor(execution, 'WEB_TURN_ENDED', '这一轮已结束，消息没有发出。');
    if (bound !== run || run.closed) throw chatError(409, 'WEB_TURN_ENDED', '这一轮已结束，消息没有发出。');
    const call = execution.callId || randomUUID();
    const id = 'web-' + channel + '-' + createHash('sha256').update(JSON.stringify([run.id, call, item])).digest('hex');
    const message = store.publishReply(run.chat, run.id, id, payload);
    if (message) {
      onMessage({ ...message, transcript: payload.transcript }, run);
      onChange();
    }
  }

  /**
   * web_chat_send_message：和 QQ 的 qq_send_message 同一个语义——
   * 一次调用发 1~8 条，条与条之间按随机间隔落库（页面通过 SSE 逐条出现）。
   * 普通的文字输出只是思考，不会显示。
   */
  // 和 QQ 的 burstIntervalMin/Max + longGap 一致：条间 1~3 秒，10% 概率 2.5~5 秒。
  function nextGap() {
    if (Math.random() < 0.1) return 2500 + Math.round(Math.random() * 2500);
    return 1000 + Math.round(Math.random() * 2000);
  }

  async function sendMessages({ messages, gaps, replyTo } = {}, execution) {
    const run = runFor(execution, 'WEB_MESSAGE_SCOPE', '只有当前网页私聊回合可以发言。');
    const list = (Array.isArray(messages) ? messages : [messages])
      .map((text) => String(text ?? '').trim().slice(0, 500)).filter(Boolean).slice(0, 8);
    if (!list.length) throw chatError(400, 'WEB_MESSAGE_EMPTY', '消息不能为空。');
    guardOutput?.(run.chat, list.join(''));
    for (let index = 0; index < list.length; index += 1) {
      if (index > 0) {
        const asked = Number(gaps?.[index - 1]);
        const wait = Number.isFinite(asked) && asked >= 0
          ? Math.min(asked, 10000)
          : nextGap();
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      let quote = null;
      if (index === 0 && replyTo) {
        const target = store.messageOf(run.chat, String(replyTo));
        if (target) quote = webQuote(target);
      }
      publish(run, execution, 'text', index, { text: list[index], quote });
    }
    return {
      ok: true, count: list.length,
      // QQ preset 原文（qq-chat-v2 第 88 行），只换工具名；放在发送结果里，避免她发完直接停。
      reminder: '【回复后】能自然收尾就结束本轮。确实要等主人补充时才用 web_chat_wait。单次最多 30 秒，整轮累计最长窗口 2 分钟，连续两次等不到就收尾。返回 stopped 后先接住已经读到的话，然后结束本轮；之后的新消息会另开回合。',
    };
  }

  /** web_chat_list_stickers：给她看收藏表情的编号/情绪/内容。 */
  function listStickers(execution) {
    runFor(execution, 'WEB_STICKER_SCOPE', '只有当前网页私聊回合可以读表情目录。');
    return { ok: true, stickers: webStickerCatalog(config()) };
  }

  /** web_collect_sticker：把聊天里的一张图收进网页表情（只影响网页）。 */
  function collectSticker({ messageId, emotion, content, keywords } = {}, execution) {
    const { chat } = runFor(execution, 'WEB_STICKER_SCOPE', '只有当前网页私聊回合可以收藏表情。');
    const message = store.messageOf(chat, String(messageId || '')) ?? store.messageByAttachment(chat, String(messageId || ''));
    const images = message?.attachments?.filter(({ type }) => type.startsWith('image/')) ?? [];
    const attachment = images.find(({ id }) => id === messageId) ?? images[0];
    if (!attachment) throw chatError(400, 'WEB_STICKER_EMPTY', '这条消息没有图片。');
    const file = store.attachment(chat, attachment.id);
    if (!file) throw chatError(400, 'WEB_STICKER_EMPTY', '图片读不出来。');
    const id = 'web-' + createHash('sha256').update(file.bytes).digest('hex').slice(0, 16);
    const dir = config().stickersCollected;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ext = file.type.includes('png') ? '.png' : file.type.includes('gif') ? '.gif' : file.type.includes('webp') ? '.webp' : '.jpg';
    const pathFile = path.join(dir, id + ext);
    if (!fs.existsSync(pathFile)) fs.writeFileSync(pathFile, file.bytes, { mode: 0o600 });
    const notesFile = config().stickersWeb;
    const list = readRawStickerStore(notesFile);
    if (!list.some((row) => row.id === id)) {
      const no = Math.max(99, ...webStickerEntries(config()).map(({ no }) => no)) + 1;
      list.push({ no, id, file: pathFile, emotion: String(emotion || ''), content: String(content || ''), keywords: Array.isArray(keywords) ? keywords : [] });
      fs.writeFileSync(notesFile, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
    }
    return { ok: true, sticker: id };
  }

  /** web_sticker_note：网页侧的表情备注（QQ 看不到）。 */
  function noteSticker({ sticker, emotion, content, keywords } = {}, execution) {
    runFor(execution, 'WEB_STICKER_SCOPE', '只有当前网页私聊回合可以改表情备注。');
    const saved = writeStickerNote(config().stickerNotes, sticker, { emotion, content, keywords });
    return { ok: true, note: saved };
  }

  /** web_chat_send_sticker：发一张收藏表情（图片附件，一条只能一张）。 */
  async function sendSticker({ sticker }, execution) {
    const run = runFor(execution, 'WEB_STICKER_SCOPE', '只有当前网页私聊回合可以发表情。');
    let file;
    try { file = await loadWebSticker(config(), sticker); }
    catch (error) { throw chatError(502, 'WEB_STICKER_FETCH', '这张表情暂时取不到。', '稍后再试或换一张。'); }
    if (!file) throw chatError(404, 'WEB_STICKER_NOT_FOUND', '没有这张表情。', '先用 web_chat_list_stickers 查编号。');
    publish(run, execution, 'sticker', 0, { files: [file], action: 'sticker' });
    return { ok: true, sticker };
  }

  async function waitMessages(args = {}, execution) {
    const signal = execution.signal ?? lifecycle.signal;
    const run = runFor(execution, 'WEB_WAIT_SCOPE', '只有当前网页私聊回合可以等待。');
    if (run.waiting) throw chatError(409, 'WEB_WAIT_BUSY', '当前回合正在等待一条消息。', '请等待上一次调用返回。');
    function ensureActive() {
      if (runFor(execution, 'WEB_WAIT_SCOPE', '等待期间，这轮网页私聊已经结束。') !== run || run.closed) {
        throw chatError(409, 'WEB_TURN_ENDED', '当前回合已经收尾。');
      }
    }
    ensureActive();
    return waitForWebMessages(run, args, {
      store, signal, ensureActive, onChange, toSnapshot: (message) => userContext(run, message, signal),
    });
  }

  async function getContextSnapshot({ afterSeq, beforeSeq, limit, textChars } = {}, execution) {
    const run = runFor(execution, 'WEB_CONTEXT_SCOPE', '只有当前网页私聊回合可以补读聊天记录。');
    const after = Number.isSafeInteger(afterSeq) && afterSeq >= 0 ? afterSeq : null;
    const before = Number.isSafeInteger(beforeSeq) && beforeSeq > 0 ? beforeSeq : null;
    const chars = Math.min(Math.max(Number(textChars) || 400, 40), 2000);
    const { messages, more } = store.history(run.chat, { before, after, limit });
    // Explicit forward reads consume only the queued messages actually shown on this page.
    const forward = after !== null && before === null && !run.closed;
    const signal = execution.signal ?? lifecycle.signal;
    const visible = await Promise.all(messages.map(async (message) => {
      if (!forward || message.author !== 'user' || !message.attachments?.some(({ type }) => type.startsWith('audio/'))
          || !message.turnId || store.turn(message.turnId)?.state !== 'queued') return webContextMessage(message, chars);
      const snapshot = await userContext(run, message, signal);
      return { ...snapshot, text: snapshot.text.slice(0, chars) };
    }));
    signal.throwIfAborted();
    if (runFor(execution, 'WEB_CONTEXT_SCOPE', '当前网页私聊回合已经结束。') !== run) {
      throw chatError(403, 'WEB_CONTEXT_SCOPE', '当前网页私聊回合已经结束。');
    }
    if (forward && !run.closed) {
      const ids = messages.filter(({ author, turnId }) => author === 'user' && turnId).map(({ turnId }) => turnId);
      if (store.absorb(run.id, ids, run.readSeq).length) {
        run.emptyWaits = 0;
        onChange();
      }
    }
    return {
      ok: true, readThroughSeq: messages.at(-1)?.seq ?? after ?? 0, beforeSeq: messages[0]?.seq ?? before,
      hasMore: more, count: visible.length, messages: visible,
    };
  }

  function imageAccess({ kind = 'message', id } = {}, execution) {
    const run = runFor(execution, 'WEB_IMAGE_SCOPE', '只有当前网页私聊回合可以查看聊天图片。');
    if (!['message', 'sticker', 'avatar'].includes(kind) || (kind !== 'avatar' && (typeof id !== 'string' || !id || id.length > 200))) {
      throw chatError(400, 'WEB_IMAGE_REFERENCE', '图片引用无效。', '填写消息、附件或表情编号，再申请看图。');
    }
    function validate() {
      if (runFor(execution, 'WEB_IMAGE_SCOPE', '当前网页回合已经结束。') !== run) {
        throw chatError(403, 'WEB_IMAGE_SCOPE', '当前网页回合已经结束。');
      }
    }
    return async () => {
      validate();
      let images = [];
      if (kind === 'message') {
        const single = store.messageByAttachment(run.chat, id);
        const message = single ?? store.messageOf(run.chat, id);
        images = (message?.attachments ?? []).filter((attachment) => attachment.type.startsWith('image/')
          && (!single || attachment.id === id)).map((attachment) => store.attachment(run.chat, attachment.id));
      } else if (kind === 'sticker') {
        const image = await loadWebSticker(config(), id);
        if (image) images = [image];
      } else if (kind === 'avatar') {
        try {
          const bytes = fs.readFileSync(config().avatar);
          const type = imageTypeOf(bytes);
          if (type) images = [{ bytes, type }];
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      if (!images.length) throw chatError(404, 'WEB_IMAGE_MISSING', '当前会话里找不到这张图。', '先核对消息或附件 ID。');
      const decoded = await Promise.all(images.map((image) => webImagePrompt(image, config())));
      validate();
      return decoded.flatMap(({ blocks }) => blocks);
    };
  }

  /** web_chat_set_avatar：用工作目录里的图片换头像。 */
  function setAvatar({ file } = {}, execution) {
    runFor(execution, 'WEB_AVATAR_SCOPE', '只有在当前网页私聊回合里才能换头像。');
    const cwd = config().cwd;
    const wanted = String(file ?? '').trim();
    const entry = listWorkspaceImages(cwd).find((item) => item.path === wanted || item.path.endsWith('/' + wanted));
    if (!entry) throw chatError(400, 'WEB_AVATAR_FILE', '工作目录里没有这张图。', '先用 web_chat_list_images 看文件名。');
    const full = path.resolve(cwd, entry.path);
    if (!full.startsWith(path.resolve(cwd) + path.sep)) throw chatError(400, 'WEB_AVATAR_FILE', '路径不在工作目录里。');
    const bytes = fs.readFileSync(full);
    if (!imageTypeOf(bytes)) throw chatError(400, 'WEB_AVATAR_FILE', '这张图格式不支持。');
    fs.writeFileSync(config().avatar, bytes, { mode: 0o600 });
    onChange();
    return { ok: true, avatar: entry.path };
  }

  /** web_chat_list_voices：列语音库里的音频。 */
  function listVoices(execution) {
    runFor(execution, 'WEB_MEDIA_SCOPE', '只有当前网页私聊回合可以读语音目录。');
    try { return { ok: true, voices: listVoiceFiles(config().audioDir) }; }
    catch { return { ok: true, voices: [] }; }
  }

  /** web_chat_list_images：看看工作目录里有哪些图可以发。 */
  function listImages(execution) {
    runFor(execution, 'WEB_MEDIA_SCOPE', '只有当前网页私聊回合可以读图片目录。');
    return { ok: true, images: listWorkspaceImages(config().cwd) };
  }

  /** web_chat_send_voice：现场合成一条语音（像“说一句”），存成音频附件。 */
  async function sendVoice({ text, tone, intensity, voice: voiceFile }, execution) {
    const run = runFor(execution, 'WEB_VOICE_SCOPE', '只有当前网页私聊回合可以发语音。');
    let voice;
    const transcript = voiceFile ? '' : String(text ?? '').trim().slice(0, 2000);
    guardOutput?.(run.chat, transcript);
    if (voiceFile) {
      try { voice = readVoiceFile(config().audioDir, voiceFile); }
      catch (error) { throw chatError(400, 'WEB_VOICE_FILE', '语音库里没有这个文件。', String(error?.message ?? error)); }
    } else {
      try { voice = await synthesizeVoice(transcript, { outDir: config().voice, tone, intensity }); }
      catch (error) { throw chatError(502, 'WEB_VOICE_FAILED', '语音合成失败，改打字吧。', String(error?.message ?? error)); }
    }
    publish(run, execution, 'voice', 0, { files: [{ type: voice.type, bytes: voice.bytes }], transcript });
    return { ok: true, durationMs: voice.durationMs };
  }

  /** 潜水/晚点回来：这轮不回；过 minutes 分钟主动回来说一句（对应 QQ 的 set_wake_config + 主动搭话）。 */
  function dive({ minutes, summary } = {}, execution) {
    const run = runFor(execution, 'WEB_DIVE_SCOPE', '只有当前网页私聊回合可以潜水。');
    const wait = Math.min(Math.max(Number(minutes) || 0, 0), 24 * 60);
    const returnAt = wait > 0 ? Date.now() + wait * 60_000 : 0;
    const detail = String(summary ?? '').slice(0, 200);
    if (returnAt) {
      store.enqueue(run.chat, 'web-dive-' + run.id, {
        kind: 'purpose', dive: true, dueAt: returnAt, closeId: run.id,
        purpose: { prompt: '【晚点回来】你之前约好晚点来找主人，现在到时间了。自然接着上次的话，别提定时，也别编造刚发生的事。' +
          (detail ? '\n上次留下的线索：' + detail : '') },
      });
    } else store.update(run.id, 'submitted', { closed: true });
    run.closed = true;
    onChange();
    return { ok: true, returnAt, summary: detail };
  }

  /** web_chat_poke：网页版拍一拍（一条 notice，不产生她的发言）。 */
  function poke(_args, execution) {
    const run = runFor(execution, 'WEB_POKE_SCOPE', '只有当前网页私聊回合可以戳。');
    publish(run, execution, 'poke', 0, { text: '（她戳了戳你）', action: 'poke' });
    return { ok: true };
  }

  /** web_chat_close：这段聊完了/不想接。不产生消息，只是不硬回。 */
  function closeTurn(args = {}, execution) {
    const run = runFor(execution, 'WEB_CLOSE_SCOPE', '只有当前网页私聊回合可以收尾。');
    if (run.closed) return { ok: true, alreadyClosed: true };
    const webHandoff = run.kind === 'user' ? makeHandoff?.(run.chat, args.biliSummary) : null;
    store.update(run.id, 'submitted', { closed: true, webCloseAt: Date.now(), webHandoff });
    run.closed = true;
    let record = null;
    try { record = writeClosure(config().closure, { reason: args.reason, summary: args.summary, nextOpening: args.nextOpening }); } catch (error) { log('收尾记录保存失败', error); }
    return { ok: true, closure: record, ...(args.biliSummary && !webHandoff ? { biliSummaryOmitted: true } : {}) };
  }

  /** 主人又开口：冷却期内标记 reopenedAt。 */
  function onUserMessage() {
    try { markReopened(config().closure); } catch (error) { log('收尾重开标记失败', error); }
  }

  return {
    session: () => webSessionId(current().chat),
    recallFor: (id) => active.get(id)?.recall || '',
    contextMessages(throughSeq) {
      try {
        const before = Number.isSafeInteger(throughSeq) ? throughSeq + 1 : null;
        return store.history(current().chat, { before }).messages;
      }
      catch { return []; }
    },
    getContextSnapshot,
    imageAccess,
    setAvatar,
    knownSession(id) {
      const run = active.get(id);
      if (!run?.admitted) return false;
      const { chat, role } = current();
      return Boolean(chat === run.chat && role.epoch === run.epoch);
    },
    sendMessages,
    waitMessages,
    dive,
    listStickers,
    noteSticker,
    collectSticker,
    sendSticker,
    sendVoice,
    poke,
    onUserMessage,
    listVoices,
    listImages,
    closeTurn,
    sendImage({ file, caption }, execution) {
      const run = active.get(execution?.agent?.session?.id);
      const { chat, role } = current();
      if (!run?.admitted || run.chat !== chat || run.epoch !== role.epoch || !execution.callId) {
        throw chatError(403, 'WEB_IMAGE_SCOPE', '只有当前网页私聊回合可以发送图片。');
      }
      const text = typeof caption === 'string' ? caption.slice(0, 2000) : '';
      guardOutput?.(run.chat, text);
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
        publish(run, execution, 'file', 0, { files: [image], text });
        return { ok: true };
      } catch (error) {
        if (error?.status) throw error;
        throw chatError(400, 'WEB_IMAGE_FILE', '无法发送这张本地图片。', '请使用当前会话工作目录中 8 MB 内的 PNG、JPEG、GIF 或 WebP 文件。');
      }
    },
    answer,
    tick,
    status(chat) {
      const run = active.get(webSessionId(chat));
      const requests = [...pending.values()].filter((item) => item.run === run).map((item) => item.card);
      if (!run) {
        const last = store.lastTurn?.(chat);
        const read = Boolean(last && last.state === 'done' && last.replied === false);
        return { phase: store.queue(chat) ? 'queued' : 'idle', read, requests };
      }
      return { id: run.id, phase: requests.length ? 'approval' : run.recovery ? 'recovering' : run.phase, tool: run.tool,
        recovery: run.recovery, note: run.note, requests };
    },
    dispose() {
      lifecycle.abort();
      for (const dispose of disposers) dispose?.();
      for (const request of pending.values()) request.finish(request.fallback);
      active.clear();
    },
  };
}
