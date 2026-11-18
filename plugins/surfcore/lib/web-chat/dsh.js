import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dialogueEmotionScope } from '../../../../src/emotion-events.js';
import { WEB_IMAGE_LIMIT, parseWebImage, webImagePrompt } from './media.js';
import { webStatusLine } from './prompt.js';
import { imageTypeOf, pickSticker, readRawStickerStore, readStickerCatalog, readStickerNotes, stickerBytes, writeStickerNote } from './stickers.js';
import { listVoiceFiles, readVoiceFile, synthesizeVoice } from './voice.js';
import { markReopened, writeClosure } from './closure.js';
import { listWorkspaceImages } from './workspace.js';

const textBlocks = (blocks) => (blocks ?? []).filter((part) => part.type === 'text' && typeof part.text === 'string')
  .map((part) => part.text).join('');
const defaultHint = '可以稍后重试，或在 DSH 中查看鱼姬之家会话。';
export const chatError = (status, code, message, hint = defaultHint) => Object.assign(new Error(message), { status, code, hint });
// v2：网页私聊改用 web-chat preset（和 QQ 同一套系统提示）。preset 只能在建会话时选，换 id 让新会话生效。
// v3：会话放进「鱼姬之家」工作区，DSH 侧栏可见。
// 会话 id 跟着 preset 走：preset 一改就换 id，强制 DSH 新建会话；
// 否则旧会话烘焙着旧 system prompt，DSH 会直接 blocked。
const PRESET_PATCH_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'presets', 'web-chat.patch.yml');
const presetDigest = (() => {
  try { return createHash('sha256').update(fs.readFileSync(PRESET_PATCH_FILE)).digest('hex').slice(0, 8); }
  catch { return 'v5'; }
})();
export const webSessionId = (chat) => `surfcore-web5-${presetDigest}-${createHash('sha256').update(chat).digest('hex').slice(0, 24)}`;
export const WEB_PRESET = 'web-chat';

