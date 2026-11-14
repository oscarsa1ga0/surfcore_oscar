// 她自己发布的 B站 作品（自由动态 / 原创专栏）—— 给记忆同步用。
//
// 为什么单独一份：`bili-memory.json` 是桥接根据「看过的视频/评论/收藏/自己的动态」
// 重新生成的，直接往里追加会被下一次刷新覆盖。这里用 append-only JSONL：
//   ~/.dsh/surfcore/characters/<id>/bili/bili-posts.jsonl
// 记忆卡插件每 10 分钟读一次；B站 memory brief 也会合并它，所以 QQ / B站 都会记住
// 「我发过什么」，而不是只有发布命令知道。
import fs from 'node:fs'
import path from 'node:path'

export function readBiliPosts(file) {
  const out = []
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return out }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const item = JSON.parse(line)
      if (item && typeof item === 'object') out.push(item)
    } catch {}
  }
  return out.slice(-300)
}

export function appendBiliPost(file, record = {}, { strict = false, once = false } = {}) {
  const item = {
    id: String(record.id ?? `post:${Date.now()}`),
    type: String(record.type ?? 'dynamic'),
    title: String(record.title ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100),
    text: String(record.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
    // 视频用：发布时写好的详细概括；文章用：B站摘要（可选）。
    summary: String(record.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000),
    cover: String(record.cover ?? '').trim(),
    bvid: String(record.bvid ?? '').trim(),
    url: String(record.url ?? '').trim(),
    at: String(record.at ?? new Date().toISOString()),
    date: String(record.date ?? new Date().toLocaleDateString('sv-SE')),
    source: String(record.source ?? 'bili'),
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (once) {
      let text = ''
      try { text = fs.readFileSync(file, 'utf8') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      for (const line of text.split('\n')) {
        let value
        try { value = JSON.parse(line) } catch { continue }
        if (value?.id === item.id) return value
      }
    }
    fs.appendFileSync(file, `${JSON.stringify(item)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) { if (strict) throw error }
  return item
}
