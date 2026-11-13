/**
 * 角色日记（Diary）—— 平台无关的存储层。
 *
 * 定位：日记是角色**写给自己的生活记录**，和记忆卡分开：
 *   · memory-card：需要长期记住的事实/偏好/关系；
 *   · diary：某一天发生了什么、当时的想法和感受。
 *
 * 存储（每个角色独立，绝不跨角色写）：
 *   characters/<id>/diary/
 *     entries/YYYY/MM/DD/entry_001.md   # YAML front matter + 正文
 *     candidates/YYYY-MM-DD.jsonl       # 白天的候选（agent 自己用 diary_capture 记）
 *     candidates/processed/...          # 当日回顾后归档
 *     shares.jsonl                      # 每次分享的摘录（出站闸的授权凭据）
 *     index.json                        # 缓存；损坏/丢失都能从文件重建
 *     scheduler-state.json              # 每日回顾状态（插件宿主写）
 *     trash/YYYY-MM-DD/                 # 删除的日记（不直接 unlink）
 *     .lock                             # 跨进程写锁
 *
 * 设计约束：
 *   · 任何函数都不接受调用方传路径；id 只从扫描结果/index 里找；
 *   · 写操作原子（临时文件 + rename），并用每角色 `.lock` 串行化；
 *   · index 只是缓存，entries 才是真相；index 坏了就 rebuild；
 *   · 本模块不 import 插件/DSH；bridge、插件宿主、MCP 都可以复用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

export const DIARY_VERSION = 1;
export const ENTRY_MAX_CHARS = 20000;
export const CANDIDATE_MAX_CHARS = 500;
export const EXCERPT_MAX_CHARS = 2000;
export const LEAK_SHINGLE = 24;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^d-\d{8}-\d{3,}$/;
const TAGS_MAX = 12;
const TAG_MAX_CHARS = 24;
const TITLE_MAX_CHARS = 120;

// ── 基础工具 ────────────────────────────────────────────────────────────────

export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh');
}

export function resolveSurfcoreDir({ dshHome } = {}) {
  return path.join(dshHome || resolveDshHome(), 'surfcore');
}

export function localDay(now = Date.now()) {
  const d = new Date(now);
  if (!Number.isFinite(d.getTime())) throw new Error('时间戳无效');
  return d.toLocaleDateString('sv-SE');
}

function isDay(value) {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const d = new Date(`${value}T12:00:00`);
  if (!Number.isFinite(d.getTime())) return false;
  return d.toLocaleDateString('sv-SE') === value;
}

export function normalizeDay(value, fallback = '') {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (!isDay(text)) throw new Error(`日期不合法：${text}（应为 YYYY-MM-DD）`);
  return text;
}

function iso(now) {
  return new Date(now).toISOString();
}

function safeText(value, max) {
  return String(value ?? '').replace(/\u0000/g, '').slice(0, max);
}

function normalizeTags(value) {
  const list = Array.isArray(value) ? value : (value == null || value === '' ? [] : String(value).split(/[,，、\s]+/));
  const out = [];
  for (const item of list) {
    const tag = safeText(item, TAG_MAX_CHARS).replace(/[\r\n\t]+/g, ' ').trim();
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}

function normalizeVisibility(value, fallback = 'private') {
  const text = String(value ?? '').trim();
  if (text === 'shareable' || text === 'shared') return 'shareable';
  if (text === 'private' || text === '') return fallback;
  throw new Error('visibility 只能是 private 或 shareable');
}

function normalizeContent(value, { max = ENTRY_MAX_CHARS, label = '正文' } = {}) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (text.length > max) throw new Error(`${label}超过 ${max} 字上限（当前 ${text.length}）`);
  return text;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function atomicWriteFile(file, text, { mode = 0o600 } = {}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

function within(root, file) {
  const base = path.resolve(root);
  const target = path.resolve(file);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

// ── 角色 / 路径 ─────────────────────────────────────────────────────────────

export function getCurrentCharacter({ surfcoreDir } = {}) {
  const root = surfcoreDir || resolveSurfcoreDir();
  const file = path.join(root, 'characters', 'current.json');
  const current = readJson(file, null);
  if (!current || !current.id) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(current.id))) return null;
  const charDir = path.join(root, 'characters', String(current.id));
  if (!fs.existsSync(charDir)) return null;
  return { id: String(current.id), name: String(current.name || ''), epoch: Number(current.epoch) || 0, dir: charDir };
}

export function characterDiaryDir(character) {
  if (!character?.dir) throw new Error('当前没有角色，日记不可用');
  return path.join(character.dir, 'diary');
}

/** 解析这次调用要操作哪个角色的日记。id/current 都只用来拼 characters/<id>，从不信目录字段。 */
export function resolveCharacter({ surfcoreDir, characterId, characterDir } = {}) {
  if (characterDir) {
    const dir = path.resolve(characterDir);
    return { id: path.basename(dir), dir, diaryDir: path.join(dir, 'diary') };
  }
  const root = surfcoreDir || resolveSurfcoreDir();
  if (characterId) {
    const id = String(characterId);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('角色 id 不合法');
    const dir = path.join(root, 'characters', id);
    if (!fs.existsSync(dir)) throw new Error(`角色不存在：${id}`);
    return { id, dir, diaryDir: path.join(dir, 'diary') };
  }
  const current = getCurrentCharacter({ surfcoreDir: root });
  if (!current) throw new Error('当前没有加载角色；日记功能不可用');
  return { id: current.id, name: current.name, dir: current.dir, diaryDir: path.join(current.dir, 'diary') };
}

