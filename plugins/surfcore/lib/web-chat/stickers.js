// 网页私聊的表情包：读 QQ 桥接的收藏表情库（state/stickers.json），按需把图片缓存到网页数据目录。
// 不依赖桥接进程；快照过的表情断网也能用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankStickers } from '../../../../src/sticker-semantics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
// 优先读网页自己的快照（~/.dsh/surfcore/web-chat/stickers.json），没有才退回 QQ 的库。
const WEB_STICKER_FILE = path.join(process.env.HOME || '', '.dsh', 'surfcore', 'web-chat', 'stickers.json');
export const STICKER_FILE = fs.existsSync(WEB_STICKER_FILE) ? WEB_STICKER_FILE : path.join(ROOT, 'state', 'stickers.json');

const EMOTION_LABEL = {
  happy: '开心', funny: '搞笑', proud: '得意', mock: '嘲讽', tsundere: '傲娇', shy: '害羞',
  cute: '卖萌', wronged: '委屈', sad: '难过', angry: '生气', speechless: '无语', lazy: '摆烂',
  comfort: '安慰', agree: '赞同', surprise: '惊讶', goodbye: '告别', hungry: '馋饿', fear: '害怕', plain: '平淡',
};

/** 原始表情条目（rankStickers 需要 emotion/keywords/tags/useCount 等完整字段）。 */
export function readRawStickerStore(file = STICKER_FILE) {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  } catch { return []; }
}

/** 按最近一句话匹配表情（和 QQ 桥接同一个 rankStickers 实现）。 */
export function matchStickers(text, { topK = 2, minScore, entries } = {}) {
  const list = entries ?? readRawStickerStore();
  // 和 QQ 桥接一致：topK 2，minScore 不传就交给 rankStickers 的默认值（0.34）。
  return Number.isFinite(Number(minScore))
    ? rankStickers(list, text, { topK, minScore: Number(minScore) })
    : rankStickers(list, text, { topK });
}

export function readStickerCatalog(file = STICKER_FILE) {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => row && typeof row === 'object').map((row) => ({
      no: Number(row.no) || 0,
      id: String(row.id ?? row.resId ?? ''),
      md5: String(row.md5 ?? ''),
      url: String(row.url ?? ''),
      emotion: EMOTION_LABEL[String(row.emotion ?? '')] ?? String(row.emotion ?? ''),
      content: String(row.content ?? row.desc ?? row.localNote ?? ''),
      keywords: Array.isArray(row.keywords) ? row.keywords.map(String) : [],
    }));
  } catch { return []; }
}

/** 按编号（"#03" / "3"）、md5、id 找一张；找不到返回 null。 */
export function pickSticker(catalog, key) {
  const text = String(key ?? '').trim();
  if (!text) return null;
  const no = Number(text.replace(/^#/, ''));
  return catalog.find((item) => (Number.isInteger(no) && item.no === no)
    || item.md5 === text || item.id === text) ?? null;
}

const TYPE_BY_MAGIC = [
  { type: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 },
  { type: 'image/webp', test: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
];

export function imageTypeOf(bytes) {
  return TYPE_BY_MAGIC.find((item) => item.test(bytes))?.type ?? '';
}

/** 取表情图片字节：优先本地缓存，没有再下载并写缓存。 */
export async function stickerBytes(entry, { dir, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!entry?.url) throw new Error('sticker-url-missing');
  const key = (entry.md5 || entry.no || 'sticker').replace(/[^a-z0-9_-]/gi, '') || 'sticker';
  const base = path.join(dir, key);
  for (const ext of ['.png', '.gif', '.jpg', '.webp']) {
    try {
      const bytes = fs.readFileSync(base + ext);
      return { type: imageTypeOf(bytes) || 'image/png', bytes };
    } catch {}
  }
  const response = await fetchImpl(entry.url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`sticker-http-${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const type = imageTypeOf(bytes);
  if (!type) throw new Error('sticker-type');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = { 'image/png': '.png', 'image/gif': '.gif', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[type];
  fs.writeFileSync(base + ext, bytes, { mode: 0o600 });
  return { type, bytes };
}

/** 网页侧的表情备注（不改 QQ 账号官方备注）：按表情 md5/编号存。 */
export function readStickerNotes(file) {
  try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); return data && typeof data === 'object' ? data : {}; } catch { return {}; }
}

export function writeStickerNote(file, sticker, note = {}) {
  const key = String(sticker ?? '').trim();
  if (!key) throw new Error('缺少表情编号');
  const data = readStickerNotes(file);
  data[key] = {
    ...(data[key] ?? {}),
    ...(note.emotion ? { emotion: String(note.emotion) } : {}),
    ...(note.content ? { content: String(note.content).slice(0, 120) } : {}),
    ...(Array.isArray(note.keywords) ? { keywords: note.keywords.map(String).slice(0, 8) } : {}),
    at: Date.now(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  return data[key];
}
