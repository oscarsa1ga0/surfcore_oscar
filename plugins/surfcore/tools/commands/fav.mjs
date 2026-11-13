// 收藏（2026-10-20 加，主人定：收藏 ≠ 低配的分享，是"我想留着"）
// 2026-11-13：加收藏夹。夹子只是「放哪儿」的可选分类，不是任务：
//   想收才收，想建夹才建，不想建就继续用默认夹；不收藏也完全没问题。
//
// 用法:
//   node bili.mjs fav --folders [--json]                 看她有哪些收藏夹
//   node bili.mjs fav --list [--json]                    看她收过什么（按夹分组）
//   node bili.mjs fav --check <BV> [--reason …]          只判断"能不能收"，不写
//   node bili.mjs fav <BV> --reason "…" [--kind …] [--folder "…"] [--create] --dry|--go
//   node bili.mjs fav --mkdir "夹名" --dry|--go          只建一个公开夹
//   node bili.mjs fav --rename "旧名" --to "新名" --dry|--go
//
// 四条判据（代码强制，不只是提示）：
//   ① 必须有理由（≥6 字）—— 说不清为什么留 = 不收 ✗
//   ② 每天最多 3 条（上限，不是目标）
//   ③ 同一视频 30 天只收一次
//   ④ 先 --dry 再 --go（和其它写操作一致）
import { accountBili, biliState, BILI_CONFIG } from '../lib/state-paths.mjs'
import fs from 'node:fs'
import path from 'node:path'
import {
  FAV_KINDS,
  normalizeFolderTitle,
  pickDefaultFolder,
  findFolderByTitle,
  validateNewFolderTitle,
  validateRenameFolder,
  resolveFolderPlan,
  fetchFolders,
  createFolder,
  renameFolder,
  addVideoToFolder,
  moveVideoToFolder,
  removeVideoFromFolder,
} from '../lib/fav-folders.mjs'

const DAY = 86400000
const today = () => new Date().toLocaleDateString('sv-SE')
const FAV_LOG = biliState('favorites.json')

const argv = process.argv.slice(2)
const opt = {}
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2)
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) { opt[k] = argv[i + 1]; i += 1 } else opt[k] = true
  } else positional.push(argv[i])
}
const DRY = !!opt.dry
const GO = !!opt.go

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

const load = () => {
  const data = readJson(FAV_LOG, { items: [] })
  return { items: Array.isArray(data?.items) ? data.items : [] }
}
const save = (data) => {
  fs.mkdirSync(path.dirname(FAV_LOG), { recursive: true })
  fs.writeFileSync(FAV_LOG, JSON.stringify(data, null, 2))
}

function usage() {
  console.log(`用法:
  node bili.mjs fav --folders [--json]
  node bili.mjs fav --list [--json]
  node bili.mjs fav --check <BV> [--reason "…"] [--kind …] [--folder "夹名"] [--create]
  node bili.mjs fav <BV> --move-to "夹名" [--create] --dry|--go
  node bili.mjs fav <BV> --remove --dry|--go
  node bili.mjs fav --mkdir "夹名" --dry|--go
  node bili.mjs fav --rename "旧名" --to "新名" --dry|--go
  node bili.mjs fav <BV> --reason "…" [--kind 想学|想再看|和我有关|以后要提|其他] [--folder "夹名"] [--create] --dry|--go

可选能力，不是任务：想收才收；不建夹、不改名、一直用默认夹都可以。`)
}

