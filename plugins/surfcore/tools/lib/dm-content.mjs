// B站私信消息的 content 解析。
//
// content 可能是纯文本，也可能是一段 JSON：
//   · 普通文本：{"content":"在吗"}
//   · 分享卡片 / 富文本节点：{"type":"RICH_TEXT_NODE_TYPE_BV","jump_url":"…","rid":"BV…","text":"标题"}
//   · 有的卡片把真正的 payload 再塞进 content 字符串里（JSON 套 JSON）
//
// 以前的 dm-await 只取 j.content 就把其余字段丢了：她能看到卡片上的文字，
// 却拿不到视频地址，等于"看得到摸不着"。这里把 text / url / kind 一起取出来。

/** `//` 开头补协议，`/` 开头补站内域名。 */
export function normalizeCardUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.startsWith('//')) return `https:${text}`;
  if (text.startsWith('/')) return `https://www.bilibili.com${text}`;
  return text;
}

function asObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * @param {unknown} content 私信消息的 content 原值
 * @returns {{text: string, url: string, kind: string}}
 */
export function parseDmContent(content) {
  const raw = String(content ?? '');
  const root = asObject(raw);
  if (!root) return { text: raw, url: '', kind: '' };

  // 卡片经常是 JSON 套 JSON：外层 {content:"{...}"}，真正的字段在里层。
  const layers = [root];
  const nested = asObject(root.content);
  if (Array.isArray(nested)) layers.push(...nested.filter((item) => item && typeof item === 'object'));
  else if (nested) layers.push(nested);
  if (Array.isArray(root.content)) layers.push(...root.content.filter((item) => item && typeof item === 'object'));

  let url = '';
  let kind = '';
  for (const layer of layers) {
    if (!url) url = normalizeCardUrl(layer.jump_url ?? layer.url ?? layer.link ?? '');
    if (!kind) kind = String(layer.type ?? layer.card_type ?? layer.cardType ?? '').trim();
    const rid = String(layer.rid ?? layer.bvid ?? '').trim();
    if (!url && /^BV[0-9A-Za-z]{10}$/.test(rid)) url = `https://www.bilibili.com/video/${rid}/`;
  }

  let text = '';
  for (const layer of layers) {
    for (const key of ['title', 'content', 'text', 'orig_text']) {
      const value = layer[key];
      // 外层 content 可能又是一段 JSON（卡片套卡片），那种不能当正文。
      if (typeof value === 'string' && value.trim() && !asObject(value)) { text = value; break; }
    }
    if (text) break;
  }
  if (!text) {
    // 图片/卡片消息本身没有正文：给个占位，别把整段 JSON 塞回正文。
    const image = /\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i.test(url) || /image/i.test(kind);
    text = url ? (image ? '[图片]' : '[卡片]') : raw;
  }
  return { text, url, kind };
}
