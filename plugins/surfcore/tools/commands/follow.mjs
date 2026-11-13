// 关注 / 取关（B站站内用户）
//
//   node bili.mjs follow --list [--limit 20]
//   node bili.mjs follow --mid 353782040 --status
//   node bili.mjs follow --mid 123456 --dry|--go
//   node bili.mjs follow --mid 123456 --unfollow --dry|--go
//
// 接口：
//   GET  https://api.bilibili.com/x/relation?fid=<mid>              → attribute（0 未关注 / 2 已关注 / 6 互关）
//   POST https://api.bilibili.com/x/relation/modify                 → fid / act(1关注 2取关) / re_src=11 / csrf
//   GET  https://api.bilibili.com/x/relation/followings?vmid=<self> → 关注列表
//
// 安全边界：
//   · 不能关注/取关自己；不能取关主人（否则私信互关会断）
//   · --go 要过 interact 守卫；关注/取关共用最小间隔和每日上限（设置页可调）
//   · 发完写 quota 账本并 notify 报备；关注/取关后回读 relation 确认真实状态
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
const args = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) args.set(a.slice(2), true)
  else { args.set(a.slice(2), next); i += 1 }
}

const cfg = config()
const selfMid = String(cfg.self?.mid ?? '').trim()
const ownerMid = String(cfg.owner?.mid ?? '').trim()
const mid = String(args.get('mid') ?? args.get('uid') ?? args.get('fid') ?? '').trim()
const dry = args.get('dry') === true
const go = args.get('go') === true
const unfollow = args.get('unfollow') === true
const list = args.get('list') === true
const status = args.get('status') === true
const limit = Math.max(1, Math.min(50, Number(args.get('limit') ?? 20) || 20))
const reason = String(args.get('reason') ?? '').trim()

if (!selfMid) { console.error('✗ 配置 self.mid 为空，先跑 session 确认账号'); process.exit(3) }
const credPath = accountBili('credentials.json')
if (!fs.existsSync(credPath)) { console.error(`缺少凭据文件: ${credPath}`); process.exit(3) }
const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'))
for (const k of ['sessdata', 'bili_jct', 'buvid3']) {
  if (!cred[k] || String(cred[k]).trim() === '') { console.error(`凭据文件缺少 ${k}`); process.exit(3) }
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const csrf = String(cred.bili_jct)
const H = (target = '') => ({
  'user-agent': UA,
  referer: `https://space.bilibili.com/${target || selfMid}`,
  origin: 'https://space.bilibili.com',
  cookie,
})

async function relationOf(fid) {
  const r = await fetch(`https://api.bilibili.com/x/relation?fid=${encodeURIComponent(fid)}`, { headers: H(fid) })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message, attribute: null }
  return { ok: true, attribute: Number(j.data?.attribute) || 0, data: j.data ?? {} }
}

