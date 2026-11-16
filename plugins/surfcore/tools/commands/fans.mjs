// B站粉丝（只读）：看当前粉丝数 / 新粉丝，不改任何关系。
//
//   node bili.mjs fans [--json]              当前粉丝
//   node bili.mjs fans --new [--json]        上次检查之后的新粉丝
//   node bili.mjs fans --baseline            把当前粉丝记为“已见”
//
// 新粉丝状态在 state/fans-seen.json（按关注时间 mtime 水位）；主人不算“新粉丝”。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { biliState } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'
import { loadBiliAccount } from '../../../../src/bili-api.js'
import { localIso } from '../../../../src/local-time.js'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) opt[argv[i].slice(2)] = true
  else { opt[argv[i].slice(2)] = next; i += 1 }
}
const NEW = !!opt.new
const BASE = !!opt.baseline
const JSONOUT = !!opt.json

const account = loadBiliAccount({ home: os.homedir() })
if (!account.mid) { console.error('✗ 配置 self.mid 为空'); process.exit(3) }
if (!account.hasCredentials) { console.error('✗ 缺少 B 站凭据'); process.exit(3) }
const cfg = config()
const ownerMid = String(cfg.owner?.mid ?? '').trim()
const STATE = biliState('fans-seen.json')
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} } }
const saveState = (o) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, `${JSON.stringify(o, null, 2)}\n`) }

async function fetchJson(url) {
  const r = await fetch(url, { headers: account.headers, signal: AbortSignal.timeout(15000) })
  const j = await r.json().catch(() => ({}))
  if (j?.code !== 0) throw new Error(`${url.includes('relation/stat') ? 'relation/stat' : 'relation/fans'} code=${j?.code ?? r.status} ${j?.message ?? ''}`)
  return j.data ?? {}
}

let stat; let fans;
try {
  stat = await fetchJson(`https://api.bilibili.com/x/relation/stat?vmid=${encodeURIComponent(account.mid)}`)
  fans = await fetchJson(`https://api.bilibili.com/x/relation/fans?vmid=${encodeURIComponent(account.mid)}&pn=1&ps=50&re_version=0`)
} catch (error) {
  console.error(`✗ ${error?.message ?? error}`)
  process.exit(4)
}
const list = (Array.isArray(fans.list) ? fans.list : []).map((x) => ({
  mid: String(x.mid ?? ''),
  name: String(x.uname ?? ''),
  time: Number(x.mtime ?? 0) || 0,
  attribute: Number(x.attribute ?? 0) || 0,
})).filter((x) => x.mid)
const follower = Number(stat.follower) || 0
const following = Number(stat.following) || 0

const state = loadState()
const lastSeen = Number(state.lastSeen ?? 0) || 0
const now = Math.floor(Date.now() / 1000)

if (BASE) {
  const max = Math.max(lastSeen, ...list.map((x) => x.time), 0)
  saveState({ lastSeen: max, at: new Date().toISOString() })
  console.log(`已把当前 ${list.length} 个粉丝记为已见（水位 ${max}）✓`)
  process.exit(0)
}

const fresh = list
  .filter((x) => x.mid !== ownerMid && (lastSeen === 0 ? x.time > 0 : x.time > lastSeen))
  .sort((a, b) => b.time - a.time)

if (NEW && fresh.length) {
  saveState({ lastSeen: Math.max(lastSeen, ...fresh.map((x) => x.time), 0), at: new Date().toISOString() })
}

const payload = {
  ok: true,
  follower,
  following,
  newFans: fresh.map((x) => ({ ...x, at: x.time ? localIso(new Date(x.time * 1000)) : '' })),
}
if (JSONOUT) {
  console.log(JSON.stringify(payload))
  process.exit(0)
}

console.log(`B站粉丝：${follower} 个 · 关注 ${following} 个`)
if (!NEW) {
  if (!list.length) console.log('（还没有粉丝）')
  else for (const x of list) console.log(`- ${x.name || '（无昵称）'}  mid=${x.mid}  ${x.time ? new Date(x.time * 1000).toLocaleString('zh-CN', { hour12: false }) : ''}${x.mid === ownerMid ? '  [主人]' : ''}`)
} else if (!fresh.length) {
  console.log('没有新粉丝')
} else {
  console.log(`新粉丝 ${fresh.length} 个：`)
  for (const x of fresh) console.log(`- ${x.name || '（无昵称）'}  mid=${x.mid}  ${x.time ? new Date(x.time * 1000).toLocaleString('zh-CN', { hour12: false }) : ''}`)
}
console.log(`\n水位：${Math.max(lastSeen, ...list.map((x) => x.time), 0)}`)
