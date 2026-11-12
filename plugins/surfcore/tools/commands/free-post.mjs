// 自由发布：她想发什么就发什么（不是每日任务，不设每日上限）。
//
//   文字：        free-post --text "…" --dry|--go
//   一张图：      free-post --text "…" --image <path> --dry|--go
//   视频卡片：    free-post --text "…" --bvid BV... --dry|--go
//   专栏/链接：   free-post --text "…" --link https://www.bilibili.com/read/cv... --dry|--go
//
// 和四类动态/分享共用 `daily-dynamic.json` 的 30 分钟间隔；不占分享额度、不看评分。
// 想发就发，不想发就不发；很多天一条都不发也完全正常。
//
// 发布成功后会：
//   · 写 state.free（间隔状态）
//   · 记 quota（type=free，只审计，不设上限）
//   · 追加 bili-posts.jsonl（记忆同步：记忆卡/B站 brief 会读到）
//   · 通过 notify.mjs 报备主人（失败不影响已发出的动态）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { biliState } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'
import { gate, record as recordQuota } from '../lib/quota-gate.mjs'
import { assertInteractEnabled } from '../lib/interact.mjs'
import { assertOutboundIdentitySafe } from '../lib/outbound-guard.mjs'
import { readShareState, dynamicGapWait, mergeFreeRecord } from '../lib/share-dynamic.mjs'
import { ownerOf, findVideoDynamic, createForward } from '../lib/forward.mjs'
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

const text = String(args.get('text') ?? '').trim()
const bvid = String(args.get('bvid') ?? '').trim()
const image = String(args.get('image') ?? '').trim()
const link = String(args.get('link') ?? '').trim()
const dry = args.get('dry') === true
const go = args.get('go') === true

if (!text && !bvid && !image && !link) { console.error('free-post 至少需要 --text / --image / --bvid / --link 之一'); process.exit(2) }
if (text.length > 2000) { console.error('动态正文最多 2000 字'); process.exit(2) }
if (dry && go) { console.error('--dry 和 --go 只能选一个'); process.exit(2) }
if (!dry && !go) { console.error('必须显式 --dry 或 --go'); process.exit(2) }
if (bvid && image) { console.error('一条自由动态只能选一种附件：--bvid 或 --image'); process.exit(2) }
if (bvid && !/^BV[0-9A-Za-z]{10}$/.test(bvid)) { console.error('--bvid 格式不对'); process.exit(2) }
if (image && !fs.existsSync(image)) { console.error(`图片不存在: ${image}`); process.exit(2) }
if (link && !/^https?:\/\/\S+$/i.test(link)) { console.error('--link 必须是 http(s) 链接'); process.exit(2) }

const cfg = config()
if (cfg.freePost?.enabled === false) {
  console.error('自由发布在设置里关掉了（freePost.enabled=false）')
  process.exit(3)
}
if (go && !assertInteractEnabled('自由发布')) process.exit(3)

const finalText = link && !text.includes(link) ? `${text}\n${link}` : text
try {
  assertOutboundIdentitySafe(finalText, { surface: 'B站 自由动态' })
} catch (error) {
  console.error(`✗ ${error.message}`)
  process.exit(9)
}

// 和四类动态/分享/专栏共用同一个间隔状态。
const stateFile = biliState('daily-dynamic.json')
const gapMin = Number(cfg.dynamics?.gapMin ?? 30) || 30
const gap = dynamicGapWait(readShareState(stateFile), gapMin, Date.now())
if (!gap.ok) {
  console.error(`✗ 上一条动态刚发不久（${new Date(gap.lastAt).toLocaleTimeString('zh-CN', { hour12: false })}）`
    + ` —— 任意两条动态之间要隔 ${gapMin} 分钟，还差 ${gap.waitMin} 分钟`)
  process.exit(3)
}

let avDyn = null
if (bvid) {
  try {
    const up = await ownerOf(bvid)
    if (up) avDyn = await findVideoDynamic(bvid, up)
  } catch (error) {
    console.log(`（找视频卡片失败：${String(error?.message ?? error).slice(0, 80)}）`)
  }
}
const cardLabel = avDyn ? `视频卡片（转发动态 ${avDyn.id}）` : (bvid ? '文字 + 视频链接' : (image ? '图片动态' : '文字动态'))

