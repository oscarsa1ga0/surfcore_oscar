import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { json, safeEqual } from '../http-guard.js';
import { chatError, createWebDsh } from './dsh.js';
import { openWebChatStore, webId } from './store.js';
import { parseWebImage, WEB_IMAGE_LIMIT } from './media.js';
import { createWebPurpose } from './purpose.js';

import { WEB_CHAT_API, WEB_CHAT_PORT } from './port.js';
const COOKIE = 'surfcore_web_chat';
const DAY = 86_400_000;
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/chat.css', ['chat.css', 'text/css; charset=utf-8']],
  ['/chat.js', ['chat.js', 'text/javascript; charset=utf-8']],
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
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export function createWebChatGateway({ directory, port = WEB_CHAT_PORT, ctx, dispatch, identity, config, context, recall, budget,
  onMessage, log, readPurposeInputs, readPurposeState, writePurposeState, focus, mood, createServer = http.createServer }) {
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
  const pendingPairs = new Map();
  const subscribers = new Set();

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
    return { ...current, name: identity().name, turns: store.recentTurns(chat), run: agent.status(chat),
      occupied: role.active?.source, error: lastError ?? '' };
  }

  function push(subscriber) {
    if (subscriber.res.destroyed) return;
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
    subscriber.res.write(`id: ${value.cursor}\ndata: ${JSON.stringify(value)}\n\n`);
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
      res.writeHead(200, { 'Content-Type': type });
      res.end(fs.readFileSync(new URL(`./${file}`, import.meta.url)));
      return;
    }
    if (api && req.method === 'POST' && route === '/owner-notice' && !req.headers.origin && safeEqual(req.headers.authorization, `Bearer ${token}`)) {
      const input = await body(req, 48_000);
      if (!config().proactive) throw chatError(409, 'WEB_CARRIER_CHANGED', '网页不是当前主私聊投递目标。');
      if (input.role && input.role !== identity().role.characterId) {
        throw chatError(409, 'WEB_ROLE_CHANGED', '通知所属的角色已切换。');
      }
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 10_000) {
        throw chatError(400, 'WEB_NOTICE_INVALID', '通知内容无效。');
      }
      const id = webId(input.id) ? input.id : randomUUID();
      store.notice(identity().role.characterId, id, input.text);
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
    if (req.method === 'GET' && route === '/events') {
      const cursor = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
      if (subscribers.size >= 20) throw chatError(429, 'WEB_STREAM_LIMIT', '打开的聊天页太多。', '关闭几个重复的聊天标签页。');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const subscriber = { res, chat: url.searchParams.get('chat'), cursor: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0 };
      subscribers.add(subscriber);
      res.once('close', () => subscribers.delete(subscriber));
      safePush(subscriber);
      return;
    }
    if (req.method === 'GET' && route.startsWith('/attachment/')) {
      const file = store.attachment(chat, route.slice('/attachment/'.length));
      if (!file) throw chatError(404, 'WEB_IMAGE_MISSING', '图片不存在或不属于当前角色。');
      res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.bytes.length });
      res.end(file.bytes);
      return;
    }
    if (req.method === 'POST' && route === '/messages') {
      const data = await body(req, Math.ceil(WEB_IMAGE_LIMIT / 3) * 4 + 120_000);
      if (data?.chat !== chat || identity().role.characterId !== chat || identity().role.epoch !== profile.role.epoch) {
        throw chatError(409, 'WEB_ROLE_CHANGED', '鱼姬之家当前角色已切换。', '刷新页面后再发送。');
      }
      const text = typeof data?.text === 'string' ? data.text.trim() : '';
      const uploads = data?.images ?? [];
      if (!webId(data?.id) || text.length > 20_000 || !Array.isArray(uploads) || uploads.length > 4 || (!text && !uploads.length)) {
        throw chatError(400, 'WEB_MESSAGE_INVALID', '请输入文字或添加图片。', '每条最多 20,000 字符和 4 张图片。');
      }
      const parsed = uploads.map(parseWebImage);
      if (parsed.some((item) => !item) || parsed.reduce((sum, item) => sum + item.bytes.length, 0) > WEB_IMAGE_LIMIT) {
        throw chatError(400, 'WEB_IMAGE_INVALID', '图片格式、尺寸或文件大小不支持。', '请发送 PNG、JPEG、GIF 或 WebP，单条附件合计最多 8 MB。');
      }
      let quote = null;
      if (typeof data.quoteId === 'string' && data.quoteId) {
        const quoted = store.messageOf(chat, data.quoteId);
        if (!quoted) throw chatError(400, 'WEB_QUOTE_INVALID', '要引用的消息不存在。', '刷新后再试。');
        quote = { id: quoted.id, author: quoted.author, text: String(quoted.text || '').slice(0, 200) };
      }
      const result = store.enqueue(chat, data.id, { text, files: parsed, quote });
      if (result.conflict) throw chatError(409, 'WEB_MESSAGE_CONFLICT', '该消息标识已有不同内容。', '刷新页面后重新编辑发送。');
      const message = store.message(data.id);
      if (!result.duplicate) { onMessage(message, { chat, epoch: profile.role.epoch }); agent?.onUserMessage?.(); }
      onChange();
      void tick();
      json(res, result.duplicate ? 200 : 202, { ok: true, message });
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
        agent = createWebDsh({ ctx, store, dispatch, identity, config, context, recall, budget, onMessage, onChange, log });
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
    clearTimeout(changeTimer);
    changeTimer = undefined;
    pendingPairs.clear();
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
    contextLine: () => agent?.contextLine?.() || '',
    contextMessages: () => agent?.contextMessages?.() || [],
    sendImage(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.sendImage(args, execution);
    },
    getContextSnapshot(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.getContextSnapshot(args, execution);
    },
    sendMessages(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.sendMessages(args, execution);
    },
    collectSticker(args) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.collectSticker(args);
    },
    noteSticker(args) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.noteSticker(args);
    },
    listStickers() {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.listStickers();
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
    listImages() {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.listImages();
    },
    poke(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.poke(args, execution);
    },
    listVoices() {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.listVoices();
    },
    sendVoice(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.sendVoice(args, execution);
    },
    closeTurn(args, execution) {
      if (!agent) throw chatError(503, 'WEB_DISABLED', '鱼姬之家未启动。');
      return agent.closeTurn(args, execution);
    },
    status: () => ({ running: Boolean(server?.listening), url: origin ?? '', error: lastError ?? '' }),
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
      store.notice(identity().role.characterId, id, text);
      onChange();
      return { ok: true, data: { ok: true, messageId: id } };
    },
  };
}
