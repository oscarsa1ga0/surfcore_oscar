import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { json, safeEqual } from '../http-guard.js';
import { chatError, createWebDsh } from './dsh.js';
import { openWebChatStore, webId } from './store.js';
import { parseWebImage, parseWebAudio, WEB_IMAGE_LIMIT, webQuote } from './media.js';
import { imageTypeOf, loadWebSticker, webStickerCatalog } from './stickers.js';
import { createWebPurpose } from './purpose.js';

import { WEB_CHAT_API, WEB_CHAT_PORT } from './port.js';
const COOKIE = 'surfcore_web_chat';
const DAY = 86_400_000;
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/chat.css', ['chat.css', 'text/css; charset=utf-8']],
  ['/chat.js', ['chat.js', 'text/javascript; charset=utf-8']],
  ['/fish-cottage.webp', ['fish-cottage.webp', 'image/webp']],
  ['/fish-seabed.webp', ['fish-seabed.webp', 'image/webp']],
]);

export function webReplyError(res, error) {
  const known = typeof error?.status === 'number';
  json(res, known ? error.status : 503, { ok: false, code: known ? error.code : 'WEB_UNAVAILABLE',
    error: known ? error.message : '鱼姬之家暂时不可用。', hint: known ? error.hint : '在 SurfCore → 鱼姬之家检查服务状态。' });
}

async function body(req, limit = 16_384) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw chatError(415, 'WEB_JSON_REQUIRED', '请求格式无效。');
  const parts = [];
  let size = 0;
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > limit) {
        req.resume();
        throw chatError(413, 'WEB_MESSAGE_SIZE', '消息或附件超出大小限制。', '同一条消息内的附件合计最多 8 MB。');
      }
      parts.push(chunk);
    }
    return JSON.parse(Buffer.concat(parts));
  } catch (error) {
    if (error.status) throw error;
    throw chatError(400, 'WEB_JSON_INVALID', '无法读取请求内容。', '刷新页面后再试。');
  }
}