export function createWebDsh({ ctx, store, dispatch, identity, config, context, recall, budget, onMessage, onChange, log }) {
  const controller = ctx.sessionController;
  const active = new Map();
  const pending = new Map();
  const lifecycle = new AbortController();
  const diveTimers = new Map();
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
    // 她发言走 web_chat_send_message（像 QQ 一样一条一条发），所以普通文字只是“思考”。
    // 只有整轮都没调用发送工具时，才把最后一段文字当兜底显示，避免什么都看不到。
    const text = state === 'done' && !run.sent && !run.closed ? run.parts.join('\n\n').trim() : '';
    const message = store.finalize(run.id, {
      text,
      files: state === 'done' ? run.files : [],
      state, failure, note: run.note,
      closed: run.closed, replied: run.sent > 0,
    });
    // 连发合并的其它轮：同生共死，结果/已读状态跟着第一轮走。
    for (const extra of run.extraIds ?? []) {
      store.finalize(extra, { state, failure, closed: run.closed, replied: run.sent > 0 });
    }
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
    if (preset) params.agentPreset = preset;
    try {
      await controller.create(params);
    } catch (error) {
      // preset 还没随 bundle 生效（或被人删了）时不能让网页直接不可用。
      if (!params.agentPreset) throw error;
      log(`网页私聊 preset ${WEB_PRESET} 不可用，回退默认 preset`, error);
      delete params.agentPreset;
      await controller.create(params);
    }
    return history(session);
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
      const imageBlocks = [];
      const snapshotMessages = [];
      let lastText = '';
      if (job.kind !== 'user') content.push({ type: 'text', text: job.purpose.prompt });
      else {
        for (const item of userJobs) {
          const user = store.message(item.id);
          if (!user) continue;
          const media = (user.attachments ?? []).map((_, index) => ({ kind: 'image', subType: '0', index: index + 1 }));
          snapshotMessages.push({
            seq: user.seq, messageId: user.id, sender: '私聊', userId: 'web-owner',
            text: user.text || '', isOwner: true,
            ...(user.quote ? { quote: { author: user.quote.author, text: user.quote.text, id: user.quote.id } } : {}),
            ...(media.length ? { media, hasMedia: true } : {}),
            time: user.at,
          });
          if (user.text) lastText = user.text;
          for (const { id } of user.attachments) {
            const file = store.attachment(run.chat, id);
            const { blocks, note } = await webImagePrompt(file, config());
            imageBlocks.push(...blocks);
            if (note) run.note = note;
          }
        }
        if (snapshotMessages.length) {
          const snapshot = {
            conversationKey: `web:${run.session}`, messages: snapshotMessages,
            unreadCount: snapshotMessages.length,
            readThroughSeq: Math.max(...snapshotMessages.map((message) => Number(message.seq) || 0)),
            partial: false,
          };
          content.push({ type: 'text', text: `【本次消息快照】\n${JSON.stringify(snapshot)}\n以上消息已提供，无需重复查询；先处理当前消息；回复前如需确认后续补充，用 web_chat_wait(purpose=\"reply\") 补足短静默，已安静够久会立即返回，不要先长等。` });
        }
        content.push(...imageBlocks);
      }
      run.recall = lastText ? await recall?.(lastText) : '';
      const previous = await ensureSession(run.session);
      signal.throwIfAborted();
      run.seq = Number(previous.cursor);
      if (!Number.isSafeInteger(run.seq)) throw chatError(502, 'WEB_DSH_EVENTS', '无法读取 DSH 会话游标。');
      for (const item of userJobs) store.update(item.id, 'submitted', { cursor: run.seq, note: run.note, epoch: role.epoch });
      run.phase = 'starting';
      onChange();
      try {
        const head = job.kind === 'user' ? context(run.session, run.recall) : [];
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
      // 连发合并：等最后一条消息安静 batchMs 再开始；这期间的新消息并进同一轮。
      const batchMs = Math.max(0, Number(config().batchMs) || 0);
      let jobs = [job];
      if (job.state === 'queued' && batchMs > 0 && job.kind === 'user') {
        const queued = store.queuedUserTurns(chat);
        const window = queued.length ? queued : [job];
        const lastAt = Math.max(...window.map((item) => Number(item.at) || 0));
        if (Date.now() - lastAt < batchMs) return;
        jobs = queued.length ? queued : [job];
      }
      const run = { id, chat, session, kind: job.kind, epoch: job.epoch ?? role.epoch, parts: [], files: [], draft: '', note: job.note || '',
        jobs, extraIds: jobs.slice(1).map((item) => item.id),
        sent: 0, closed: false, phase: job.state === 'queued' ? 'queued' : 'recovering', seq: job.cursor ?? -1, tool: '', checkAfter: 0 };
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
  function runFor(execution, code, message, { optional = false } = {}) {
    const run = active.get(execution?.agent?.session?.id);
    const { chat, role } = current();
    if (!run?.admitted || run.chat !== chat || run.epoch !== role.epoch) {
      if (optional) return null;
      throw chatError(403, code, message);
    }
    return run;
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
    for (let index = 0; index < list.length; index += 1) {
      if (index > 0) {
        const asked = Number(gaps?.[index - 1]);
        const wait = Number.isFinite(asked) && asked >= 0
          ? Math.min(asked, 10000)
          : nextGap();
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      if (!isActive(run) || !run.admitted) throw chatError(409, 'WEB_TURN_ENDED', '这一轮已经结束，消息没有发出。');
      let quote = null;
      if (index === 0 && replyTo) {
        const target = store.messageOf(run.chat, String(replyTo));
        if (target) quote = { id: target.id, author: target.author, text: String(target.text || '').slice(0, 200) };
      }
      const message = store.reply(run.chat, run.id, list[index], quote);
      run.sent += 1;
      onMessage(message, run);
      onChange();
    }
    return {
      ok: true, count: list.length,
      // QQ preset 原文（qq-chat-v2 第 88 行），只换工具名；放在发送结果里，避免她发完直接停。
      reminder: '【回复后】先判断这段是不是已经自然收尾：双方都收尾了就直接 web_chat_close，不用再等；还想聊、或要等对方补充，才用 web_chat_wait(purpose="messages") 等可能的回复。普通等待约 30 秒，最长 10 分钟；这个用途单传 quietMs 不会缩短没人补充时的总等待。timeout=true 只表示这次没等到消息，不是错误，不必因此重复查询。看返回的 newMessages，确需更多/更新消息才补查。可以继续等待、接话或主动发新内容，不要只等几秒就放弃。',
    };
  }

  /** web_chat_list_stickers：给她看收藏表情的编号/情绪/内容。 */
  function listStickers() {
    // 和 QQ 的 qq_list_stickers 同一个数据源、同一组字段（usage/desc/localNote/useCount 都带上）。
    const raw = readRawStickerStore();
    const notes = readStickerNotes(config().stickerNotes);
    const labels = { happy: '开心', funny: '搞笑', proud: '得意', mock: '嘲讽', tsundere: '傲娇', shy: '害羞', cute: '卖萌', wronged: '委屈', sad: '难过', angry: '生气', speechless: '无语', lazy: '摆烂', comfort: '安慰', agree: '赞同', surprise: '惊讶', goodbye: '告别', hungry: '馋饿', fear: '害怕', plain: '平淡' };
    return { ok: true, stickers: raw.map((row) => {
      const note = notes[String(row.no)] || notes[String(row.md5)] || {};
      return {
        no: Number(row.no) || 0,
        emotion: note.emotion || labels[String(row.emotion)] || String(row.emotion || ''),
        content: note.content || String(row.content ?? row.desc ?? row.localNote ?? ''),
        keywords: note.keywords || (Array.isArray(row.keywords) ? row.keywords : []),
        description: String(row.desc ?? ''), localNote: String(row.localNote ?? ''),
        usage: String(row.usage ?? ''), useCount: Number(row.useCount) || 0,
      };
    }) };
  }

  /** web_collect_sticker：把聊天里的一张图收进网页表情（只影响网页）。 */
  function collectSticker({ messageId, emotion, content, keywords } = {}) {
    const { chat } = current();
    const message = store.messageOf(chat, String(messageId || ''));
    if (!message?.attachments?.length) throw chatError(400, 'WEB_STICKER_EMPTY', '这条消息没有图片。');
    const attachment = message.attachments[0];
    const file = store.attachment(chat, attachment.id);
    if (!file) throw chatError(400, 'WEB_STICKER_EMPTY', '图片读不出来。');
    const id = 'web-' + createHash('sha256').update(JSON.stringify([messageId, file.bytes.length])).digest('hex').slice(0, 16);
    const dir = config().stickersCollected;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ext = file.type.includes('png') ? '.png' : file.type.includes('gif') ? '.gif' : file.type.includes('webp') ? '.webp' : '.jpg';
    const pathFile = path.join(dir, id + ext);
    if (!fs.existsSync(pathFile)) fs.writeFileSync(pathFile, file.bytes, { mode: 0o600 });
    const notesFile = config().stickersWeb;
    let list = [];
    try { list = JSON.parse(fs.readFileSync(notesFile, 'utf8')); } catch {}
    if (!Array.isArray(list)) list = [];
    if (!list.some((row) => row.id === id)) {
      list.push({ no: 100 + list.length, id, file: pathFile, emotion: String(emotion || ''), content: String(content || ''), keywords: Array.isArray(keywords) ? keywords : [] });
      fs.writeFileSync(notesFile, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
    }
    return { ok: true, sticker: id };
  }

  /** web_sticker_note：网页侧的表情备注（QQ 看不到）。 */
  function noteSticker({ sticker, emotion, content, keywords } = {}) {
    const saved = writeStickerNote(config().stickerNotes, sticker, { emotion, content, keywords });
    return { ok: true, note: saved };
  }

  /** web_chat_send_sticker：发一张收藏表情（图片附件，一条只能一张）。 */
  async function sendSticker({ sticker }, execution) {
    const run = runFor(execution, 'WEB_STICKER_SCOPE', '只有当前网页私聊回合可以发表情。');
    let catalog = readStickerCatalog();
    let webStickers = [];
    try { webStickers = JSON.parse(fs.readFileSync(config().stickersWeb, 'utf8')); } catch {}
    if (Array.isArray(webStickers) && webStickers.length) catalog = [...catalog, ...webStickers];
    const entry = pickSticker(catalog, sticker);
    if (!entry) throw chatError(404, 'WEB_STICKER_NOT_FOUND', '没有这张表情。', '先用 web_chat_list_stickers 查编号。');
    let file;
    try {
      if (entry.file && fs.existsSync(entry.file)) file = { type: imageTypeOf(fs.readFileSync(entry.file)) || 'image/png', bytes: fs.readFileSync(entry.file) };
      else file = await stickerBytes(entry, { dir: config().stickers });
    }
    catch (error) { throw chatError(502, 'WEB_STICKER_FETCH', '这张表情暂时取不到。', String(error?.message ?? error)); }
    const id = 'web-sticker-' + createHash('sha256').update(JSON.stringify([run.id, entry.md5 || entry.no, run.sent])).digest('hex');
    store.publishImage(run.chat, run.id, id, file, '');
    run.sent += 1;
    onChange();
    return { ok: true, sticker: entry.no };
  }

  /** web_chat_wait：对方可能没说完，等 newMessages 或超时（对应 QQ 的 qq_wait_for_messages）。 */
  async function waitMessages({ timeoutMs, quietMs, purpose } = {}, execution) {
    const run = runFor(execution, 'WEB_WAIT_SCOPE', '只有当前网页私聊回合可以等待。');
    const mode = purpose === 'reply' ? 'reply' : 'messages';
    const limit = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 600000);
    const quiet = Math.min(Math.max(Number(quietMs) || 10000, 10000), 60000);
    const startedAt = Date.now();
    // 从「这一轮已经处理过的最后一条消息」往后等：发送间隔/生成期间进来的消息不能被跳过。
    let lastSeq = 0;
    for (const item of (run.jobs ?? [])) {
      const message = store.message(item.id);
      if (message) lastSeq = Math.max(lastSeq, Number(message.seq) || 0);
    }
    for (const id of (run.extraIds ?? [])) {
      const message = store.message(id);
      if (message) lastSeq = Math.max(lastSeq, Number(message.seq) || 0);
    }
    let lastAt = mode === 'reply' ? Number(store.lastUserAt(run.chat)) || 0 : 0;
    const found = [];
    // reply：从最后来信计时；已安静够久立即返回。messages：等新消息，收到后等静默。
    if (mode === 'reply' && (!lastAt || Date.now() - lastAt >= quiet)) {
      return { ok: true, timeout: false, quiet: true, messages: [], newMessages: [] };
    }
    while (Date.now() - startedAt < limit) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!isActive(run)) break;
      const fresh = store.userMessagesAfter(run.chat, lastSeq);
      if (fresh.length) {
        lastSeq = fresh[fresh.length - 1].seq;
        found.push(...fresh);
        lastAt = Date.now();
        for (const message of fresh) {
          if (message.turnId && !run.extraIds.includes(message.turnId)) {
            run.extraIds.push(message.turnId);
            // 已经在这一轮里处理过的消息，把它的 queued 回合收掉，避免之后再单独开一轮重复回复。
            try { if (store.turn(message.turnId)?.state === 'queued') store.update(message.turnId, 'done', {}); } catch {}
          }
        }
      }
      if (lastAt && Date.now() - lastAt >= quiet) break;
    }
    const list = found.map(({ author, text, at }) => ({ author, text, at }));
    return found.length
      ? { ok: true, timeout: false, quiet: false, messages: list, newMessages: list }
      : { ok: true, timeout: true, quiet: false, messages: [], newMessages: [] };
  }

  /** web_chat_get_context_snapshot：往前/往后补读聊天记录（对应 QQ 的 qq_get_context_snapshot）。 */
  function getContextSnapshot({ afterSeq, beforeSeq, limit, textChars } = {}, execution) {
    // 只读：没有活跃网页回合时也允许读（比如 DSH 里手动续跑），chat 取当前角色。
    const activeRun = runFor(execution, 'WEB_CONTEXT_SCOPE', '读聊天记录失败。', { optional: true });
    const chat = activeRun?.chat ?? current().chat;
    const after = Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : null;
    const before = Number.isFinite(Number(beforeSeq)) ? Number(beforeSeq) : null;
    const chars = Math.min(Math.max(Number(textChars) || 400, 40), 2000);
    const take = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const rows = before !== null
      ? store.history(chat, { before, limit: take })
      : store.snapshot(chat, after !== null ? { after } : {}).messages.slice(-take);
    return {
      ok: true,
      readThroughSeq: store.cursor(chat),
      hasMore: rows.length >= take,
      count: rows.length,
      messages: rows.map((message) => ({
        seq: message.seq, id: message.id, author: message.author,
        text: String(message.text ?? '').slice(0, chars),
        at: message.at, ...(message.quote ? { quote: message.quote } : {}),
        ...(message.attachments?.length ? { media: message.attachments.length } : {}),
      })),
    };
  }

  /** web_chat_list_voices：列语音库里的音频。 */
  function listVoices() {
    try { return { ok: true, voices: listVoiceFiles(config().audioDir) }; }
    catch { return { ok: true, voices: [] }; }
  }

  /** web_chat_list_images：看看工作目录里有哪些图可以发。 */
  function listImages() {
    return { ok: true, images: listWorkspaceImages(config().cwd) };
  }

  /** web_chat_send_voice：现场合成一条语音（像“说一句”），存成音频附件。 */
  async function sendVoice({ text, tone, intensity, voice: voiceFile }, execution) {
    const run = runFor(execution, 'WEB_VOICE_SCOPE', '只有当前网页私聊回合可以发语音。');
    let voice;
    if (voiceFile) {
      try { voice = readVoiceFile(config().audioDir, voiceFile); }
      catch (error) { throw chatError(400, 'WEB_VOICE_FILE', '语音库里没有这个文件。', String(error?.message ?? error)); }
    } else {
      try { voice = await synthesizeVoice(String(text ?? ''), { outDir: config().voice, tone, intensity }); }
      catch (error) { throw chatError(502, 'WEB_VOICE_FAILED', '语音合成失败，改打字吧。', String(error?.message ?? error)); }
    }
    const id = 'web-voice-' + createHash('sha256').update(JSON.stringify([run.id, voice.bytes.length, run.sent])).digest('hex');
    store.publishImage(run.chat, run.id, id, { type: voice.type, bytes: voice.bytes }, '');
    run.sent += 1;
    onChange();
    return { ok: true, durationMs: voice.durationMs };
  }

  /** 潜水/晚点回来：这轮不回；过 minutes 分钟主动回来说一句（对应 QQ 的 set_wake_config + 主动搭话）。 */
  function dive({ minutes, summary } = {}, execution) {
    const run = runFor(execution, 'WEB_DIVE_SCOPE', '只有当前网页私聊回合可以潜水。');
    run.closed = true;
    const wait = Math.min(Math.max(Number(minutes) || 0, 0), 24 * 60);
    const { chat, role } = current();
    if (wait > 0) {
      clearTimeout(diveTimers.get(chat));
      const id = 'dive-' + createHash('sha256').update(JSON.stringify([chat, role.epoch, Date.now()])).digest('hex');
      const timer = setTimeout(() => {
        diveTimers.delete(chat);
        try {
          if (current().chat !== chat || current().role.epoch !== role.epoch) return;
          store.enqueue(chat, id, {
            kind: 'purpose', dive: true,
            purpose: { prompt: '【晚点回来】你之前说晚点再来找主人，现在到时间了。主动说一句，接着上次的话或问他在干嘛；不要提“定时/系统”，也不要编造刚才发生的事。' },
          });
          onChange();
        } catch (error) { log('晚点回来安排失败', error); }
      }, wait * 60_000);
      timer.unref?.();
      diveTimers.set(chat, timer);
    }
    return { ok: true, returnAt: wait > 0 ? Date.now() + wait * 60_000 : 0, summary: String(summary ?? '') };
  }

  /** web_chat_poke：网页版拍一拍（一条 notice，不产生她的发言）。 */
  function poke(_args, execution) {
    const run = runFor(execution, 'WEB_POKE_SCOPE', '只有当前网页私聊回合可以戳。');
    store.notice(run.chat, 'web-poke-' + Date.now(), '（她戳了戳你）');
    onChange();
    return { ok: true };
  }

  /** web_chat_close：这段聊完了/不想接。不产生消息，只是不硬回。 */
  function closeTurn(args = {}, execution) {
    const run = runFor(execution, 'WEB_CLOSE_SCOPE', '只有当前网页私聊回合可以收尾。');
    if (run.closed) return { ok: true, alreadyClosed: true };
    run.closed = true;
    let record = null;
    try { record = writeClosure(config().closure, { reason: args.reason, summary: args.summary, nextOpening: args.nextOpening }); } catch (error) { log('收尾记录保存失败', error); }
    return { ok: true, closure: record };
  }

  /** 主人又开口：冷却期内标记 reopenedAt。 */
  function onUserMessage() {
    try { markReopened(config().closure); } catch (error) { log('收尾重开标记失败', error); }
  }

  return {
    session: () => webSessionId(current().chat),
    recallFor: (id) => active.get(id)?.recall || '',
    // 每轮注入的此刻状态：和 QQ 的【此刻状态】同形，数据源是网页自己的消息。
    contextLine() {
      try { return webStatusLine({ messages: store.snapshot(current().chat, {}).messages }); }
      catch { return ''; }
    },
    contextMessages() {
      try { return store.snapshot(current().chat, {}).messages; }
      catch { return []; }
    },
    getContextSnapshot,
    knownSession(id) {
      const run = active.get(id);
      if (!run) return false;
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
      if (!run) {
        const last = store.lastTurn?.(chat);
        const read = Boolean(last && last.state === 'done' && last.replied === false);
        return { phase: store.queue(chat) ? 'queued' : 'idle', read, requests };
      }
      return { id: run.id, phase: requests.length ? 'approval' : run.phase, tool: run.tool,
        draft: '', note: run.note, requests };
    },
    dispose() {
      lifecycle.abort();
      for (const timer of diveTimers.values()) clearTimeout(timer);
      diveTimers.clear();
      for (const dispose of disposers) dispose?.();
      for (const request of pending.values()) request.finish(request.fallback);
      active.clear();
    },
  };
}
