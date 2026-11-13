// 视频投币（只对“觉得特别好”的视频）
//
//   node bili.mjs coin --bvid BV... --reason "…" --dry
//   node bili.mjs coin --bvid BV... --reason "…" --go
//
// 接口：
//   GET  https://api.bilibili.com/x/web-interface/nav                 → data.money（硬币余额）
//   GET  https://api.bilibili.com/x/web-interface/archive/coins?aid=  → data.multiply（已投几枚）
//   POST https://api.bilibili.com/x/web-interface/coin/add            → aid / multiply / select_like=0 / csrf
//
// 用户定（2026-11-13）：每天最多投 5 枚；投之前必须看余额，只对特别好的视频投，
// 必须写理由（≥6 字）；同一个视频可以自己选 1 枚或 2 枚（B站单视频上限 2 枚）。
// 两枚门槛更高：1 枚评分 ≥16，2 枚评分 ≥18（没评分先 score）。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { accountBili, biliState } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'
import { assertInteractEnabled } from '../lib/interact.mjs'
import { gate, record as recordQuota } from '../lib/quota-gate.mjs'
import { loadScores } from '../lib/scores.mjs'

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

const cfg = config()
const bvid = String(args.get('bvid') ?? '').trim()
const reason = String(args.get('reason') ?? '').trim()
const count = Math.max(1, Math.min(2, Number(args.get('count') ?? 1) || 1))
const dry = args.get('dry') === true
const go = args.get('go') === true
if (dry === go) { console.error('必须且只能给一个 --dry 或 --go'); process.exit(2) }
if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) { console.error('coin 需要 --bvid BV...'); process.exit(2) }
if (reason.length < 6) { console.error('✗ 必须写理由（≥6 字）—— 只对觉得特别好的视频投币'); process.exit(2) }
if (cfg.coin?.enabled === false) { console.error('投币在设置里关掉了（coin.enabled=false）'); process.exit(3) }
if (go && !assertInteractEnabled('投币')) process.exit(3)

const perVideoMax = Math.max(1, Math.min(2, Number(cfg.coin?.perVideoMax ?? 2) || 2))
const dailyMax = Math.max(0, Math.min(10, Number(cfg.coin?.dailyMax ?? 5) || 0))
if (count > perVideoMax) { console.error(`✗ 这次 ${count} 枚超过单视频上限 ${perVideoMax} 枚`); process.exit(2) }

const credPath = accountBili('credentials.json')
if (!fs.existsSync(credPath)) { console.error(`缺少凭据文件: ${credPath}`); process.exit(3) }
const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'))
for (const k of ['sessdata', 'bili_jct', 'buvid3']) {
  if (!cred[k] || String(cred[k]).trim() === '') { console.error(`凭据文件缺少 ${k}`); process.exit(3) }
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const csrf = String(cred.bili_jct)
const H = (bv = bvid) => ({ 'user-agent': UA, referer: `https://www.bilibili.com/video/${bv}/`, origin: 'https://www.bilibili.com', cookie })

async function viewOf() {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: H() })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0 || !j.data) throw new Error(`取视频信息失败 code=${j.code ?? '?'} ${j.message ?? ''}`)
  return { aid: Number(j.data.aid), title: String(j.data.title ?? ''), up: String(j.data.owner?.name ?? '') }
}
async function balanceOf() {
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: H() })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0) return { ok: false, error: `nav code=${j.code} ${j.message ?? ''}` }
  return { ok: true, money: Number(j.data?.money) || 0, uname: String(j.data?.uname ?? '') }
}
async function coinsRetry(aid, expected, attempts = 4) {
  let last = null
  for (let i = 0; i < attempts; i += 1) {
    last = await coinsOf(aid)
    if (last.ok && last.multiply >= expected) return last
    await new Promise((r) => setTimeout(r, 600))
  }
  return last
}