async function cardOf(fid) {
  try {
    const r = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(fid)}`, { headers: H(fid) })
    const j = await r.json().catch(() => ({}))
    return { name: String(j?.data?.card?.name ?? ''), sign: String(j?.data?.card?.sign ?? '') }
  } catch {
    return { name: '', sign: '' }
  }
}

const attrLabel = (attribute) => attribute === 6 ? '互关' : attribute === 2 ? '已关注' : attribute === 128 ? '已拉黑' : '未关注'

if (list) {
  const r = await fetch(`https://api.bilibili.com/x/relation/followings?vmid=${encodeURIComponent(selfMid)}&pn=1&ps=${limit}`, { headers: H() })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0) { console.error(`✗ 取关注列表失败 code=${j.code} ${j.message ?? ''}`); process.exit(4) }
  const items = j?.data?.list ?? []
  console.log(`[关注列表] ${j?.data?.total ?? items.length} 人（本页 ${items.length}）`)
  for (const [i, it] of items.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. ${it.mid}  ${it.uname}${it.sign ? `  — ${String(it.sign).slice(0, 50)}` : ''}`)
  }
  process.exit(0)
}

if (status) {
  if (!/^\d+$/.test(mid)) { console.error('--status 需要 --mid 数字'); process.exit(2) }
  const rel = await relationOf(mid)
  if (!rel.ok) { console.error(`✗ 查关系失败 code=${rel.code} ${rel.message ?? ''}`); process.exit(4) }
  const card = await cardOf(mid)
  console.log(`${mid}  ${card.name || '(未知昵称)'}  → ${attrLabel(rel.attribute)}（attribute=${rel.attribute}）`)
  process.exit(0)
}

if (!/^\d+$/.test(mid)) { console.error('follow 需要 --mid（数字）'); process.exit(2) }
if (dry === go) { console.error('必须且只能给一个 --dry 或 --go'); process.exit(2) }
if (String(mid) === selfMid) { console.error('✗ 不能关注/取关自己'); process.exit(3) }
if (unfollow && ownerMid && String(mid) === ownerMid) { console.error('✗ 不能取关主人（私信互关会断）'); process.exit(3) }
if (cfg.follow?.enabled === false) { console.error('关注/取关在设置里关掉了（follow.enabled=false）'); process.exit(3) }
if (go && !assertInteractEnabled(unfollow ? '取关' : '关注')) process.exit(3)

const rel = await relationOf(mid)
if (!rel.ok) { console.error(`✗ 查关系失败 code=${rel.code} ${rel.message ?? ''}`); process.exit(4) }
const card = await cardOf(mid)
const name = card.name || `mid ${mid}`
const already = unfollow ? rel.attribute === 0 : (rel.attribute === 2 || rel.attribute === 6)

// 本地防刷/账本：读 quota 日志；关注、取关共用最小间隔，分别受日上限。
const quotaFile = biliState('quota.json')
let log = []
try { log = JSON.parse(fs.readFileSync(quotaFile, 'utf8'))?.log ?? [] } catch {}
const dayKey = (iso) => new Date(iso).toLocaleDateString('sv-SE')
const today = new Date().toLocaleDateString('sv-SE')
const todayFollow = log.filter((x) => x.type === 'follow' && x.at && dayKey(x.at) === today).length
const todayUnfollow = log.filter((x) => x.type === 'unfollow' && x.at && dayKey(x.at) === today).length
const lastAction = log
  .filter((x) => ['follow', 'unfollow'].includes(x.type) && x.at)
  .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
const gapMin = Math.max(0, Math.min(1440, Number(cfg.follow?.minGapMin ?? 30) || 0))
const gapLeft = lastAction ? Math.ceil((Date.parse(lastAction.at) + gapMin * 60000 - Date.now()) / 60000) : 0
const max = unfollow
  ? Math.max(0, Math.min(50, Number(cfg.follow?.unfollowDailyMax ?? 3) || 0))
  : Math.max(0, Math.min(50, Number(cfg.follow?.dailyMax ?? 3) || 0))
const todayCount = unfollow ? todayUnfollow : todayFollow

console.log(`[${unfollow ? '取关' : '关注'}] ${name}（mid ${mid}）`)
console.log(`  当前关系：${attrLabel(rel.attribute)}（attribute=${rel.attribute}）`)
console.log(`  本地限制：${unfollow ? '取关' : '关注'} ${todayCount}/${max || '不限'} · 间隔 ${gapMin} 分钟${gapLeft > 0 ? `（还差 ${gapLeft} 分钟）` : ' ✓'}`)

if (already) {
  console.log(`  ${unfollow ? '本来就没关注' : '已经是关注/互关状态'}，不需要再操作。`)
  process.exit(0)
}
if (max > 0 && todayCount >= max) { console.error(`✗ 今天${unfollow ? '取关' : '关注'}已达上限 ${max} 个`); process.exit(3) }
if (gapLeft > 0) { console.error(`✗ 距离上一条关注/取关还差 ${gapLeft} 分钟`); process.exit(3) }
if (!gate({ type: unfollow ? 'unfollow' : 'follow', target: `mid:${mid}`, auto: true })) {
  console.error('✗ 限额闸不通过')
  process.exit(2)
}

if (dry) {
  console.log(`\n[dry] 未发送。真发会 POST x/relation/modify act=${unfollow ? 2 : 1} re_src=11。`)
  process.exit(0)
}

const body = new URLSearchParams({ fid: mid, act: unfollow ? '2' : '1', re_src: '11', csrf })
const r = await fetch('https://api.bilibili.com/x/relation/modify', {
  method: 'POST', headers: { ...H(mid), 'content-type': 'application/x-www-form-urlencoded' }, body,
})
const out = await r.json().catch(() => ({}))
console.log(`\n[go] HTTP ${r.status} code=${out.code} ${out.message ?? ''}`)
if (out.code !== 0) {
  console.log('  原始: ' + JSON.stringify(out).slice(0, 300))
  process.exit(5)
}

// 回读：确认不是“接口说成功但实际没变”
let after = null
try { after = await relationOf(mid) } catch {}
const expectOk = unfollow ? after?.attribute === 0 : (after?.attribute === 2 || after?.attribute === 6)
console.log(`  ${expectOk ? '✅ 已确认' : '⚠️ 未确认'}：${after ? attrLabel(after.attribute) : '回读失败'}`)

try {
  recordQuota({ type: unfollow ? 'unfollow' : 'follow', target: `mid:${mid}`, note: `${name}${reason ? `：${reason.slice(0, 40)}` : ''}`, auto: true })
} catch (error) {
  console.log(`  ⚠️ 写 quota 失败：${String(error?.message ?? error).slice(0, 80)}`)
}
try {
  execFileSync(process.execPath, [path.join(HERE, 'notify.mjs'),
    `【B站${unfollow ? '取关' : '关注'}】${name}（mid ${mid}）\nhttps://space.bilibili.com/${mid}`, '--title', `B站${unfollow ? '取关' : '关注'}`], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  })
} catch (error) {
  console.log(`  （报备失败，不影响操作：${String(error?.message ?? error).slice(0, 80)}）`)
}

console.log(`\n✓ ${unfollow ? '已取关' : '已关注'}：${name}（mid ${mid}）`)
console.log(`  https://space.bilibili.com/${mid}`)
