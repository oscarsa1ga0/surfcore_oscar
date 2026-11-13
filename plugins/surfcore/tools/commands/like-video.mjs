// 视频点赞（不是评论区点赞；评论点赞见 fish-guard like）
//
//   node bili.mjs like-video --bvid BV1,BV2,BV3 --dry
//   node bili.mjs like-video --bvid BV1,BV2,BV3 --go
//   node bili.mjs like-video --bvid BV1 --unlike --go      # 撤回测试/清理用
//
// 接口：
//   GET  https://api.bilibili.com/x/web-interface/archive/has/like?aid=<aid>  → data 0/1
//   POST https://api.bilibili.com/x/web-interface/archive/like                → aid / like=1|0 / csrf
//
// 限额（2026-11-13 用户定）：每天最多 10 个，每次最多 5 个；先 --dry 再 --go；
// 每次点赞后回读 has/like 确认真的点上；批量结束统一 notify 报备。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { accountBili, biliState } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'
import { assertInteractEnabled } from '../lib/interact.mjs'
import { gate, record as recordQuota } from '../lib/quota-gate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const bvids = []
const args = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--bvid') {
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      for (const bv of String(next).split(/[,，\s]+/)) if (bv.trim()) bvids.push(bv.trim())
      i += 1
    }
    continue
  }
  if (!a.startsWith('--')) continue
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) args.set(a.slice(2), true)
  else { args.set(a.slice(2), next); i += 1 }
}

const cfg = config()
const dry = args.get('dry') === true
const go = args.get('go') === true
const unlike = args.get('unlike') === true
if (dry === go) { console.error('必须且只能给一个 --dry 或 --go'); process.exit(2) }
if (cfg.likeVideo?.enabled === false) { console.error('视频点赞在设置里关掉了（likeVideo.enabled=false）'); process.exit(3) }
if (go && !assertInteractEnabled(unlike ? '取消视频点赞' : '视频点赞')) process.exit(3)

const uniq = [...new Set(bvids.filter((bv) => /^BV[0-9A-Za-z]{10}$/.test(bv)))]
if (!uniq.length) { console.error('需要 --bvid BV1[,BV2...]'); process.exit(2) }
const perRunMax = Math.max(1, Math.min(5, Number(cfg.likeVideo?.perRunMax ?? 5) || 5))
const dailyMax = Math.max(0, Math.min(10, Number(cfg.likeVideo?.dailyMax ?? 10) || 0))
const requested = Math.min(uniq.length, Math.max(1, Math.min(perRunMax, Number(args.get('max') ?? perRunMax) || perRunMax)))