export function diaryPaths(diaryDir) {
  const root = path.resolve(diaryDir);
  return {
    root,
    entries: path.join(root, 'entries'),
    candidates: path.join(root, 'candidates'),
    processed: path.join(root, 'candidates', 'processed'),
    shares: path.join(root, 'shares.jsonl'),
    index: path.join(root, 'index.json'),
    schedulerState: path.join(root, 'scheduler-state.json'),
    trash: path.join(root, 'trash'),
    lock: path.join(root, '.lock'),
  };
}

export function ensureDiaryDir(diaryDir) {
  const p = diaryPaths(diaryDir);
  ensureDir(p.entries);
  ensureDir(p.candidates);
  ensureDir(p.processed);
  ensureDir(p.trash);
  return p;
}

// ── 写锁 ────────────────────────────────────────────────────────────────────

/**
 * 每角色一把锁。多个会话/进程可能同时写：用 mkdir 的原子性做互斥。
 * 超过 30 秒的锁视为上次进程崩溃留下的，清掉再试。
 */
export function withDiaryLock(diaryDir, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const p = ensureDiaryDir(diaryDir);
  const start = Date.now();
  let held = false;
  while (Date.now() - start <= timeoutMs) {
    try {
      fs.mkdirSync(p.lock);
      held = true;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const st = fs.statSync(p.lock);
        if (Date.now() - st.mtimeMs > staleMs) { fs.rmdirSync(p.lock); continue; }
      } catch {
        continue;
      }
      sleepSync(20);
    }
  }
  if (!held) throw new Error('日记正被另一个进程写入，请稍后重试');
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(p.lock); } catch {}
  }
}

// ── 条目读写 ────────────────────────────────────────────────────────────────

function entryDatePath(entriesDir, day) {
  const [y, m, d] = day.split('-');
  return path.join(entriesDir, y, m, d);
}

function renderEntry(meta, body) {
  const front = yaml.dump(meta, { lineWidth: -1, noRefs: true, sortKeys: false });
  return `---\n${front}---\n\n${body}\n`;
}