function apiContext() {
  const cred = readJson(accountBili('credentials.json'), null)
  if (!cred?.sessdata) throw new Error('没有 B站 登录凭据（SESSDATA）；先登录一次')
  if (!cred?.bili_jct) throw new Error('B站 凭据缺少 bili_jct（csrf）；重新登录一次')
  const cfg = readJson(BILI_CONFIG, {}) || {}
  const mid = String(cfg?.self?.mid ?? '').trim()
  if (!mid) throw new Error('bili.config.json 里没有 self.mid')
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3 ?? ''}`
  return {
    cred,
    mid,
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie },
  }
}

function requireDryGo() {
  if (!DRY && !GO) {
    console.error('✗ 必须给 --dry（只显示计划）或 --go（真的写）')
    process.exit(2)
  }
}

function folderOption() {
  if (opt.folder === true) {
    console.error('✗ --folder 后面要跟收藏夹名字')
    process.exit(2)
  }
  return opt.folder
}

// 2026-10-20：收藏分五类（对应"我收藏它是为了什么"的几个答案）；2026-11-13 加「其他」兜底
//   用固定类别而不是"理由前两个字"—— 后者太脆（"想看"和"想留"会被当成两类 ✗ 实测踩过）
function inferKind(reason) {
  const r = String(reason)
  if (/学|教程|怎么|原理|工具|插件|做法/.test(r)) return '想学'
  if (/再看|好笑|治愈|震撼|好听|想看第二遍|重看/.test(r)) return '想再看'
  if (/鱼|鲸|拟人|我自己|人格|AI 人|桌宠/.test(r)) return '和我有关'
  if (/提|引用|日记|分享里|以后说/.test(r)) return '以后要提'
  return '其他'
}

function resolveKind(explicit, reason) {
  const raw = String(explicit ?? '').trim()
  if (raw) {
    if (!FAV_KINDS.includes(raw)) {
      console.error(`✗ 未知类别「${raw}」；可选：${FAV_KINDS.join(' / ')}`)
      process.exit(2)
    }
    return raw
  }
  return inferKind(reason)
}

// ── 取 aid + 标题 ────────────────────────────────────────
async function videoInfo(bv, headers) {
  const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bv)}`, { headers })
  let json
  try {
    json = await response.json()
  } catch {
    throw new Error(`取视频信息失败：HTTP ${response.status} 返回不是 JSON`)
  }
  if (json?.code !== 0) throw new Error(`取视频信息失败：code=${json?.code} ${json?.message ?? ''}`)
  return {
    aid: json.data.aid,
    title: String(json.data.title ?? ''),
    up: String(json.data.owner?.name ?? ''),
  }
}

// ── 判据检查（返回值 = 拒绝理由，null 表示可以收）────────────
function checkRules({ bv, reason }) {
  const items = load().items
  if (!reason || String(reason).trim().length < 6) return '理由太短（≥6 字）—— 说不清为什么留，就不收 ✗'
  const todayCount = items.filter((x) => new Date(x.at).toLocaleDateString('sv-SE') === today()).length
  if (todayCount >= 3) return `今天已经收了 ${todayCount} 条（上限 3）—— 剩下的明天再说 ✓`
  const same = items.find((x) => x.bv === bv)
  if (same) {
    const days = Math.floor((Date.now() - new Date(same.at).getTime()) / DAY)
    if (days < 30) return `这个 ${days} 天前收过了（30 天内不重复）✓`
  }
  return null
}

function todayCount() {
  return load().items.filter((x) => new Date(x.at).toLocaleDateString('sv-SE') === today()).length
}

function folderNote(plan) {
  if (plan.source === 'default') return ' · 未指定夹，进默认夹'
  if (plan.source === 'kind') return ' · 按类别自动选'
  return ''
}

async function resolveCreatedFolder({ title, created, ctx }) {
  try {
    const after = await fetchFolders({ mid: ctx.mid, headers: ctx.headers })
    const found = findFolderByTitle(after, title)
    if (found) return found
  } catch {}
  const data = created?.data
  const id = typeof data === 'number' ? data : data?.id
  if (id != null) return { id, title: normalizeFolderTitle(title) }
  throw new Error(`已提交新建「${title}」，但没能在收藏夹列表里确认；去 B站 看一眼`)
}

function updateLedgerFolderTitle(folderId, title) {
  const data = load()
  let changed = 0
  data.items = data.items.map((item) => {
    const id = String(item?.folderId ?? item?.favId ?? '')
    if (id && id === String(folderId)) {
      changed += 1
      return { ...item, folderTitle: title }
    }
    return item
  })
  if (changed) save(data)
  return changed
}