const credPath = accountBili('credentials.json')
if (!fs.existsSync(credPath)) { console.error(`缺少凭据文件: ${credPath}`); process.exit(3) }
const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'))
for (const k of ['sessdata', 'bili_jct', 'buvid3']) {
  if (!cred[k] || String(cred[k]).trim() === '') { console.error(`凭据文件缺少 ${k}`); process.exit(3) }
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const csrf = String(cred.bili_jct)
const H = (bv = '') => ({ 'user-agent': UA, referer: `https://www.bilibili.com/video/${bv}/`, origin: 'https://www.bilibili.com', cookie })

async function viewOf(bv) {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { headers: H(bv) })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0 || !j.data) throw new Error(`取视频信息失败 code=${j.code ?? '?'} ${j.message ?? ''}`)
  return { aid: Number(j.data.aid), title: String(j.data.title ?? ''), up: String(j.data.owner?.name ?? '') }
}
async function hasLike(aid, bv) {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/archive/has/like?aid=${aid}`, { headers: H(bv) })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message, liked: null }
  return { ok: true, liked: Number(j.data) === 1 }
}
async function hasLikeRetry(aid, bv, expected, attempts = 4) {
  let last = null
  for (let i = 0; i < attempts; i += 1) {
    last = await hasLike(aid, bv)
    if (last.ok && last.liked === expected) return last
    await new Promise((r) => setTimeout(r, 600))
  }
  return last
}

async function setLike(aid, bv, like) {
  // B站这个接口：like=1 点赞，like=2 取消点赞（0 会 -400）
  const body = new URLSearchParams({ aid: String(aid), like: like ? '1' : '2', csrf })
  const r = await fetch('https://api.bilibili.com/x/web-interface/archive/like', {
    method: 'POST', headers: { ...H(bv), 'content-type': 'application/x-www-form-urlencoded' }, body,
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.code === 0, status: r.status, code: j.code, message: j.message, raw: j }
}

const quotaFile = biliState('quota.json')
let log = []
try { log = JSON.parse(fs.readFileSync(quotaFile, 'utf8'))?.log ?? [] } catch {}
const today = new Date().toLocaleDateString('sv-SE')
const todayLikes = log.filter((x) => x.type === 'like-video' && x.at && new Date(x.at).toLocaleDateString('sv-SE') === today).length
const remaining = dailyMax > 0 ? Math.max(0, dailyMax - todayLikes) : requested
const take = unlike ? requested : Math.min(requested, remaining)

console.log(`[视频${unlike ? '取消点赞' : '点赞'}] 本次最多 ${requested} 个 · 今日 ${todayLikes}/${dailyMax || '不限'} · 实际处理 ${take} 个`)
if (!unlike && !take) { console.error(`✗ 今天视频点赞已达上限 ${dailyMax} 个`); process.exit(3) }

const results = { liked: [], skipped: [], failed: [] }
for (const bv of uniq.slice(0, take)) {
  let info
  try {
    info = await viewOf(bv)
  } catch (error) {
    results.failed.push({ bv, error: String(error?.message ?? error).slice(0, 120) })
    console.log(`  ✗ ${bv}  ${String(error?.message ?? error).slice(0, 100)}`)
    continue
  }
  const before = await hasLike(info.aid, bv)
  if (before.ok && before.liked === !unlike) {
    results.skipped.push({ bv, title: info.title, why: unlike ? '本来就没点赞' : '已经点过赞' })
    console.log(`  · ${bv}  ${String(info.title).slice(0, 36)}  ${unlike ? '本来就没点赞' : '已经点过赞'}，跳过`)
    continue
  }
  console.log(`  ${unlike ? '−' : '+'} ${bv}  ${String(info.title).slice(0, 36)}  @${info.up}  aid=${info.aid}`)
  if (dry) { results.liked.push({ bv, title: info.title, dry: true }); continue }

  if (!unlike && !gate({ type: 'like-video', target: `BV:${bv}`, auto: true })) {
    results.failed.push({ bv, error: '限额闸不通过' })
    continue
  }
  const out = await setLike(info.aid, bv, !unlike)
  if (!out.ok) {
    results.failed.push({ bv, code: out.code, error: out.message })
    console.log(`    ✗ code=${out.code ?? '?'} ${out.message ?? ''}`)
    continue
  }
  // 接口 code=0 就算成功；has/like 有缓存/延迟，最多重试 4 次，不因回读慢而误判失败。
  const after = await hasLikeRetry(info.aid, bv, !unlike)
  results.liked.push({ bv, title: info.title, aid: info.aid })
  if (!unlike) {
    try {
      recordQuota({ type: 'like-video', target: `BV:${bv}`, note: `${info.title.slice(0, 40)}`, auto: true })
    } catch (error) {
      console.log(`    ⚠️ 写 quota 失败：${String(error?.message ?? error).slice(0, 80)}`)
    }
  }
  if (after?.ok && after.liked === !unlike) {
    console.log(`    ✓ ${unlike ? '已取消' : '已点赞'}（回读 liked=${after.liked}）`)
  } else {
    console.log(`    ⚠️ 接口已接受，但回读还是 liked=${after?.liked ?? '?'}（B站缓存延迟；稍后可用 --unlike 再核）`)
  }
}

if (dry) {
  console.log(`\n[dry] 未发送。真发会 POST x/web-interface/archive/like。`)
  process.exit(0)
}

if (results.liked.length) {
  try {
    execFileSync(process.execPath, [path.join(HERE, 'notify.mjs'),
      `【B站视频${unlike ? '取消点赞' : '点赞'}】${results.liked.length} 个\n${results.liked.slice(0, 5).map((x) => `· ${x.bv} ${String(x.title).slice(0, 40)}`).join('\n')}`,
      '--title', `B站视频${unlike ? '取消点赞' : '点赞'}`], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
  } catch (error) {
    console.log(`  （报备失败，不影响操作：${String(error?.message ?? error).slice(0, 80)}）`)
  }
}
console.log(`\n完成：成功 ${results.liked.length} · 跳过 ${results.skipped.length} · 失败 ${results.failed.length}`)
if (results.failed.length) process.exit(5)
