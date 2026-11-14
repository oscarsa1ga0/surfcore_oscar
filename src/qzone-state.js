// QQ 空间本地状态：幂等 / 去重 / 发布记录 / 操作日志。
// 只属于「鱼姬」这一个角色，写在桥接 state 目录；不建独立人格、不建独立记忆。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const QZONE_STATE_FILE = path.join(ROOT, 'state', 'qzone-state.json');
export const QZONE_POSTS_FILE = path.join(ROOT, 'state', 'qzone-posts.jsonl');
export const QZONE_OP_LOG_FILE = path.join(ROOT, 'state', 'qzone-op-log.jsonl');

export function defaultQzoneState() {
  return {
    version: 1,
    // 已见过的说说（feed/列表/详情）：tid -> {authorUin, at, views}
    seen: {},
    // 点赞状态：tid -> {at, liked:true|false}
    liked: {},
    // 评论记录：tid -> [{commentId, content, at, replyTo}]
    commented: {},
    // 自己发过的说说（新→旧，最多 100 条）
    published: [],
    // 最近错误（最多 30 条）
    errors: []
  };
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function appendLine(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

export function loadQzoneState() {
  const raw = readJson(QZONE_STATE_FILE, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultQzoneState();
  const base = defaultQzoneState();
  return {
    ...base,
    version: 1,
    seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
    liked: raw.liked && typeof raw.liked === 'object' ? raw.liked : {},
    commented: raw.commented && typeof raw.commented === 'object' ? raw.commented : {},
    published: Array.isArray(raw.published) ? raw.published.slice(0, 100) : [],
    errors: Array.isArray(raw.errors) ? raw.errors.slice(-30) : []
  };
}

export function saveQzoneState(state) {
  try {
    writeJsonAtomic(QZONE_STATE_FILE, state);
    return true;
  } catch {
    return false;
  }
}

function trimMap(map, max = 500) {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  const sorted = keys
    .sort((a, b) => (Number(map[b]?.at) || 0) - (Number(map[a]?.at) || 0))
    .slice(0, max);
  const next = {};
  for (const k of sorted) next[k] = map[k];
  return next;
}

export function recordQzoneView(state, { tid, authorUin = '', at = Date.now(), text = '', nickname = '' }) {
  if (!tid) return state;
  const prev = state.seen[tid];
  state.seen[tid] = {
    authorUin: String(authorUin || prev?.authorUin || ''),
    at,
    views: (Number(prev?.views) || 0) + 1,
    text: String(text || prev?.text || '').slice(0, 200),
    nickname: String(nickname || prev?.nickname || '').slice(0, 40)
  };
  state.seen = trimMap(state.seen);
  return state;
}

export function recordQzoneLike(state, { tid, liked = true, at = Date.now() }) {
  if (!tid) return state;
  state.liked[tid] = { at, liked: liked === true };
  state.liked = trimMap(state.liked, 300);
  return state;
}

export function recordQzoneComment(state, { tid, commentId = '', content = '', replyTo = '', at = Date.now() }) {
  if (!tid) return state;
  const list = Array.isArray(state.commented[tid]) ? state.commented[tid] : [];
  list.push({ commentId: String(commentId), content: String(content).slice(0, 200), replyTo: String(replyTo), at });
  state.commented[tid] = list.slice(-20);
  return state;
}

export function recordQzonePublish(state, { tid, content, time = 0, ugcRight = 1, images = [], at = Date.now() }) {
  if (!tid) return state;
  const entry = {
    tid: String(tid),
    content: String(content).slice(0, 500),
    time: Number(time) || Math.floor(at / 1000),
    ugcRight: Number(ugcRight) || 1,
    images: (Array.isArray(images) ? images : []).slice(0, 9).map(String),
    publishedAt: new Date(at).toISOString()
  };
  state.published = [entry, ...state.published.filter((x) => x.tid !== String(tid))].slice(0, 100);
  appendLine(QZONE_POSTS_FILE, entry);
  return state;
}

export function recordQzoneError(state, { action, message = '', code = '' }) {
  state.errors.push({ at: new Date().toISOString(), action: String(action), code: String(code), message: String(message).slice(0, 300) });
  state.errors = state.errors.slice(-30);
  return state;
}

/** 操作日志（管理后台展示用；内容会先脱敏再写，见 bridge 调用处）。 */
export function qzoneOpLog({ action, tid = '', ok = true, detail = '', error = '', at = Date.now() }) {
  appendLine(QZONE_OP_LOG_FILE, {
    at: new Date(at).toISOString(),
    action: String(action),
    tid: String(tid).slice(0, 128),
    ok: ok === true,
    detail: String(detail).slice(0, 200),
    error: String(error).slice(0, 300)
  });
}

export function readQzoneOpLog(max = 30) {
  try {
    const text = fs.readFileSync(QZONE_OP_LOG_FILE, 'utf8');
    return text.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).slice(-max);
  } catch {
    return [];
  }
}

export function qzoneStatusSummary(state) {
  return {
    seen: Object.keys(state.seen).length,
    liked: Object.values(state.liked).filter((x) => x?.liked).length,
    commentedTids: Object.keys(state.commented).length,
    published: state.published.length,
    errors: state.errors.slice(-5),
    recentPosts: state.published.slice(0, 5).map((p) => ({
      tid: p.tid, content: p.content.slice(0, 80), time: p.time, ugcRight: p.ugcRight, images: p.images.length
    }))
  };
}