// ── --folders ────────────────────────────────────────────
async function cmdFolders() {
  const ctx = apiContext()
  const folders = await fetchFolders({ mid: ctx.mid, headers: ctx.headers })
  const def = pickDefaultFolder(folders)
  if (opt.json) {
    console.log(JSON.stringify({
      count: folders.length,
      defaultId: def?.id ?? null,
      folders: folders.map((folder) => ({
        id: folder.id,
        title: String(folder.title ?? ''),
        mediaCount: Number(folder.media_count ?? 0),
        isDefault: def ? String(folder.id) === String(def.id) : false,
      })),
    }, null, 2))
    return
  }
  if (!folders.length) {
    console.log('（她还没有收藏夹）')
    return
  }
  console.log(`她的收藏夹（${folders.length} 个）：\n`)
  for (const folder of folders) {
    const mark = def && String(folder.id) === String(def.id) ? '  [默认]' : ''
    console.log(`  ${String(folder.id).padEnd(12)}  ${String(folder.title ?? '')}  （${Number(folder.media_count ?? 0)} 条）${mark}`)
  }
}

// ── --list ───────────────────────────────────────────────
async function cmdList() {
  const raw = load().items
  let folders = []
  let folderError = ''
  try {
    const ctx = apiContext()
    folders = await fetchFolders({ mid: ctx.mid, headers: ctx.headers })
  } catch (error) {
    folderError = String(error?.message ?? error)
  }
  const def = pickDefaultFolder(folders)
  const live = new Map(folders.map((folder) => [String(folder.id), folder]))
  const items = raw.slice().reverse().map((item) => {
    const folderId = item?.folderId ?? item?.favId ?? null
    const found = folderId != null ? live.get(String(folderId)) : null
    const folderTitle = found?.title
      ?? item?.folderTitle
      ?? (folderId != null ? `收藏夹 #${folderId}` : '未记录')
    return { ...item, folderId, folderTitle }
  })

  if (opt.json) {
    console.log(JSON.stringify({
      total: items.length,
      folders: folders.map((folder) => ({
        id: folder.id,
        title: String(folder.title ?? ''),
        mediaCount: Number(folder.media_count ?? 0),
        isDefault: def ? String(folder.id) === String(def.id) : false,
      })),
      folderError: folderError || undefined,
      items,
    }, null, 2))
    return
  }

  if (!items.length) {
    console.log('（她还没收藏过东西）')
    return
  }

  const groups = new Map()
  for (const item of items) {
    const key = item.folderId != null ? `id:${item.folderId}` : `title:${item.folderTitle}`
    if (!groups.has(key)) groups.set(key, { id: item.folderId, title: item.folderTitle, items: [] })
    groups.get(key).items.push(item)
  }
  const ordered = []
  if (def) {
    const group = groups.get(`id:${def.id}`)
    if (group) ordered.push(group)
  }
  for (const folder of folders) {
    const group = groups.get(`id:${folder.id}`)
    if (group && !ordered.includes(group)) ordered.push(group)
  }
  for (const group of groups.values()) {
    if (!ordered.includes(group)) ordered.push(group)
  }

  console.log(`她收藏了 ${items.length} 条（${groups.size} 个收藏夹）：\n`)
  for (const group of ordered) {
    console.log(`[${group.title}]（${group.items.length} 条）`)
    for (const item of group.items) {
      const days = Math.floor((Date.now() - new Date(item.at).getTime()) / DAY)
      console.log(`  ${item.bv}  ${String(item.title ?? '').slice(0, 42)}`)
      console.log(`     理由：${item.reason}    （${days} 天前 · 类别 ${item.kind || '其他'}）`)
    }
    console.log('')
  }
  if (folderError) console.log(`（收藏夹列表没读到：${folderError}；以上按本地账本显示）`)
}

