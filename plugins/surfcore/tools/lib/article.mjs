// 专栏正文转换：Markdown → B站专栏编辑器认的 HTML。
//
// 只覆盖常用语法（标题/段落/粗体/链接/图片/列表/引用/代码），不追求完整 Markdown。
// 不引入新依赖；转换是纯函数，可单测。已经是 HTML 的内容原样返回。
const escapeHtml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

function inline(text) {
  let out = escapeHtml(text)
  // 图片：![alt](url) → figure（B站专栏正文图片）
  out = out.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, alt, url) =>
    `<figure class="img-box" contenteditable="false"><img src="${url}"/><figcaption class="caption" contenteditable="">${alt}</figcaption></figure>`)
  // 链接：[text](url)
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
  // 粗体 / 行内代码
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  return out
}

export function markdownToHtml(markdown) {
  const raw = String(markdown ?? '').replace(/\r\n/g, '\n').trim()
  if (!raw) return ''
  if (/^\s*</.test(raw)) return raw
  const lines = raw.split('\n')
  const out = []
  let paragraph = []
  let list = null // 'ul' | 'ol'
  let inCode = false
  let code = []
  const flushParagraph = () => {
    if (!paragraph.length) return
    out.push(`<p>${paragraph.map(inline).join('<br/>')}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    out.push(`</${list}>`)
    list = null
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      if (inCode) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = []; inCode = false; }
      else { flushParagraph(); flushList(); inCode = true; }
      continue
    }
    if (inCode) { code.push(line); continue }
    if (!trimmed) { flushParagraph(); flushList(); continue }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed)
    if (heading) {
      flushParagraph(); flushList()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    if (trimmed.startsWith('>')) {
      flushParagraph(); flushList()
      out.push(`<blockquote>${inline(trimmed.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed)
    const unordered = /^[-*+]\s+(.+)$/.exec(trimmed)
    if (ordered || unordered) {
      flushParagraph()
      const want = ordered ? 'ol' : 'ul'
      if (list !== want) { flushList(); out.push(`<${want}>`); list = want }
      out.push(`<li>${inline((ordered || unordered)[1])}</li>`)
      continue
    }
    flushList()
    paragraph.push(line)
  }
  if (inCode && code.length) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
  flushParagraph()
  flushList()
  return out.join('\n')
}

export function htmlToPlain(html) {
  return String(html ?? '')
    .replace(/<figure[\s\S]*?<\/figure>/gi, ' [图片] ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