export function parseEntryText(text, { file = '', day = '', fallbackId = '' } = {}) {
  let raw = String(text ?? '').replace(/\r\n/g, '\n');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let meta = {};
  let body = raw;
  if (raw.startsWith('---\n')) {
    const close = raw.indexOf('\n---', 4);
    if (close !== -1) {
      const front = raw.slice(4, close);
      body = raw.slice(close + 4).replace(/^\n+/, '');
      try { meta = yaml.load(front) ?? {}; } catch { meta = {}; }
    }
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
  body = body.replace(/\s+$/, '');
  const stat = (() => { try { return fs.statSync(file); } catch { return null; } })();
  const date = isDay(String(meta.date ?? '')) ? String(meta.date) : day;
  const id = ID_RE.test(String(meta.id ?? '')) ? String(meta.id) : (fallbackId || `d-${date.replace(/-/g, '')}-000`);
  return {
    meta: {
      id,
      date,
      title: safeText(meta.title ?? '', TITLE_MAX_CHARS),
      createdAt: String(meta.createdAt ?? (stat ? stat.birthtime.toISOString() : '')),
      updatedAt: String(meta.updatedAt ?? (stat ? stat.mtime.toISOString() : '')),
      visibility: normalizeVisibility(meta.visibility, 'private'),
      tags: normalizeTags(meta.tags),
      source: safeText(meta.source ?? 'manual', 32) || 'manual',
    },
    body,
  };
}

/** 扫描全部条目文件；坏文件跳过并记在 errors，不让一条坏数据拖垮整个日记。 */
export function scanEntries(diaryDir) {
  const p = diaryPaths(diaryDir);
  const entries = [];
  const errors = [];
  const walk = (dir) => {
    let dirents = [];
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of dirents) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const match = /^entry_(\d{3,})\.md$/.exec(entry.name);
      if (!match) continue;
      const day = (() => {
        const rel = path.relative(p.entries, path.dirname(full)).split(path.sep);
        if (rel.length !== 3) return '';
        const [y, m, d] = rel;
        const candidate = `${y}-${m}-${d}`;
        return isDay(candidate) ? candidate : '';
      })();
      try {
        const text = fs.readFileSync(full, 'utf8');
        const fallbackId = day ? `d-${day.replace(/-/g, '')}-${match[1]}` : '';
        const parsed = parseEntryText(text, { file: full, day, fallbackId });
        if (!parsed.body.trim()) { errors.push({ file: path.relative(diaryDir, full), error: 'empty-body' }); continue; }
        entries.push({
          ...parsed.meta,
          date: parsed.meta.date || day,
          body: parsed.body,
          file: path.relative(diaryDir, full),
          absFile: full,
          chars: parsed.body.length,
        });
      } catch (error) {
        errors.push({ file: path.relative(diaryDir, full), error: String(error?.message ?? error).slice(0, 200) });
      }
    }
  };
  walk(p.entries);
  entries.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
  return { entries, errors };
}