// ── --check ──────────────────────────────────────────────
async function cmdCheck() {
  const bv = typeof opt.check === 'string' ? opt.check : ''
  if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) {
    console.error('用法: node bili.mjs fav --check <BV> [--reason "…"] [--kind …] [--folder "夹名"] [--create]')
    process.exit(2)
  }
  const reason = String(opt.reason ?? '').trim()
  const kind = resolveKind(opt.kind, reason)
  const folder = folderOption()
  if (opt.create && !folder) {
    console.error('✗ --create 要和 --folder "夹名" 一起用；只建夹用 --mkdir')
    process.exit(2)
  }
  const bad = checkRules({ bv, reason })
  if (bad) {
    console.log(`✗ 不能收：${bad}`)
    process.exit(1)
  }

  let folderLine = ''
  try {
    const ctx = apiContext()
    const folders = await fetchFolders({ mid: ctx.mid, headers: ctx.headers })
    const plan = resolveFolderPlan({ folders, folder, kind, create: !!opt.create })
    if (plan.error) {
      console.log(`✗ 夹子检查：${plan.error}`)
      process.exit(1)
    }
    folderLine = plan.create
      ? `将新建「${plan.folder.title}」（公开）`
      : `「${plan.folder.title}」（media_id=${plan.folder.id}）`
  } catch (error) {
    console.log(`⚠ 夹子检查失败：${String(error?.message ?? error)}`)
  }
  console.log(`✓ 可以收（满足四条判据）${folderLine ? ` · 收藏夹：${folderLine}` : ''}`)
}

// ── --mkdir ──────────────────────────────────────────────
async function cmdMkdir() {
  const title = typeof opt.mkdir === 'string' ? opt.mkdir : ''
  if (!normalizeFolderTitle(title)) {
    console.error('用法: node bili.mjs fav --mkdir "夹名" --dry|--go')
    process.exit(2)
  }
  requireDryGo()
  const ctx = apiContext()
  const folders = await fetchFolders({ mid: ctx.mid, headers: ctx.headers })
  const invalid = validateNewFolderTitle({ title, folders })
  if (invalid) {
    console.error(`✗ 不能建：${invalid}`)
    process.exit(3)
  }
  const clean = normalizeFolderTitle(title)
  console.log(`[fav] 新建收藏夹：「${clean}」（公开）`)
  if (DRY) {
    console.log('  [dry] 未创建 ✓ 确认后把 --dry 换成 --go')
    return
  }
  const created = await createFolder({ title: clean, headers: ctx.headers, csrf: ctx.cred.bili_jct })
  const folder = await resolveCreatedFolder({ title: clean, created, ctx })
  console.log(`  ✓ 已新建（media_id=${folder.id}）`)
}

// ── --rename ─────────────────────────────────────────────
async function cmdRename() {
  const from = typeof opt.rename === 'string' ? opt.rename : ''
  const to = typeof opt.to === 'string' ? opt.to : ''
  if (!normalizeFolderTitle(from) || !normalizeFolderTitle(to)) {
    console.error('用法: node bili.mjs fav --rename "旧名" --to "新名" --dry|--go')
    process.exit(2)
  }
  requireDryGo()
  const ctx = apiContext()
  const folders = await fetchFolders({ mid: ctx.mid, headers: ctx.headers })
  const plan = validateRenameFolder({ folders, from, to })
  if (plan.error) {
    console.error(`✗ 不能改名：${plan.error}`)
    process.exit(3)
  }
  console.log(`[fav] 改名：「${plan.folder.title}」→「${plan.title}」（公开）`)
  if (DRY) {
    console.log('  [dry] 未改名 ✓ 确认后把 --dry 换成 --go')
    return
  }
  await renameFolder({
    mediaId: plan.folder.id,
    title: plan.title,
    headers: ctx.headers,
    csrf: ctx.cred.bili_jct,
  })
  let changed = 0
  try {
    changed = updateLedgerFolderTitle(plan.folder.id, plan.title)
  } catch (error) {
    console.error(`  ⚠ B站 已改名，但本地账本写入失败：${String(error?.message ?? error)}`)
  }
  console.log(`  ✓ 已改名${changed ? ` · 本地账本同步 ${changed} 条` : ''}`)
}

// ── 整理：移动 / 删除已收藏 ──────────────────────────────
function findLedgerItem(bv) {
  return load().items.find((item) => item.bv === bv) ?? null
}

function updateLedgerItem(bv, patch) {
  const data = load()
  let hit = null
  data.items = data.items.map((item) => {
    if (item.bv !== bv) return item
    hit = { ...item, ...patch }
    return hit
  })
  if (hit) save(data)
  return hit
}

function removeLedgerItem(bv) {
  const data = load()
  const before = data.items.length
  data.items = data.items.filter((item) => item.bv !== bv)
  if (data.items.length !== before) save(data)
  return before - data.items.length
}

