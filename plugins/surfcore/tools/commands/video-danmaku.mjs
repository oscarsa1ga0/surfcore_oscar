// 视频弹幕（B站视频页的滚动弹幕，不是直播间弹幕）。
//
//   node bili.mjs danmaku-video --bvid BV1xx411c7mD --msg "…" --at 12 --dry|--go
//   node bili.mjs danmaku-video --bvid BV... --msg "…" --at 12 --mode top|bottom --go
//   node bili.mjs danmaku-video --retract <dmid> --bvid BV...
//
// 接口：POST https://api.bilibili.com/x/v2/dm/post
//   URL: csrf + web_location + WBI(w_rid/wts)
//   body: type=1, oid=<cid>, bvid, aid, msg, progress(ms), mode, fontsize, color, pool=0, rnd, csrf
// 注意 oid 是 **cid**，不是 aid；先 x/web-interface/view 拿 aid/cid/duration。
//
// 和直播弹幕一样是公开对外发言：过 interact 守卫、身份闸、限额闸并记账；
// 另外有本地的 30 秒间隔 / 每日上限 / 同视频同文去重，避免手滑刷屏。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { accountBili, biliState } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'
import { assertInteractEnabled } from '../lib/interact.mjs'
import { assertOutboundIdentitySafe } from '../lib/outbound-guard.mjs'
import { gate, record as recordQuota } from '../lib/quota-gate.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REF = 'https://www.bilibili.com/'
const STATE = biliState('danmaku-state.json')
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => String(u).slice(String(u).lastIndexOf('/') + 1, String(u).lastIndexOf('.'))

const argv = process.argv.slice(2)
const args = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) args.set(a.slice(2), true)
  else { args.set(a.slice(2), next); i += 1 }
}
const bvid = String(args.get('bvid') ?? '').trim()
const msg = String(args.get('msg') ?? '').trim()
const dry = args.get('dry') === true
const go = args.get('go') === true
const retract = args.get('retract')

if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) { console.error('--bvid 格式不对'); process.exit(2) }