console.log('[自由发布]')
console.log(`  正文 ${text.length} 字 · ${cardLabel}`)
if (bvid) console.log(`  视频：${bvid}${avDyn?.title ? `《${avDyn.title.slice(0, 50)}》` : ''}`)
if (link) console.log(`  链接：${link}`)
if (gap.lastAt) console.log(`  距上一条动态：${Math.floor((Date.now() - gap.lastAt) / 60000)} 分钟（要求 ≥${gapMin}）`)

if (!gate({ type: 'free', target: 'free', auto: true })) {
  console.error('✗ 限额闸不通过')
  process.exit(2)
}

if (dry) {
  console.log('\n[dry] 未上传、未发布。');
  process.exit(0)
}

let dynId = ''
try {
  if (bvid && avDyn) {
    const r = await createForward(avDyn.id, finalText)
    if (r.ok && r.id) {
      dynId = r.id
      console.log(`  ✓ 已转发视频卡片 → 新动态 ${dynId}`)
    } else {
      console.log(`  ⚠️ 转发卡片失败（code=${r.code ?? '?'} ${r.message ?? ''}），退回文字 + 链接`)
    }
  }
  if (!dynId && image) {
    const imageArgs = [path.join(HERE, 'dynamic-image.mjs'), '--image', image, ...(finalText ? ['--text', finalText] : []), '--go']
    const out = execFileSync(process.execPath, imageArgs, {
      encoding: 'utf8', timeout: 180_000, windowsHide: true,
    })
    process.stdout.write(out)
    dynId = (out.match(/dyn_id[=: ]+(\d+)/i) ?? [])[1] ?? ''
  }
  if (!dynId) {
    const body = bvid && !avDyn ? `${finalText}\nhttps://www.bilibili.com/video/${bvid}/` : finalText
    const out = execFileSync(process.execPath, [path.join(HERE, 'dynamic.mjs'), 'post', '--text', body, '--go'], {
      encoding: 'utf8', timeout: 180_000, windowsHide: true,
    })
    process.stdout.write(out)
    dynId = (out.match(/dyn_id[=: ]+(\d+)/i) ?? [])[1] ?? ''
  }
} catch (error) {
  console.error(`✗ 发布失败：${String(error?.message ?? error).slice(0, 300)}`)
  process.exit(5)
}
if (!dynId) {
  console.error('✗ 没从发布输出里解析到 dyn_id')
  process.exit(6)
}

const at = new Date().toISOString()
const atText = new Date().toLocaleTimeString('zh-CN', { hour12: false })
const url = `https://t.bilibili.com/${dynId}`
const postText = finalText || (image ? '（发了一张图片）' : (bvid ? `分享了视频 ${bvid}` : (link || '（自由动态）')))
try {
  const next = mergeFreeRecord(readShareState(stateFile), {
    date: new Date().toLocaleDateString('sv-SE'), at, atText,
    dynId, bvid, card: Boolean(avDyn), image: Boolean(image), chars: finalText.length,
  })
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2) + '\n')
} catch (error) {
  console.log(`  ⚠️ 写 daily-dynamic.json 失败（间隔可能不准）：${String(error?.message ?? error).slice(0, 80)}`)
}
recordQuota({ type: 'free', target: 'free', note: `自由动态 ${finalText.slice(0, 30)}`, auto: true })
appendBiliPost(biliState('bili-posts.jsonl'), {
  id: `dynamic:${dynId}`, type: 'dynamic', title: postText.slice(0, 50),
  text: postText, url, at, date: new Date().toLocaleDateString('sv-SE'), source: 'free-post',
})
try {
  execFileSync(process.execPath, [path.join(HERE, 'notify.mjs'),
    `【自由动态】\n${postText.slice(0, 140)}\n${url}`, '--title', 'B站自由动态'], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  })
} catch (error) {
  console.log(`  （报备失败，不影响动态：${String(error?.message ?? error).slice(0, 80)}）`)
}

console.log(`\n✓ 自由动态已发出：${url}`)
console.log(`  dyn_id=${dynId}`)