async function coinsOf(aid) {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/archive/coins?aid=${aid}`, { headers: H() })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message, multiply: 0 }
  return { ok: true, multiply: Number(j.data?.multiply) || 0 }
}

function latestScoreOf(bv) {
  const all = loadScores()
  let found = null
  for (const [day, list] of Object.entries(all)) {
    for (const item of (Array.isArray(list) ? list : [])) {
      if (item?.bv !== bv) continue
      const at = Date.parse(item.at) || 0
      if (!found || at > found.at || (at === found.at && day > found.day)) found = { ...item, at, day }
    }
  }
  return found
}

const quotaFile = biliState('quota.json')
let log = []
try { log = JSON.parse(fs.readFileSync(quotaFile, 'utf8'))?.log ?? [] } catch {}
const today = new Date().toLocaleDateString('sv-SE')
const todayCoins = log
  .filter((x) => x.type === 'coin' && x.at && new Date(x.at).toLocaleDateString('sv-SE') === today)
  .reduce((sum, x) => sum + (Number(x.amount) || 1), 0)

let info
try { info = await viewOf() } catch (error) {
  console.error(`✗ ${String(error?.message ?? error).slice(0, 200)}`)
  process.exit(4)
}
const balance = await balanceOf()
if (!balance.ok) { console.error(`✗ 查硬币余额失败：${balance.error}`); process.exit(4) }
const existing = await coinsOf(info.aid)
const already = existing.ok ? Math.max(0, Number(existing.multiply) || 0) : 0
// count 是“这个视频我最终想投几枚”（1 或 2）；已投过就只补差额。
const add = Math.max(0, Math.min(count, perVideoMax, 2 - already))
console.log(`[投币] ${bvid}  「${info.title.slice(0, 44)}」  @${info.up}`)
console.log(`  理由：${reason}`)
console.log(`  硬币余额：${balance.money} 枚 · 今天已投 ${todayCoins}/${dailyMax || '不限'} 枚 · 这个视频已投 ${existing.ok ? already : '?'} 枚`)
if (!existing.ok) console.log(`  ⚠️ 查已投币数失败：code=${existing.code} ${existing.message ?? ''}`)
if (!add) {
  console.log('  这个视频已经投到你要的枚数了，不需要再投。')
  process.exit(0)
}

// 两枚的门槛比一枚高：1 枚 ≥ oneMinScore，2 枚 ≥ twoMinScore（默认 16 / 18）。
const oneMin = Math.max(0, Math.min(20, Number(cfg.coin?.oneMinScore ?? 16) || 0))
const twoMin = Math.max(oneMin, Math.min(20, Number(cfg.coin?.twoMinScore ?? 18) || 0))
const recorded = latestScoreOf(bvid)
const declared = args.get('score') === true || args.get('score') === undefined ? NaN : Number(args.get('score'))
const quality = recorded ? Number(recorded.score) : (Number.isFinite(declared) ? declared : null)
const scoreFrom = recorded ? `之前评的 ${recorded.score}/20` : (Number.isFinite(declared) ? `--score ${declared}/20` : '没有评分')
console.log(`  评分：${quality === null ? '没有' : `${quality}/20`}（${scoreFrom}；1 枚门槛 ${oneMin}，2 枚门槛 ${twoMin}）`)
if (!Number.isFinite(quality)) {
  console.error(`✗ 先给这个视频评分：score ${bvid} --score N，或 coin ... --score N`)
  process.exit(3)
}
const required = count === 2 ? twoMin : oneMin
if (quality < required) {
  if (count === 2 && quality >= oneMin) {
    console.error(`✗ 投 2 枚需要评分 ≥${twoMin}；这个只有 ${quality}，最多投 1 枚`)
  } else {
    console.error(`✗ 投 ${count} 枚需要评分 ≥${required}；这个只有 ${quality}`)
  }
  process.exit(3)
}
if (dailyMax > 0 && todayCoins + add > dailyMax) {
  console.error(`✗ 今天已投 ${todayCoins} 枚，再投 ${add} 枚会超过每日 ${dailyMax} 枚`)
  process.exit(3)
}
if (balance.money < add) {
  console.error(`✗ 硬币不足：余额 ${balance.money} 枚，本次需要 ${add} 枚（这个视频已有 ${already} 枚）`)
  process.exit(3)
}
if (!gate({ type: 'coin', target: `BV:${bvid}`, auto: true })) {
  console.error('✗ 限额闸不通过')
  process.exit(2)
}
if (dry) {
  console.log(`\n[dry] 未投。真发会 POST x/web-interface/coin/add multiply=${add} select_like=0（这个视频投到 ${already + add} 枚）。`)
  process.exit(0)
}

const body = new URLSearchParams({ aid: String(info.aid), multiply: String(add), select_like: '0', csrf })
const r = await fetch('https://api.bilibili.com/x/web-interface/coin/add', {
  method: 'POST', headers: { ...H(), 'content-type': 'application/x-www-form-urlencoded' }, body,
})
const out = await r.json().catch(() => ({}))
console.log(`\n[go] HTTP ${r.status} code=${out.code} ${out.message ?? ''}`)
if (out.code !== 0) {
  console.log('  原始: ' + JSON.stringify(out).slice(0, 300))
  process.exit(5)
}
const expectedTotal = Math.min(2, already + add)
const after = await coinsRetry(info.aid, expectedTotal)
const afterBalance = await balanceOf()
const ok = after.ok && after.multiply >= expectedTotal
console.log(`  ${ok ? '✅ 已确认' : '⚠️ 接口已接受，回读延迟'}：这个视频已投 ${after.multiply ?? '?'} 枚 · 余额 ${afterBalance.ok ? afterBalance.money : '?'} 枚`)

try {
  recordQuota({ type: 'coin', target: `BV:${bvid}`, note: `${info.title.slice(0, 36)}：${reason.slice(0, 40)}`, amount: add, auto: true })
} catch (error) {
  console.log(`  ⚠️ 写 quota 失败：${String(error?.message ?? error).slice(0, 80)}`)
}
try {
  execFileSync(process.execPath, [path.join(HERE, 'notify.mjs'),
    `【B站投币】${add} 枚（这个视频共 ${expectedTotal} 枚）\n${info.title.slice(0, 60)}\n理由：${reason}\nhttps://www.bilibili.com/video/${bvid}/`,
    '--title', 'B站投币'], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
} catch (error) {
  console.log(`  （报备失败，不影响投币：${String(error?.message ?? error).slice(0, 80)}）`)
}
console.log(`\n✓ 已投 ${add} 枚（这个视频共 ${expectedTotal} 枚）：${info.title.slice(0, 50)}`)