function nextSeqForDay(datePath) {
  let max = 0;
  try {
    for (const name of fs.readdirSync(datePath)) {
      const m = /^entry_(\d{3,})\.md$/.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch {}
  return max + 1;
}

function readShares(diaryDir) {
  const p = diaryPaths(diaryDir);
  const out = [];
  let text = '';
  try { text = fs.readFileSync(p.shares, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed);
      if (item && typeof item === 'object') out.push(item);
    } catch {}
  }
  return out;
}

function appendShare(diaryDir, record) {
  const p = diaryPaths(diaryDir);
  ensureDir(path.dirname(p.shares));
  fs.appendFileSync(p.shares, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function rebuildIndex(diaryDir, { characterId = '' } = {}) {
  const p = diaryPaths(diaryDir);
  ensureDiaryDir(diaryDir);
  const { entries, errors } = scanEntries(diaryDir);
  const shares = readShares(diaryDir);
  const sharedIds = new Set(shares.map((item) => String(item.id ?? '')));
  const index = {
    version: DIARY_VERSION,
    characterId: characterId || '',
    updatedAt: new Date().toISOString(),
    entries: entries.map((entry) => ({
      id: entry.id,
      date: entry.date,
      title: entry.title,
      visibility: entry.visibility,
      tags: entry.tags,
      source: entry.source,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      file: entry.file,
      chars: entry.chars,
      shared: sharedIds.has(entry.id),
    })),
    shares: shares.length,
    errors,
  };
  try { atomicWriteFile(p.index, `${JSON.stringify(index, null, 2)}\n`); } catch {}
  return index;
}

export function readIndex(diaryDir) {
  const p = diaryPaths(diaryDir);
  const index = readJson(p.index, null);
  if (!index || index.version !== DIARY_VERSION || !Array.isArray(index.entries)) return null;
  return index;
}

export function ensureIndex(diaryDir, opts = {}) {
  return readIndex(diaryDir) || rebuildIndex(diaryDir, opts);
}

function findEntry(diaryDir, id) {
  const wanted = String(id ?? '').trim();
  if (!ID_RE.test(wanted)) throw new Error(`日记 id 不合法：${wanted || '（空）'}`);
  const { entries } = scanEntries(diaryDir);
  const hit = entries.find((entry) => entry.id === wanted);
  if (!hit) throw new Error(`找不到这篇日记：${wanted}`);
  if (!within(diaryPaths(diaryDir).entries, hit.absFile)) throw new Error('日记路径越界，已拒绝');
  return hit;
}

// ── 公开 API：写 / 读 / 列 / 搜 / 改 / 删 ──────────────────────────────────

export function createEntry(diaryDir, {
  content, title = '', tags = [], visibility = 'private', source = 'manual', date = '', characterId = '', now = Date.now(),
} = {}) {
  const body = normalizeContent(content);
  const today = localDay(now);
  const day = normalizeDay(date, today);
  if (day > today) throw new Error('不能给未来写日记');
  const vis = normalizeVisibility(visibility);
  const cleanTitle = safeText(title, TITLE_MAX_CHARS).replace(/[\r\n\t]+/g, ' ').trim();
  const cleanTags = normalizeTags(tags);
  const cleanSource = safeText(source, 32).replace(/[\r\n\t]+/g, ' ').trim() || 'manual';
  const stamp = iso(now);
  return withDiaryLock(diaryDir, () => {
    const p = diaryPaths(diaryDir);
    const dir = entryDatePath(p.entries, day);
    ensureDir(dir);
    const seq = nextSeqForDay(dir);
    const id = `d-${day.replace(/-/g, '')}-${String(seq).padStart(3, '0')}`;
    const file = path.join(dir, `entry_${String(seq).padStart(3, '0')}.md`);
    if (!within(p.entries, file)) throw new Error('日记路径越界，已拒绝');
    const meta = { id, date: day, title: cleanTitle, createdAt: stamp, updatedAt: stamp, visibility: vis, tags: cleanTags, source: cleanSource };
    atomicWriteFile(file, renderEntry(meta, body));
    rebuildIndex(diaryDir, { characterId });
    return { ok: true, entry: { ...meta, file: path.relative(diaryDir, file), chars: body.length } };
  });
}

export function listEntries(diaryDir, { from = '', to = '', tags = [], limit = 20 } = {}) {
  const fromDay = normalizeDay(from, '');
  const toDay = normalizeDay(to, '');
  const tagList = normalizeTags(tags);
  const max = Math.max(1, Math.min(200, Number(limit) || 20));
  const { entries, errors } = scanEntries(diaryDir);
  const shares = new Set(readShares(diaryDir).map((item) => String(item.id ?? '')));
  const filtered = entries.filter((entry) => {
    if (fromDay && entry.date < fromDay) return false;
    if (toDay && entry.date > toDay) return false;
    if (tagList.length && !tagList.every((tag) => entry.tags.includes(tag))) return false;
    return true;
  });
  return {
    ok: true,
    total: filtered.length,
    errors,
    entries: filtered.slice(0, max).map((entry) => ({
      id: entry.id,
      date: entry.date,
      title: entry.title,
      visibility: entry.visibility,
      tags: entry.tags,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      chars: entry.chars,
      shared: shares.has(entry.id),
    })),
  };
}

export function readEntries(diaryDir, { id = '', date = '', limit = 5, maxChars = 12000 } = {}) {
  const { entries, errors } = scanEntries(diaryDir);
  let picked = [];
  if (id) {
    const hit = entries.find((entry) => entry.id === String(id).trim());
    if (!hit) throw new Error(`找不到这篇日记：${id}`);
    picked = [hit];
  } else {
    const day = normalizeDay(date, localDay());
    picked = entries.filter((entry) => entry.date === day).slice(0, Math.max(1, Math.min(10, Number(limit) || 5)));
  }
  let budget = Math.max(1000, Math.min(40000, Number(maxChars) || 12000));
  const out = [];
  for (const entry of picked) {
    const body = entry.body.length > budget ? entry.body.slice(0, budget) : entry.body;
    budget -= body.length;
    out.push({
      id: entry.id,
      date: entry.date,
      title: entry.title,
      visibility: entry.visibility,
      tags: entry.tags,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      // 私人内容：给角色自己读；不能原样转给主人（出站闸会拦）。
      private: entry.visibility !== 'shareable',
      body,
      truncated: body.length < entry.body.length,
    });
    if (budget <= 0) break;
  }
  return { ok: true, entries: out, errors };
}

export function searchEntries(diaryDir, { query = '', from = '', to = '', tags = [], limit = 10 } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  const fromDay = normalizeDay(from, '');
  const toDay = normalizeDay(to, '');
  const tagList = normalizeTags(tags);
  const max = Math.max(1, Math.min(50, Number(limit) || 10));
  const { entries, errors } = scanEntries(diaryDir);
  const shares = new Set(readShares(diaryDir).map((item) => String(item.id ?? '')));
  const hits = [];
  for (const entry of entries) {
    if (fromDay && entry.date < fromDay) continue;
    if (toDay && entry.date > toDay) continue;
    if (tagList.length && !tagList.every((tag) => entry.tags.includes(tag))) continue;
    if (!q) {
      hits.push({ entry, snippet: entry.body.slice(0, 80) });
      continue;
    }
    const hay = `${entry.title}\n${entry.tags.join(' ')}\n${entry.body}`.toLowerCase();
    const at = hay.indexOf(q);
    if (at === -1) continue;
    const start = Math.max(0, at - 40);
    const snippet = `${start > 0 ? '…' : ''}${entry.body.slice(start, start + 100)}${start + 100 < entry.body.length ? '…' : ''}`;
    hits.push({ entry, snippet });
    if (hits.length >= max * 3) break;
  }
  return {
    ok: true,
    total: hits.length,
    errors,
    entries: hits.slice(0, max).map(({ entry, snippet }) => ({
      id: entry.id,
      date: entry.date,
      title: entry.title,
      visibility: entry.visibility,
      tags: entry.tags,
      private: entry.visibility !== 'shareable',
      shared: shares.has(entry.id),
      snippet,
    })),
  };
}

export function editEntry(diaryDir, {
  id, content, append, title, tags, visibility, now = Date.now(), characterId = '',
} = {}) {
  return withDiaryLock(diaryDir, () => {
    const fresh = findEntry(diaryDir, id);
    let body = fresh.body;
    if (content !== undefined && content !== null && String(content).trim() !== '') body = normalizeContent(content);
    if (append !== undefined && append !== null && String(append).trim() !== '') {
      body = normalizeContent(`${body}\n\n${normalizeContent(append, { label: '补充内容' })}`);
    }
    const meta = {
      id: fresh.id,
      date: fresh.date,
      createdAt: fresh.createdAt,
      source: fresh.source,
      updatedAt: iso(now),
      title: title === undefined ? fresh.title : safeText(title, TITLE_MAX_CHARS).replace(/[\r\n\t]+/g, ' ').trim(),
      tags: tags === undefined ? fresh.tags : normalizeTags(tags),
      visibility: visibility === undefined ? fresh.visibility : normalizeVisibility(visibility),
    };
    atomicWriteFile(fresh.absFile, renderEntry(meta, body));
    rebuildIndex(diaryDir, { characterId });
    return { ok: true, entry: { ...meta, file: fresh.file, chars: body.length } };
  });
}

export function deleteEntry(diaryDir, { id, now = Date.now(), characterId = '' } = {}) {
  const day = localDay(now);
  return withDiaryLock(diaryDir, () => {
    const hit = findEntry(diaryDir, id);
    const p = diaryPaths(diaryDir);
    const trashDir = path.join(p.trash, day);
    ensureDir(trashDir);
    let target = path.join(trashDir, path.basename(hit.absFile));
    if (fs.existsSync(target)) target = path.join(trashDir, `${path.basename(hit.absFile, '.md')}-${Date.now()}.md`);
    if (!within(p.trash, target)) throw new Error('日记回收站路径越界，已拒绝');
    fs.renameSync(hit.absFile, target);
    rebuildIndex(diaryDir, { characterId });
    return { ok: true, id: hit.id, trash: path.relative(diaryDir, target) };
  });
}

// ── 候选 ────────────────────────────────────────────────────────────────────

function candidateFile(diaryDir, day) {
  return path.join(diaryPaths(diaryDir).candidates, `${day}.jsonl`);
}

export function captureCandidate(diaryDir, { note, source = 'qq', tags = [], day = '', now = Date.now(), characterId = '' } = {}) {
  const text = normalizeContent(note, { max: CANDIDATE_MAX_CHARS, label: '候选内容' });
  const when = normalizeDay(day, localDay(now));
  const cleanSource = safeText(source, 32).replace(/[\r\n\t]+/g, ' ').trim() || 'qq';
  const cleanTags = normalizeTags(tags);
  return withDiaryLock(diaryDir, () => {
    const file = candidateFile(diaryDir, when);
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch {}
    // 同一天相同内容不重复记（agent 容易在多轮里记同一件事）。
    for (const line of lines.slice(-50)) {
      try {
        const item = JSON.parse(line);
        if (item?.note === text) return { ok: true, duplicate: true, day: when, file: path.relative(diaryDir, file) };
      } catch {}
    }
    const record = { at: iso(now), day: when, note: text, source: cleanSource, tags: cleanTags };
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    rebuildIndex(diaryDir, { characterId });
    return { ok: true, duplicate: false, day: when, file: path.relative(diaryDir, file), chars: text.length };
  });
}

export function listCandidates(diaryDir, { day = '', now = Date.now() } = {}) {
  const when = normalizeDay(day, localDay(now));
  const file = candidateFile(diaryDir, when);
  const out = [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ok: true, day: when, items: [] }; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item && typeof item === 'object' && item.note) out.push(item);
    } catch {}
  }
  return { ok: true, day: when, items: out };
}

