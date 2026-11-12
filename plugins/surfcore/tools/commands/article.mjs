// 原创专栏：先存草稿（可删），确认后再发布。
//
//   node bili.mjs article --title "…" --file 文章.md --dry
//   node bili.mjs article --title "…" --file 文章.md --draft     # 只进草稿箱，不公开
//   node bili.mjs article --title "…" --file 文章.md --go        # 草稿 + 提交发布
//   node bili.mjs article --delete <aid>
//   node bili.mjs article --check <aid>
//
// 接口（2026-11 仍可用；先用 --draft 验证）：
//   POST https://api.bilibili.com/x/article/creative/draft/addupdate   → { data: { aid } }
//   POST https://api.bilibili.com/x/article/creative/article/submit    → 发布
//   POST https://api.bilibili.com/x/article/creative/article/upcover   → 封面
//   POST https://member.bilibili.com/x/web/draft/delete                → 删草稿
//
// 和自由动态共用 `daily-dynamic.json` 的 30 分钟间隔；不设每日上限。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { accountBili, biliState } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'
import { assertInteractEnabled } from '../lib/interact.mjs'
import { assertOutboundIdentitySafe } from '../lib/outbound-guard.mjs'
import { gate, record as recordQuota } from '../lib/quota-gate.mjs'
import { readShareState, dynamicGapWait, mergeArticleRecord } from '../lib/share-dynamic.mjs'
import { markdownToHtml, htmlToPlain } from '../lib/article.mjs'
import { appendBiliPost } from '../lib/bili-posts.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const args = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) args.set(a.slice(2), true)
  else { args.set(a.slice(2), next); i += 1 }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const ORIGIN = 'https://member.bilibili.com'
const REF = 'https://member.bilibili.com/platform/upload/text/edit'
const credPath = accountBili('credentials.json')
if (!fs.existsSync(credPath)) { console.error(`缺少凭据文件: ${credPath}`); process.exit(3) }
const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'))
for (const k of ['sessdata', 'bili_jct', 'buvid3']) {
  if (!cred[k] || String(cred[k]).trim() === '') { console.error(`凭据文件缺少 ${k}`); process.exit(3) }
}
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const csrf = String(cred.bili_jct)

if (args.get('delete')) {
  const aid = String(args.get('delete'))
  if (!/^\d+$/.test(aid)) { console.error('--delete 需要 aid 数字'); process.exit(2) }
  const body = new URLSearchParams({ aid, csrf })
  const r = await fetch('https://member.bilibili.com/x/web/draft/delete', {
    method: 'POST', headers: { 'user-agent': UA, referer: REF, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie }, body,
  })
  const out = await r.json().catch(() => ({}))
  console.log(`HTTP ${r.status} code=${out.code} ${out.message ?? ''}`)
  process.exit(out.code === 0 ? 0 : 4)
}
if (args.get('check')) {
  const aid = String(args.get('check'))
  if (!/^\d+$/.test(aid)) { console.error('--check 需要 aid 数字'); process.exit(2) }
  const r = await fetch(`https://api.bilibili.com/x/article/creative/draft/view?aid=${aid}`, {
    headers: { 'user-agent': UA, referer: REF, cookie },
  })
  const out = await r.json().catch(() => ({}))
  if (out.code !== 0) { console.log(`读取失败 code=${out.code} ${out.message ?? ''}`); process.exit(4) }
  const d = out.data ?? {}
  console.log(`aid=${aid}  标题=${d.title ?? ''}  分类=${d.category?.id ?? '?'}  正文字数=${String(d.content ?? '').length}`)
  process.exit(0)
}

const title = String(args.get('title') ?? '').trim()
const file = String(args.get('file') ?? '').trim()
const rawContent = file
  ? (() => { try { return fs.readFileSync(file, 'utf8') } catch { console.error(`读不到文件: ${file}`); process.exit(2) } })()
  : String(args.get('content') ?? '')
const dry = args.get('dry') === true
const draftOnly = args.get('draft') === true
const go = args.get('go') === true
if (!title) { console.error('article 需要 --title'); process.exit(2) }
if (title.length > 40) { console.error('专栏标题最多 40 字'); process.exit(2) }
if (!rawContent.trim()) { console.error('article 需要 --file 或 --content'); process.exit(2) }
if ([dry, draftOnly, go].filter(Boolean).length !== 1) { console.error('--dry / --draft / --go 必须且只能给一个'); process.exit(2) }

const cfg = config()
if (cfg.article?.enabled === false) { console.error('原创专栏在设置里关掉了（article.enabled=false）'); process.exit(3) }
if (go && !assertInteractEnabled('发专栏')) process.exit(3)

const html = file && /\.html?$/i.test(file) ? rawContent : markdownToHtml(rawContent)
const plain = htmlToPlain(html)
if (plain.length < 1) { console.error('正文为空'); process.exit(2) }
if (plain.length > 40000) { console.error('正文最多 40000 字'); process.exit(2) }
if (go && plain.length < 200) { console.error(`✗ 专栏正文至少 200 字（当前 ${plain.length}）`); process.exit(2) }
try {
  assertOutboundIdentitySafe(`${title}\n${plain}`, { surface: 'B站 专栏' })
} catch (error) {
  console.error(`✗ ${error.message}`)
  process.exit(9)
}