const baseStyle = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function sendAttachment(req, res, file) {
  const bytes = Buffer.from(file.bytes);
  const headers = { 'Content-Type': file.type, 'Content-Length': bytes.length, 'Accept-Ranges': 'bytes' };
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return;
  }
  const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
  const start = parts?.[1] ? Number(parts[1]) : Math.max(0, bytes.length - Number(parts?.[2]));
  const end = parts?.[1] && parts[2] ? Math.min(Number(parts[2]), bytes.length - 1) : bytes.length - 1;
  if (!parts || !(parts[1] || parts[2]) || !Number.isSafeInteger(start) || start < 0 || start > end || start >= bytes.length) {
    res.setHeader('Content-Range', 'bytes */' + bytes.length);
    throw chatError(416, 'WEB_MEDIA_RANGE', '无法读取请求的附件范围。', '刷新页面后重试播放。');
  }
  const chunk = bytes.subarray(start, end + 1);
  res.writeHead(206, { ...headers, 'Content-Length': chunk.length, 'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length });
  res.end(req.method === 'HEAD' ? undefined : chunk);
}

export function createWebChatGateway({ directory, port = WEB_CHAT_PORT, ctx, dispatch, identity, config, context, recall, budget,
  onMessage, log, guardOutput, makeHandoff, readPurposeInputs, readPurposeState, writePurposeState, focus, mood, notifyDesktop, createServer = http.createServer }) {
  let server;
  let store;
  let agent;
  let purpose;
  let timer;
  let changeTimer;
  let starting;
  let origin;
  let token;
  let lastError;
  let notificationError = '';
  let notificationTimer;
  let arrivals = 0;

  function newArrival() {
    if (!notifyDesktop || !config().desktopNotifications || subscribers.size || focus?.()) return;
    arrivals++;
    if (notificationTimer) return;
    notificationTimer = setTimeout(async () => {
      notificationTimer = undefined;
      const count = arrivals;
      arrivals = 0;
      if (!store || !config().desktopNotifications || subscribers.size || focus?.()) return;
      try {
        await notifyDesktop(count);
        notificationError = '';
      } catch (error) {
        notificationError = '桌面通知发送失败。请检查 macOS 的通知设置。';
        log('网页桌面通知失败', error);
      }
    }, 1000);
    notificationTimer.unref?.();
  }
  const pendingPairs = new Map();
  const subscribers = new Set();
  const imageTickets = new Map();

  function onChange() {
    if (changeTimer || !store) return;
    changeTimer = setTimeout(() => {
      changeTimer = undefined;
      for (const subscriber of subscribers) safePush(subscriber);
    }, 45);
    changeTimer.unref?.();
  }

  function snapshot(chat, options) {
    const current = store.snapshot(chat, options);
    const role = dispatch.status();
    const { executable, model } = config().transcription ?? {};
    return { ...current, transcriptionEnabled: Boolean(executable && model), name: identity().name, turns: store.messageTurns(chat, current.messages, { live: options?.before == null }), run: agent.status(chat),
      occupied: role.active?.source, error: lastError ?? '' };
  }

  function push(subscriber) {
    if (subscriber.res.destroyed) return;
    if (subscriber.draining) { subscriber.dirty = true; return; }
    if (!store.hasBrowserSession(subscriber.cookie)) { subscriber.res.destroy(); return; }
    if (subscriber.res.writableLength > 2_000_000) {
      subscriber.res.destroy();
      return;
    }
    const chat = identity().role.characterId;
    const changedRole = chat !== subscriber.chat;
    const value = snapshot(chat, { after: changedRole ? null : subscriber.cursor });
    if (value.reset || changedRole) {
      Object.assign(value, snapshot(chat, {}), { reset: true });
    }
    subscriber.chat = chat;
    subscriber.cursor = value.cursor;
    const writable = subscriber.res.write(`id: ${value.cursor}\ndata: ${JSON.stringify(value)}\n\n`);
    if (writable === false) {
      subscriber.draining = true;
      subscriber.dirty = value.pending;
      subscriber.res.once('drain', () => {
        subscriber.draining = false;
        if (subscriber.dirty) safePush(subscriber);
      });
    } else if (value.pending) onChange();
  }

  function safePush(subscriber) {
    try { push(subscriber); }
    catch (error) { log('聊天事件推送失败', error); subscriber.res.destroy(); }
  }

  async function handle(req, res) {
    for (const [name, value] of Object.entries(baseStyle)) res.setHeader(name, value);
    if (req.headers.host !== new URL(origin).host) throw chatError(403, 'WEB_HOST', '只允许通过本机地址访问。');
    const url = new URL(req.url, origin);
    if (url.origin !== origin) throw chatError(403, 'WEB_ORIGIN', '请求来源无效。');
    const api = url.pathname.startsWith(WEB_CHAT_API + '/');
    const route = api ? url.pathname.slice(WEB_CHAT_API.length) : url.pathname;
    if (req.method === 'GET' && files.has(route)) {
      const [file, type] = files.get(route);
      const contents = fs.readFileSync(new URL(`./${file}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': type });
      res.end(contents);
      return;
    }
    if (api && req.method === 'POST' && route === '/model-images' && !req.headers.origin
        && safeEqual(req.headers.authorization, `Bearer ${token}`)) {
      const { ticket } = await body(req) ?? {};
      const access = imageTickets.get(ticket);
      imageTickets.delete(ticket);
      if (!access || access.expires <= Date.now()) {
        throw chatError(403, 'WEB_IMAGE_TICKET', '看图凭证已用过或超时。', '回到当前网页回合重新获取凭证。');
      }
      const blocks = await access.read();
      json(res, 200, { ok: true, blocks });
      return;
    }
    if (api && req.method === 'POST' && route === '/owner-notice' && !req.headers.origin && safeEqual(req.headers.authorization, `Bearer ${token}`)) {
      const input = await body(req, 48_000);
      if (!(config().primary ?? config().proactive)) throw chatError(409, 'WEB_CARRIER_CHANGED', '网页不是当前主私聊投递目标。');
      if (input.role && input.role !== identity().role.characterId) {
        throw chatError(409, 'WEB_ROLE_CHANGED', '通知所属的角色已切换。');
      }
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 10_000) {
        throw chatError(400, 'WEB_NOTICE_INVALID', '通知内容无效。');
      }
      const id = webId(input.id) ? input.id : randomUUID();
      if (store.notice(identity().role.characterId, id, input.text)) newArrival();
      onChange();
      json(res, 201, { ok: true, id });
      return;
    }
    if (!api) throw chatError(404, 'WEB_ROUTE', '没有这个页面或操作。');
    if (req.method === 'POST' && req.headers.origin !== origin) throw chatError(403, 'WEB_ORIGIN', '跨站写操作被拒绝。');
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
      throw chatError(403, 'WEB_ORIGIN', '跨站请求被拒绝。');
    }
    if (req.method === 'POST' && route === '/pair') {
      const { code } = await body(req) ?? {};
      const expires = pendingPairs.get(code);
      if (!expires || expires < Date.now()) throw chatError(401, 'WEB_PAIR_EXPIRED', '配对链接已失效。', '回到 SurfCore → 鱼姬之家，重新点「打开并配对」。');
      pendingPairs.delete(code);
      const cookie = randomBytes(32).toString('hex');
      store.addBrowserSession(cookie, Date.now() + 30 * DAY);
      res.setHeader('Set-Cookie', `${COOKIE}=${cookie}; Path=${WEB_CHAT_API}; HttpOnly; SameSite=Strict; Max-Age=${30 * DAY / 1000}`);
      json(res, 200, { ok: true });
      return;
    }
    const cookie = String(req.headers.cookie ?? '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie) || !store.hasBrowserSession(cookie)) {
      throw chatError(401, 'WEB_PAIR_REQUIRED', '浏览器需要配对。', '在 SurfCore → 鱼姬之家点「打开并配对」。');
    }
    const profile = identity();
    const chat = profile.role.characterId;
    if (req.method === 'GET' && route === '/state') {
      const before = Number(url.searchParams.get('before'));
      json(res, 200, { ok: true, ...snapshot(chat, { before: Number.isSafeInteger(before) && before > 0 ? before : null }) });
      return;
    }
    if (req.method === 'GET' && (route === '/search' || route === '/around')) {
      if (url.searchParams.get('chat') !== chat) throw chatError(409, 'WEB_ROLE_CHANGED', '聊天角色已切换。', '请在当前聊天里重新打开历史。');
      if (route === '/search') {
        const query = (url.searchParams.get('q') ?? '').trim();
        const kind = url.searchParams.get('kind') ?? '';
        const before = Number(url.searchParams.get('before'));
        if (query.length > 100 || !['', 'image', 'audio', 'sticker'].includes(kind) || (!query && !kind)) {
          throw chatError(400, 'WEB_SEARCH_QUERY', '请填写关键词或选择附件类型。', '关键词最多 100 字。');
        }
        const result = store.search(chat, query, { kind, before: Number.isSafeInteger(before) && before > 0 ? before : null });
        json(res, 200, { ok: true, chat, ...result });
      } else {
        const id = url.searchParams.get('id');
        const result = id && id.length <= 200 ? store.around(chat, id) : null;
        if (!result) throw chatError(404, 'WEB_HISTORY_MISSING', '当前聊天中找不到那条原消息。', '可以用聊天搜索找附近的记录。');
        json(res, 200, { ok: true, chat, ...result });
      }
      return;
    }
    if (req.method === 'GET' && route === '/events') {
      const cursor = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
      if (subscribers.size >= 20) throw chatError(429, 'WEB_STREAM_LIMIT', '打开的聊天页太多。', '关闭几个重复的聊天标签页。');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const subscriber = { res, cookie, chat: url.searchParams.get('chat'), cursor: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0 };
      subscribers.add(subscriber);
      res.once('close', () => subscribers.delete(subscriber));
      safePush(subscriber);
      return;
    }
    if (req.method === 'GET' && route === '/avatar') {
      const avatarFile = config().avatar ?? path.join(directory, 'avatar.bin');
      let bytes;
      try { bytes = fs.readFileSync(avatarFile); } catch { throw chatError(404, 'WEB_AVATAR_MISSING', '头像不存在。'); }
      res.writeHead(200, { 'Content-Type': imageTypeOf(bytes) || 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
      res.end(bytes);
      return;
    }
    if (['GET', 'HEAD'].includes(req.method) && route.startsWith('/attachment/')) {
      const file = store.attachment(chat, route.slice('/attachment/'.length));
      if (!file) throw chatError(404, 'WEB_IMAGE_MISSING', '图片不存在或不属于当前角色。');
      sendAttachment(req, res, file);
      return;
    }
    if (req.method === 'GET' && route === '/stickers') {
      json(res, 200, { ok: true, stickers: webStickerCatalog(config()) });
      return;
    }
    if (req.method === 'GET' && route.startsWith('/sticker/')) {
      let image;
      try { image = await loadWebSticker(config(), decodeURIComponent(route.slice('/sticker/'.length))); }
      catch { throw chatError(502, 'WEB_STICKER_FETCH', '表情图暂时取不到。', '稍后再试或换一张。'); }
      if (!image) throw chatError(404, 'WEB_STICKER_NOT_FOUND', '这张表情已不在目录中。', '重新打开表情面板。');
      res.writeHead(200, { 'Content-Type': image.type, 'Content-Length': image.bytes.length });
      res.end(image.bytes);
      return;
    }

    function checkRole(requestChat) {
      const active = identity().role;
      if (requestChat !== chat || active.characterId !== chat || active.epoch !== profile.role.epoch) {
        throw chatError(409, 'WEB_ROLE_CHANGED', '鱼姬之家当前角色已切换。', '刷新页面后再发送。');
      }
    }

    function acceptMessage(id, data) {
      const result = store.enqueue(chat, id, data);
      if (result.conflict) throw chatError(409, 'WEB_MESSAGE_CONFLICT', '该消息标识已有不同内容。', '重新编辑后再发送。');
      const message = store.message(id);
      if (!result.duplicate) { onMessage(message, { chat, epoch: profile.role.epoch }); agent.onUserMessage(); }
      onChange();
      void tick();
      json(res, result.duplicate ? 200 : 202, { ok: true, message });
    }

    if (req.method === 'POST' && route === '/messages') {
      const data = await body(req, Math.ceil(WEB_IMAGE_LIMIT / 3) * 4 + 120_000);
      checkRole(data?.chat);
      const text = typeof data?.text === 'string' ? data.text.trim() : '';
      const uploads = data.images ?? [];
      const sticker = typeof data.sticker === 'string' ? data.sticker : '';
      const audio = data.audio;
      const poke = data.action === 'poke';
      if (!webId(data.id) || text.length > 20_000 || !Array.isArray(uploads) || uploads.length > 4
          || (!text && !uploads.length && !sticker && !audio && !poke)
          || (Number(Boolean(sticker)) + Number(Boolean(audio)) + Number(poke) + Number(uploads.length > 0) > 1)
          || (data.action !== undefined && !poke)) {
        throw chatError(400, 'WEB_MESSAGE_INVALID', '消息内容无效。', '使用文字、最多四张图片、一条语音、一个表情或拍一拍。');
      }
      const files = uploads.map(parseWebImage);
      if (audio) files.push(parseWebAudio(audio));
      if (files.some((item) => !item) || files.reduce((sum, item) => sum + item.bytes.length, 0) > WEB_IMAGE_LIMIT) {
        throw chatError(400, audio ? 'WEB_AUDIO_INVALID' : 'WEB_IMAGE_INVALID', '图片或音频格式、尺寸或文件大小不支持。', '附件合计最多 8 MB。图片用 PNG、JPEG、GIF、WebP，音频可尝试 MP3、WAV、M4A 或 WebM。');
      }
      if (sticker) {
        let image;
        try { image = await loadWebSticker(config(), sticker); }
        catch { throw chatError(502, 'WEB_STICKER_FETCH', '表情图暂时取不到。', '稍后再试或换一张。'); }
        checkRole(data.chat);
        if (!image) throw chatError(404, 'WEB_STICKER_NOT_FOUND', '这张表情已经不在目录中。', '重新打开表情面板。');
        files.push(image);
      }
      let quote = null;
      if (typeof data.quoteId === 'string' && data.quoteId) {
        const target = store.messageOf(chat, data.quoteId);
        if (!target) throw chatError(400, 'WEB_QUOTE_INVALID', '要引用的消息不存在。', '刷新后再试。');
        quote = webQuote(target);
      }
      acceptMessage(data.id, { text: poke ? '（你戳了戳她）' : text, files, quote, action: poke ? 'poke' : sticker ? 'sticker' : '' });
      return;
    }
    if (req.method === 'POST' && route === '/retry') {
      const data = await body(req);
      checkRole(data?.chat);
      const message = store.messageOf(chat, data.id);
      const [original] = message ? store.messageTurns(chat, [message]) : [];
      if (original?.state !== 'failed' || !original.retryable) {
        throw chatError(409, 'WEB_RETRY_UNCERTAIN', '这一轮可能已经执行了操作。', '请在 DSH 核对结果，再发起新消息。');
      }
      const id = 'web-retry-' + createHash('sha256').update(message.id).digest('hex');
      const files = message.attachments.map(({ id: attachmentId }) => store.attachment(chat, attachmentId));
      if (files.some((file) => !file)) throw chatError(404, 'WEB_RETRY_ATTACHMENT', '重试所需的附件已找不到。', '重新选择附件后发起新消息。');
      acceptMessage(id, { text: message.text, files, quote: message.quote, action: message.action });
      return;
    }
    if (req.method === 'POST' && route === '/answer') {
      const data = await body(req);
      agent.answer(data?.id, data);
      json(res, 200, { ok: true });
      return;
    }
    throw chatError(404, 'WEB_ROUTE', '没有这个页面或操作。', '重新打开鱼姬之家。');
  }

  async function tick() {
    if (!agent) return;
    try {
      await agent.tick();
      purpose?.tick();
      if (lastError?.startsWith('后台')) lastError = '';
    } catch (error) {
      if (!agent) return;
      lastError = '后台暂时无法处理消息。请查看 SurfCore 设置页。';
      log('后台回合检查失败', error);
      onChange();
    }
  }

  async function start() {
    if (server?.listening) return;
    if (starting) return starting;
    starting = (async () => {
      try {
        if (!['create', 'prompt', 'events', 'state'].every((key) => typeof ctx.sessionController?.[key] === 'function')) {
          throw chatError(503, 'WEB_DSH_UNSUPPORTED', '当前 DSH 缺少网页聊天所需的会话接口。', '在当前已核对的 DSH 版本重开 SurfCore。');
        }
        store = openWebChatStore(directory);
        fs.mkdirSync(config().cwd, { recursive: true, mode: 0o700 });
        const tokenPath = path.join(directory, 'notify-token');
        try { fs.writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        token = fs.readFileSync(tokenPath, 'utf8').trim();
        if (!/^[a-f0-9]{64}$/.test(token)) throw chatError(503, 'WEB_NOTIFY_TOKEN', '本地通知令牌不可读取。');
        agent = createWebDsh({ ctx, store, dispatch, identity, config, context, recall, budget, onChange, log, guardOutput, makeHandoff,
          onMessage(message, run) {
            if (message.author === 'assistant') newArrival();
            onMessage(message, run);
          },
        });
        purpose = createWebPurpose({ store, identity, config, readInputs: readPurposeInputs, readState: readPurposeState,
          writeState: writePurposeState, focus, mood, onChange });
        server = createServer((req, res) => {
          void handle(req, res).catch((error) => {
            if (!error?.status) log('HTTP 请求失败', error);
            if (!res.headersSent) webReplyError(res, error);
            else res.destroy();
          });
        });
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolve);
        });
        origin = `http://127.0.0.1:${server.address().port}`;
        lastError = '';
        let pulse = 0;
        timer = setInterval(() => {
          if (++pulse % 10 === 0) for (const subscriber of subscribers) safePush(subscriber);
          void tick();
        }, 1500);
        timer.unref?.();
        void tick();
      } catch (error) {
        stop();
        lastError = error.code === 'EADDRINUSE' ? '本机 17632 端口已占用。' : error.status ? error.message : '启动鱼姬之家失败。';
        log('启动失败', error);
        throw chatError(503, error.code === 'EADDRINUSE' ? 'WEB_PORT_IN_USE' : 'WEB_START_FAILED', lastError,
          '检查 SurfCore 日志和本机端口占用后重试。');
      } finally {
        starting = undefined;
      }
    })();
    return starting;
  }

  function stop() {
    clearInterval(timer);
    clearTimeout(notificationTimer);
    notificationTimer = undefined;
    arrivals = 0;
    clearTimeout(changeTimer);
    changeTimer = undefined;
    pendingPairs.clear();
    imageTickets.clear();
    for (const { res } of subscribers) res.destroy();
    subscribers.clear();
    server?.close();
    server?.closeAllConnections?.();
    server = undefined;
    origin = undefined;
    const oldAgent = agent;
    agent = undefined;
    oldAgent?.dispose();
    clearTimeout(changeTimer);
    changeTimer = undefined;
    purpose = undefined;
    store?.close();
    store = undefined;
  }

  return {
    start,
    stop,
    recallFor: (session) => agent?.recallFor(session) || '',
    contextApplies: (session) => agent?.knownSession(session) || false,
    contextMessages: (throughSeq) => agent?.contextMessages(throughSeq) || [],
    sendImage(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.sendImage(args, execution);
    },
    imageTicket(args, execution) {
      if (!agent || !server?.listening) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      const read = agent.imageAccess(args, execution);
      const now = Date.now();
      for (const [key, entry] of imageTickets) if (entry.expires <= now) imageTickets.delete(key);
      if (imageTickets.size >= 32) throw chatError(429, 'WEB_IMAGE_BUSY', '待取的图片太多。', '先读已取得的凭证或稍后再试。');
      const ticket = randomBytes(32).toString('hex');
      imageTickets.set(ticket, { read, expires: now + 60_000 });
      return { ok: true, ticket };
    },
    setAvatar(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.setAvatar(args, execution);
    },
    getContextSnapshot(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.getContextSnapshot(args, execution);
    },
    sendMessages(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.sendMessages(args, execution);
    },
    collectSticker(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.collectSticker(args, execution);
    },
    noteSticker(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.noteSticker(args, execution);
    },
    listStickers(execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.listStickers(execution);
    },
    sendSticker(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.sendSticker(args, execution);
    },
    dive(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.dive(args, execution);
    },
    waitMessages(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.waitMessages(args, execution);
    },
    listImages(execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.listImages(execution);
    },
    poke(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.poke(args, execution);
    },
    listVoices(execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.listVoices(execution);
    },
    sendVoice(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.sendVoice(args, execution);
    },
    closeTurn(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.closeTurn(args, execution);
    },
    status: () => ({ running: Boolean(server?.listening), url: origin ?? '', error: lastError ?? '', notificationError }),
    pair() {
      if (!server?.listening) throw chatError(503, 'WEB_DISABLED', '请先启用鱼姬之家。');
      for (const [code, expires] of pendingPairs) if (expires < Date.now()) pendingPairs.delete(code);
      if (pendingPairs.size >= 20) pendingPairs.delete(pendingPairs.keys().next().value);
      const code = randomBytes(32).toString('hex');
      pendingPairs.set(code, Date.now() + 120_000);
      return `${origin}/#pair=${code}`;
    },
    purposeStatus: () => purpose?.status() ?? null,
    purposeTry(options) {
      if (!purpose) throw chatError(503, 'WEB_DISABLED', '请先启用鱼姬之家。');
      const result = purpose.tick(options);
      if (!options?.preview) void tick();
      return result;
    },
    notice(text, id = randomUUID()) {
      if (!store || !server?.listening) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      if (store.notice(identity().role.characterId, id, text)) newArrival();
      onChange();
      return { ok: true, data: { ok: true, messageId: id } };
    },
  };
}