/** 当日回顾提交后归档候选；失败/没提交就不动，下一轮还能看到。 */
export function archiveCandidates(diaryDir, { day = '', now = Date.now() } = {}) {
  const when = normalizeDay(day, localDay(now));
  const p = diaryPaths(diaryDir);
  const file = candidateFile(diaryDir, when);
  if (!fs.existsSync(file)) return { ok: true, moved: false, day: when };
  return withDiaryLock(diaryDir, () => {
    ensureDir(p.processed);
    let target = path.join(p.processed, `${when}.jsonl`);
    if (fs.existsSync(target)) target = path.join(p.processed, `${when}-${Date.now()}.jsonl`);
    fs.renameSync(file, target);
    return { ok: true, moved: true, day: when, file: path.relative(diaryDir, target) };
  });
}

// ── 分享 / 出站闸 ───────────────────────────────────────────────────────────

function normalizeForMatch(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function shareEntry(diaryDir, {
  id, mode = 'excerpt', excerpt = '', reason = '', now = Date.now(),
} = {}) {
  const hit = findEntry(diaryDir, id);
  const kind = String(mode ?? 'excerpt') === 'full' ? 'full' : 'excerpt';
  let text = '';
  if (kind === 'full') {
    if (hit.visibility !== 'shareable') {
      throw new Error('这篇是私人日记，只能选一段分享（mode="excerpt" 并传 excerpt），不能整篇发出');
    }
    text = hit.body;
  } else {
    text = String(excerpt ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) throw new Error('请传要分享的那一段原文（excerpt）');
    if (text.length > EXCERPT_MAX_CHARS) throw new Error(`分享摘录超过 ${EXCERPT_MAX_CHARS} 字上限`);
    if (!hit.body.includes(text)) throw new Error('excerpt 必须是这篇日记正文里的原文片段（不能改写/拼接）');
  }
  const record = {
    at: iso(now),
    id: hit.id,
    date: hit.date,
    mode: kind,
    chars: text.length,
    reason: safeText(reason, 200).replace(/[\r\n\t]+/g, ' ').trim(),
    // 私人日记的摘录就是出站闸的“授权凭据”；shareable 整篇不需要存正文。
    ...(kind === 'excerpt' || hit.visibility !== 'shareable' ? { excerpt: text } : { full: true }),
  };
  return withDiaryLock(diaryDir, () => {
    appendShare(diaryDir, record);
    rebuildIndex(diaryDir, { characterId: '' });
    return {
      ok: true,
      id: hit.id,
      mode: kind,
      text,
      note: hit.visibility === 'shareable'
        ? '这篇是可分享日记，已记录。'
        : '已记录这段摘录；只有这段原文被授权，其余内容仍然不能发出去。',
    };
  });
}

export function listShares(diaryDir, { limit = 20 } = {}) {
  const shares = readShares(diaryDir).slice(-Math.max(1, Math.min(200, Number(limit) || 20)));
  return { ok: true, shares };
}

const leakCache = new Map();

export function clearLeakCache() {
  leakCache.clear();
}

function privateCorpus(diaryDir) {
  const p = diaryPaths(diaryDir);
  const sig = (() => {
    try {
      const index = fs.statSync(p.index).mtimeMs;
      const shares = (() => { try { return fs.statSync(p.shares).mtimeMs; } catch { return 0; } })();
      return `${index}:${shares}`;
    } catch {
      return '';
    }
  })();
  const cached = leakCache.get(diaryDir);
  if (cached && cached.sig && cached.sig === sig) return cached;
  const { entries } = scanEntries(diaryDir);
  const isPrivate = (entry) => entry.visibility !== 'shareable';
  const corpus = entries.filter(isPrivate).map((entry) => normalizeForMatch(entry.body)).join('\n');
  const approved = readShares(diaryDir)
    .filter((item) => item && typeof item.excerpt === 'string' && item.excerpt)
    .map((item) => normalizeForMatch(item.excerpt))
    .join('\n');
  const value = { sig, corpus, approved };
  if (sig) leakCache.set(diaryDir, value);
  return value;
}

/**
 * 出站闸：判断一段准备发给主人的文本，是否包含**未授权**的私人日记原文。
 * 只做字面比对（24 字窗口），不做语义判断；出错一律放行（日记坏了不能影响聊天）。
 */
export function checkPrivateLeak(diaryDir, text, { enabled = true, shingle = LEAK_SHINGLE } = {}) {
  try {
    if (!enabled) return { blocked: false };
    const body = normalizeForMatch(text);
    const size = Math.max(12, Math.min(64, Number(shingle) || LEAK_SHINGLE));
    if (body.length < size) return { blocked: false };
    if (!fs.existsSync(diaryDir)) return { blocked: false };
    const { corpus, approved } = privateCorpus(diaryDir);
    if (!corpus) return { blocked: false };
    for (let i = 0; i + size <= body.length; i += 1) {
      const win = body.slice(i, i + size);
      if (!win.trim()) continue;
      if (!corpus.includes(win)) continue;
      if (approved.includes(win)) continue;
      return {
        blocked: true,
        message: `这段内容里有私人日记的原文（${win.slice(0, 12)}…），还没有授权发出去。要分享请先用 diary_share 选一段摘录，或者换一种说法。`,
      };
    }
    return { blocked: false };
  } catch (error) {
    return { blocked: false, error: String(error?.message ?? error) };
  }
}

/** 设置页的 diary.leakGuard 开关；放在 unified config，bridge 也能读。 */
export function isLeakGuardEnabled({ surfcoreDir } = {}) {
  try {
    const file = path.join(surfcoreDir || resolveSurfcoreDir(), 'config.json');
    const cfg = readJson(file, {});
    return cfg?.diary?.leakGuard !== false;
  } catch {
    return true;
  }
}

// ── 调度状态 / 概览 ────────────────────────────────────────────────────────

export function readSchedulerState(diaryDir) {
  const p = diaryPaths(diaryDir);
  const state = readJson(p.schedulerState, null);
  if (!state || typeof state !== 'object') return { version: DIARY_VERSION, lastReviewedDay: null, attempts: {} };
  return {
    version: DIARY_VERSION,
    lastReviewedDay: typeof state.lastReviewedDay === 'string' ? state.lastReviewedDay : null,
    lastReviewedSlot: typeof state.lastReviewedSlot === 'string' ? state.lastReviewedSlot : '',
    lastReviewedAt: typeof state.lastReviewedAt === 'string' ? state.lastReviewedAt : '',
    attempts: state.attempts && typeof state.attempts === 'object' ? state.attempts : {},
    lastAttemptAt: typeof state.lastAttemptAt === 'string' ? state.lastAttemptAt : '',
    lastManualAt: typeof state.lastManualAt === 'string' ? state.lastManualAt : '',
    lastError: typeof state.lastError === 'string' ? state.lastError : '',
    submittedAt: typeof state.submittedAt === 'string' ? state.submittedAt : '',
  };
}

export function writeSchedulerState(diaryDir, next) {
  const p = diaryPaths(diaryDir);
  ensureDiaryDir(diaryDir);
  atomicWriteFile(p.schedulerState, `${JSON.stringify({ version: DIARY_VERSION, ...next }, null, 2)}\n`);
  return next;
}

export function diaryStatus(diaryDir, { now = Date.now() } = {}) {
  const { entries, errors } = scanEntries(diaryDir);
  const day = localDay(now);
  const candidates = listCandidates(diaryDir, { day, now }).items;
  const shares = readShares(diaryDir);
  const last = entries[0] ?? null;
  return {
    ok: true,
    day,
    entries: entries.length,
    errors,
    lastEntry: last ? { id: last.id, date: last.date, title: last.title, visibility: last.visibility, chars: last.chars } : null,
    candidates: candidates.length,
    shares: shares.length,
    scheduler: readSchedulerState(diaryDir),
  };
}