// 专栏也参与「任意两条动态之间」的间隔；草稿不算发布。
const stateFile = biliState('daily-dynamic.json')
const gapMin = Number(cfg.dynamics?.gapMin ?? 30) || 30
if (go) {
  const gap = dynamicGapWait(readShareState(stateFile), gapMin, Date.now())
  if (!gap.ok) {
    console.error(`✗ 上一条动态/专栏刚发不久（${new Date(gap.lastAt).toLocaleTimeString('zh-CN', { hour12: false })}）—— 还差 ${gap.waitMin} 分钟`)
    process.exit(3)
  }
}

const category = Number(args.get('category') ?? cfg.article?.category ?? 0) || 0
const tid = 4
const original = 1
const cover = String(args.get('cover') ?? '').trim()

console.log('[原创专栏]')
console.log(`  标题：${title}（${title.length} 字）`)
console.log(`  正文：${plain.length} 字（HTML ${html.length} 字节）· 分类 ${category} · 封面 ${cover ? cover : '无（用正文图/默认）'}`)
if (go) console.log(`  间隔：距上一条 ≥${gapMin} 分钟 ✓`)

async function uploadCover(filePath) {
  if (!filePath) return ''
  if (!fs.existsSync(filePath)) throw new Error(`封面不存在: ${filePath}`)
  const buf = fs.readFileSync(filePath)
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
  const fd = new FormData()
  fd.append('binary', new Blob([buf], { type: mime }), path.basename(filePath))
  fd.append('csrf', csrf)
  const r = await fetch('https://api.bilibili.com/x/article/creative/article/upcover', {
    method: 'POST', headers: { 'user-agent': UA, referer: REF, origin: ORIGIN, cookie }, body: fd,
  })
  const out = await r.json().catch(() => ({}))
  if (out.code !== 0 || !out.data?.url) throw new Error(`封面上传失败 code=${out.code} ${out.message ?? ''}`)
  return String(out.data.url).replace(/^http:/, 'https:')
}

if (dry) {
  console.log(`\n[dry] 未上传、未建草稿。${go ? '真发会先建草稿再 submit。' : ''}`)
  process.exit(0)
}

let coverUrl = ''
try {
  coverUrl = await uploadCover(cover)
  if (coverUrl) console.log(`  封面上传：${coverUrl}`)
} catch (error) {
  console.error(`✗ ${error.message}`)
  process.exit(5)
}

const form = new URLSearchParams({
  title,
  content: html,
  category: String(category),
  list_id: '0',
  tid: String(tid),
  reprint: '0',
  media_id: '0',
  spoiler: '0',
  original: String(original),
  csrf,
})
if (coverUrl) { form.set('image_urls', coverUrl); form.set('origin_image_urls', coverUrl) }

async function postForm(url) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'user-agent': UA, referer: REF, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: form,
  })
  const out = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, out }
}

const draft = await postForm('https://api.bilibili.com/x/article/creative/draft/addupdate')
if (!draft.ok || draft.out.code !== 0 || !draft.out.data?.aid) {
  console.error(`✗ 建草稿失败 HTTP ${draft.status} code=${draft.out.code ?? '?'} ${draft.out.message ?? draft.out.msg ?? ''}`)
  process.exit(5)
}
const aid = String(draft.out.data.aid)
const editUrl = `https://member.bilibili.com/v2#/upload/text/edit?aid=${aid}`
console.log(`  ✓ 草稿已建：aid=${aid}\n    ${editUrl}`)

if (draftOnly) {
  console.log('\n[draft] 只进了草稿箱，没有公开。确认后加 --go 发布；不要了用 --delete ' + aid)
  process.exit(0)
}

form.set('aid', aid)
const submit = await postForm('https://api.bilibili.com/x/article/creative/article/submit')
if (!submit.ok || submit.out.code !== 0) {
  console.error(`✗ 发布失败 HTTP ${submit.status} code=${submit.out.code ?? '?'} ${submit.out.message ?? submit.out.msg ?? ''}`)
  console.error(`  草稿还在：${editUrl}（可用 --delete ${aid} 删除）`)
  process.exit(6)
}

const url = `https://www.bilibili.com/read/cv${aid}`
const at = new Date().toISOString()
const atText = new Date().toLocaleTimeString('zh-CN', { hour12: false })
try {
  const next = mergeArticleRecord(readShareState(stateFile), {
    date: new Date().toLocaleDateString('sv-SE'), at, atText, aid, title, chars: plain.length,
  })
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2) + '\n')
} catch (error) {
  console.log(`  ⚠️ 写 daily-dynamic.json 失败（间隔可能不准）：${String(error?.message ?? error).slice(0, 80)}`)
}
recordQuota({ type: 'article', target: `cv:${aid}`, note: `专栏《${title.slice(0, 24)}》`, auto: true })
appendBiliPost(biliState('bili-posts.jsonl'), {
  id: `article:${aid}`, type: 'article', title, text: plain, url, at,
  date: new Date().toLocaleDateString('sv-SE'), source: 'article',
})
try {
  execFileSync(process.execPath, [path.join(HERE, 'notify.mjs'),
    `【原创专栏】《${title}》\n${plain.slice(0, 140)}\n${url}`, '--title', 'B站原创专栏'], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  })
} catch (error) {
  console.log(`  （报备失败，不影响已发布的专栏：${String(error?.message ?? error).slice(0, 80)}）`)
}

console.log(`\n✓ 专栏已发布：${url}`)
console.log(`  aid=${aid}`)