const credPath = accountBili('credentials.json')
if (!fs.existsSync(credPath)) { console.error(`缺少凭据文件: ${credPath}`); process.exit(3) }
const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'))
for (const k of ['sessdata', 'bili_jct', 'buvid3']) {
  if (!cred[k] || String(cred[k]).trim() === '') { console.error(`凭据文件缺少 ${k}`); process.exit(3) }
}
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const csrf = String(cred.bili_jct)
const H = { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}`, origin: 'https://www.bilibili.com', cookie }

const cfg = config()
if (cfg.danmaku?.enabled === false) { console.error('视频弹幕在设置里关掉了（danmaku.enabled=false）'); process.exit(3) }
if (go && !assertInteractEnabled('发视频弹幕')) process.exit(3)

async function viewOf() {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: { 'user-agent': UA, referer: REF } })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0 || !j.data) throw new Error(`取视频信息失败 code=${j.code ?? '?'} ${j.message ?? ''}`)
  return j.data
}

async function wbiQuery(params) {
  const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'user-agent': UA, referer: REF, cookie },
  })).json()
  const img = nav?.data?.wbi_img?.img_url
  const sub = nav?.data?.wbi_img?.sub_url
  if (!img || !sub) return ''
  const mixin = MIXIN_TAB.map((i) => (keyOf(img) + keyOf(sub))[i]).join('').slice(0, 32)
  const wts = Math.round(Date.now() / 1000)
  const all = { ...params, wts }
  const clean = (v) => String(v).replace(/[!'()*]/g, '')
  const q = Object.keys(all).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(all[k]))}`).join('&')
  return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`
}

const view = await viewOf()
const pageNo = Math.max(1, Number(args.get('page') ?? 1) || 1)
const page = Array.isArray(view.pages) ? view.pages[pageNo - 1] : null
if (pageNo > 1 && !page) { console.error(`没有第 ${pageNo} P`); process.exit(2) }
const cid = Number(page?.cid ?? view.cid)
const aid = Number(view.aid)
const duration = Number(page?.duration ?? view.duration) || 0
if (!cid || !aid) { console.error('视频信息缺少 cid/aid'); process.exit(3) }

const M = { 1: 1, rolling: 1, 4: 4, bottom: 4, 5: 5, top: 5 }
const mode = M[String(args.get('mode') ?? '1').toLowerCase()] ?? 1
const fontsize = [12, 16, 18, 25, 36, 45, 64].includes(Number(args.get('fontsize'))) ? Number(args.get('fontsize')) : 25
const color = Math.min(16777215, Math.max(0, Number(args.get('color') ?? 16777215) || 0))
const progressMs = (() => {
  if (args.get('progress-ms') !== undefined) return Math.max(0, Math.round(Number(args.get('progress-ms')) || 0))
  const at = Number(args.get('at') ?? 0)
  return Math.max(0, Math.round((Number.isFinite(at) ? at : 0) * 1000))
})()
if (duration > 0 && progressMs > duration * 1000 + 1000) {
  console.error(`✗ --at 超出视频时长（${duration} 秒）`)
  process.exit(2)
}

// 撤回模式：只对 2 分钟内、自己发的弹幕有效（B站每天 3 次）。
if (retract) {
  if (!/^\d+$/.test(String(retract))) { console.error('--retract 需要 dmid 数字'); process.exit(2) }
  const body = new URLSearchParams({ dmid: String(retract), cid: String(cid), csrf })
  const r = await fetch('https://api.bilibili.com/x/dm/recall', {
    method: 'POST', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' }, body,
  })
  const out = await r.json().catch(() => ({}))
  console.log(`撤回 HTTP ${r.status} code=${out.code} ${out.message ?? ''}`)
  process.exit(out.code === 0 ? 0 : 4)
}

if (!msg) { console.error('danmaku-video 需要 --msg'); process.exit(2) }
if ([...msg].length >= 100) { console.error('弹幕内容必须小于 100 字'); process.exit(2) }
if (dry === go) { console.error('必须且只能给一个 --dry 或 --go'); process.exit(2) }
try {
  assertOutboundIdentitySafe(msg, { surface: 'B站 视频弹幕' })
} catch (error) {
  console.error(`✗ ${error.message}`)
  process.exit(9)
}

// 本地防刷：30 秒间隔 / 每日上限 / 同视频同文 24h 去重（都不是 B站 的硬限制，是防手滑）。
const now = Date.now()
const day = new Date(now).toLocaleDateString('sv-SE')
const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return { log: [] } } })()
const log = Array.isArray(state.log) ? state.log : []
const minGapSec = Math.max(5, Math.min(600, Number(cfg.danmaku?.minGapSec ?? 30) || 30))
const dailyMax = Math.max(0, Math.min(200, Number(cfg.danmaku?.dailyMax ?? 20) || 0))
const todayLog = log.filter((x) => new Date(x.at).toLocaleDateString('sv-SE') === day)
const lastAt = log.reduce((max, x) => Math.max(max, new Date(x.at).getTime() || 0), 0)
const recentDup = log.find((x) => x.bvid === bvid && x.msg === msg && now - new Date(x.at).getTime() < 24 * 3600 * 1000)
const gapLeft = lastAt ? Math.ceil((lastAt + minGapSec * 1000 - now) / 1000) : 0
if (recentDup) { console.error('✗ 这个视频 24 小时内已经发过同样的弹幕'); process.exit(3) }
if (dailyMax > 0 && todayLog.length >= dailyMax) { console.error(`✗ 今天视频弹幕已达上限 ${dailyMax} 条`); process.exit(3) }
if (gapLeft > 0) { console.error(`✗ 距离上一条视频弹幕还差 ${gapLeft} 秒（最小间隔 ${minGapSec} 秒）`); process.exit(3) }

console.log('[视频弹幕]')
console.log(`  ${bvid}  P${pageNo}  cid=${cid}  aid=${aid}  时长=${duration || '?'}s`)
console.log(`  内容：${msg}（${[...msg].length} 字）`)
console.log(`  进度：${(progressMs / 1000).toFixed(1)}s  mode=${mode}  fontsize=${fontsize}  color=${color}`)
console.log(`  本地限制：间隔 ${minGapSec}s · 今日 ${todayLog.length}/${dailyMax || '不限'}`)

if (!gate({ type: 'danmaku', target: `BV:${bvid}`, auto: true })) {
  console.error('✗ 限额闸不通过')
  process.exit(2)
}

if (dry) {
  console.log('\n[dry] 未发送。真发会 POST x/v2/dm/post（带 WBI 签名）。')
  process.exit(0)
}

const rnd = String(Math.floor(Date.now() / 1000) * 1_000_000)
const qs = await wbiQuery({ csrf, web_location: '1315873' })
if (!qs) { console.error('✗ 拿不到 WBI 签名材料（nav/wbi_img 为空）'); process.exit(5) }
const body = new URLSearchParams({
  type: '1',
  oid: String(cid),
  msg,
  bvid,
  aid: String(aid),
  progress: String(progressMs),
  color: String(color),
  fontsize: String(fontsize),
  pool: '0',
  mode: String(mode),
  rnd,
  csrf,
})
const r = await fetch(`https://api.bilibili.com/x/v2/dm/post?${qs}`, {
  method: 'POST', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' }, body,
})
const out = await r.json().catch(() => ({}))
console.log(`\n[go] HTTP ${r.status} code=${out.code} ${out.message ?? ''}`)
if (out.code !== 0) {
  console.log('  原始: ' + JSON.stringify(out).slice(0, 400))
  process.exit(6)
}
const dmid = String(out.data?.dmid_str ?? out.data?.dmid ?? '')
console.log(`  ✅ 已发送  dmid=${dmid}  progress=${progressMs}ms`)
console.log(`  撤回（2 分钟内）：node bili.mjs danmaku-video --bvid ${bvid} --retract ${dmid}`)

try {
  const next = { ...state, log: [...log, { at: new Date(now).toISOString(), bvid, cid, msg, dmid, progressMs, mode }].slice(-500) }
  fs.mkdirSync(path.dirname(STATE), { recursive: true })
  const tmp = `${STATE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  fs.renameSync(tmp, STATE)
} catch (error) {
  console.log(`  ⚠️ 写 danmaku-state.json 失败（本地防刷可能不准）：${String(error?.message ?? error).slice(0, 80)}`)
}
recordQuota({ type: 'danmaku', target: `BV:${bvid}`, note: msg.slice(0, 30), auto: true })