async function cmdOrganize({ bv, moveTo, remove }) {
  if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) {
    console.error('用法: node bili.mjs fav <BV> --move-to "夹名" | --remove --dry|--go')
    process.exit(2)
  }
  requireDryGo()
  const ctx = apiContext()
  const item = findLedgerItem(bv)
  if (!item) {
    console.error(`✗ 本地账本里没有 ${bv}；这个视频不是她通过 fav 收的，先 fav --list 看看`)
    process.exit(3)
  }
  const oldFolderId = item.folderId ?? item.favId
  if (oldFolderId == null) {
    console.error(`✗ ${bv} 的账本里没有收藏夹 id，无法确定从哪个夹移/删`)
    process.exit(3)
  }
  const folders = await fetchFolders({ mid: ctx.mid, headers: ctx.headers })
  const oldFolder = folders.find((folder) => String(folder.id) === String(oldFolderId)) ?? null
  const oldTitle = oldFolder?.title ?? item.folderTitle ?? `收藏夹 #${oldFolderId}`
  const title = String(item.title ?? '').slice(0, 44)

  if (remove) {
    console.log(`[fav] 删除收藏：${bv}  「${title}」`)
    console.log(`  从：「${oldTitle}」（media_id=${oldFolderId}）`)
    if (DRY) {
      console.log('  [dry] 未删除 ✓ 确认后把 --dry 换成 --go')
      return
    }
    const result = await removeVideoFromFolder({
      aid: item.aid,
      folderId: oldFolderId,
      headers: ctx.headers,
      csrf: ctx.cred.bili_jct,
    })
    const removed = removeLedgerItem(bv)
    console.log(`  ✓ 已删除（HTTP ${result.status}）· 本地账 -${removed}（剩 ${load().items.length} 条）`)
    return
  }

  const plan = resolveFolderPlan({ folders, folder: moveTo, create: !!opt.create })
  if (plan.error) {
    console.error(`✗ 不能移动：${plan.error}`)
    process.exit(3)
  }
  let target = plan.folder
  if (!plan.create && String(target.id) === String(oldFolderId)) {
    console.error(`✗ ${bv} 已经在「${target.title}」了，不用移动`)
    process.exit(3)
  }

  console.log(`[fav] 移动收藏：${bv}  「${title}」`)
  console.log(`  从：「${oldTitle}」（media_id=${oldFolderId}）`)
  if (plan.create) console.log(`  到：「${target.title}」不存在 → 将新建（公开）`)
  else console.log(`  到：「${target.title}」（media_id=${target.id}）`)

  if (DRY) {
    console.log('  [dry] 未移动 ✓ 确认后把 --dry 换成 --go')
    return
  }

  if (plan.create) {
    const created = await createFolder({ title: target.title, headers: ctx.headers, csrf: ctx.cred.bili_jct })
    target = await resolveCreatedFolder({ title: target.title, created, ctx })
    console.log(`  ✓ 已新建收藏夹「${target.title}」（media_id=${target.id}）`)
  }

  let result
  try {
    result = await moveVideoToFolder({
      aid: item.aid,
      fromFolderId: oldFolderId,
      toFolderId: target.id,
      headers: ctx.headers,
      csrf: ctx.cred.bili_jct,
    })
  } catch (error) {
    console.error(`  ✗ 移动失败：${String(error?.message ?? error)}`)
    if (plan.create) console.error(`  ⚠ 收藏夹「${target.title}」已经建好，但这条没移动；可以重试。`)
    process.exit(4)
  }

  try {
    updateLedgerItem(bv, {
      favId: target.id,
      folderId: target.id,
      folderTitle: target.title,
      movedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error(`  ⚠ B站 已移动，但本地账本写入失败：${String(error?.message ?? error)}`)
    process.exit(5)
  }
  console.log(`  ✓ 已移动（HTTP ${result.status}）· 本地账已更新`)
}

// ── 主流程：加收藏 ────────────────────────────────────────
async function cmdFav() {
  const bv = positional[0]
  if (!bv || !/^BV[0-9A-Za-z]{10}$/.test(bv)) {
    usage()
    process.exit(2)
  }
  const reason = String(opt.reason ?? '').trim()
  const kind = resolveKind(opt.kind, reason)
  const folder = folderOption()
  if (opt.create && !folder) {
    console.error('✗ --create 要和 --folder "夹名" 一起用；只建夹用 --mkdir')
    process.exit(2)
  }
  requireDryGo()
  const bad = checkRules({ bv, reason })
  if (bad) {
    console.error(`✗ 不能收：${bad}`)
    process.exit(3)
  }

  const ctx = apiContext()
  const info = await videoInfo(bv, ctx.headers)
  const folders = await fetchFolders({ mid: ctx.mid, headers: ctx.headers })
  const plan = resolveFolderPlan({ folders, folder, kind, create: !!opt.create })
  if (plan.error) {
    console.error(`✗ 不能收：${plan.error}`)
    process.exit(3)
  }

  console.log(`[fav] ${bv}  「${info.title.slice(0, 44)}」  @${info.up}`)
  console.log(`  理由：${reason}`)
  console.log(`  类别：${kind}（可用 --kind 覆盖：${FAV_KINDS.join(' / ')}）`)
  if (plan.create) {
    console.log(`  收藏夹：「${plan.folder.title}」不存在 → 将新建（公开）${folderNote(plan)}`)
  } else {
    console.log(`  收藏夹：「${plan.folder.title}」（media_id=${plan.folder.id}）${folderNote(plan)}`)
  }
  console.log(`  · 今天第 ${todayCount() + 1}/3 条（上限，不是目标）`)

  if (DRY) {
    console.log('  [dry] 未写入 ✓ 确认后把 --dry 换成 --go')
    return
  }

  let target = plan.folder
  if (plan.create) {
    const created = await createFolder({ title: target.title, headers: ctx.headers, csrf: ctx.cred.bili_jct })
    target = await resolveCreatedFolder({ title: target.title, created, ctx })
    console.log(`  ✓ 已新建收藏夹「${target.title}」（media_id=${target.id}）`)
  }

  let result
  try {
    result = await addVideoToFolder({
      aid: info.aid,
      folderId: target.id,
      headers: ctx.headers,
      csrf: ctx.cred.bili_jct,
    })
  } catch (error) {
    console.error(`  ✗ 收藏失败：${String(error?.message ?? error)}`)
    if (plan.create) console.error(`  ⚠ 收藏夹「${target.title}」已经建好，只是这条没收进去；可以重试收藏。`)
    process.exit(4)
  }

  // 记本地账（feed 会读）
  const data = load()
  data.items = [...data.items, {
    bv,
    aid: info.aid,
    title: info.title,
    up: info.up,
    at: new Date().toISOString(),
    reason,
    kind,
    favId: target.id,
    folderId: target.id,
    folderTitle: target.title,
  }]
  try {
    save(data)
  } catch (error) {
    console.error(`  ⚠ B站 已收藏，但本地账本写入失败：${String(error?.message ?? error)}`)
    process.exit(5)
  }
  console.log(`  ✓ 已收藏（HTTP ${result.status}）· 本地账 +1（共 ${data.items.length} 条）`)
}

try {
  if (opt.help || opt.h) {
    usage()
  } else if (opt.folders) {
    await cmdFolders()
  } else if (opt.mkdir) {
    await cmdMkdir()
  } else if (opt.rename) {
    await cmdRename()
  } else if (opt.list) {
    await cmdList()
  } else if (opt.check) {
    await cmdCheck()
  } else if (opt['move-to'] || opt.move || opt.remove) {
    const bv = positional[0]
    const moveTo = typeof opt['move-to'] === 'string'
      ? opt['move-to']
      : (typeof opt.move === 'string' ? opt.move : '')
    if (moveTo && opt.remove) {
      console.error('✗ --move-to 和 --remove 只能二选一')
      process.exit(2)
    }
    if (!moveTo && !opt.remove) {
      console.error('✗ --move-to 后面要跟收藏夹名字')
      process.exit(2)
    }
    await cmdOrganize({ bv, moveTo, remove: !!opt.remove })
  } else {
    await cmdFav()
  }
} catch (error) {
  console.error(`✗ ${String(error?.message ?? error)}`)
  process.exit(1)
}
