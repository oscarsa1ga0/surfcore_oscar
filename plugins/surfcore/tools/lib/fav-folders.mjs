/**
 * B站收藏夹的选夹/建夹/改名规则（纯逻辑）+ 只碰收藏夹的接口封装。
 *
 * 设计边界（2026-11-13 主人定）：
 *   · 收藏夹是「放哪儿」的自由分类，名字由鱼姬自己起；kind 仍是「为什么留」的固定五类。
 *   · 新夹一律公开；不自动建夹 —— 命令里明确带 --create / --mkdir 才建。
 *   · 默认夹是 B站 自带夹：不能改名，选夹时永远作为兜底。
 *   · 收藏、建夹、改名都是可选能力，不是每日任务；这里只负责规则，不负责催她做。
 *
 * 这个文件不读配置/凭据，方便单测；命令层负责把 headers / csrf 传进来。
 */

export const FAV_KINDS = ['想学', '想再看', '和我有关', '以后要提', '其他']
export const FAV_FOLDER_TITLE_MAX = 20
export const FAV_FOLDER_LIMIT = 100
export const BILI_API = 'https://api.bilibili.com'

/** 夹名统一去掉首尾空白、把连续空白压成一个空格；不做别的改写。 */
export function normalizeFolderTitle(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** 按字符（码点）数，避免 emoji 被算成两个。 */
export function folderTitleLength(value) {
  return Array.from(normalizeFolderTitle(value)).length
}

/** 只认 B站 自带的「默认收藏夹」；像「默认收藏夹2」这种自建夹不算。 */
export function isDefaultFolder(folder) {
  return normalizeFolderTitle(folder?.title) === '默认收藏夹'
}

/**
 * 账号的默认收藏夹。B站 正常会有一个「默认收藏夹」；
 * 找不到时退到列表第一个，尽量不把兜底弄丢。
 */
export function pickDefaultFolder(folders) {
  const list = Array.isArray(folders) ? folders.filter(Boolean) : []
  return list.find(isDefaultFolder)
    ?? list.find((folder) => /默认/.test(normalizeFolderTitle(folder?.title)))
    ?? list[0]
    ?? null
}

/** 按夹名精确查找（去首尾/压空白后比较）；不做模糊匹配，避免收错夹。 */
export function findFolderByTitle(folders, title) {
  const target = normalizeFolderTitle(title)
  if (!target) return null
  return (Array.isArray(folders) ? folders : [])
    .find((folder) => normalizeFolderTitle(folder?.title) === target) ?? null
}

/** 新建夹的名字校验；返回 null 表示可用，否则返回给用户看的中文原因。 */
export function validateNewFolderTitle({ title, folders } = {}) {
  const list = Array.isArray(folders) ? folders.filter(Boolean) : []
  const clean = normalizeFolderTitle(title)
  if (!clean) return '夹名不能为空'
  if (folderTitleLength(clean) > FAV_FOLDER_TITLE_MAX) return `夹名最多 ${FAV_FOLDER_TITLE_MAX} 字`
  if (clean === '默认收藏夹') return '「默认收藏夹」是 B站 自带夹，不能新建同名夹'
  if (findFolderByTitle(list, clean)) return `已经有同名收藏夹「${clean}」了`
  if (list.length >= FAV_FOLDER_LIMIT) return `B站 收藏夹最多 ${FAV_FOLDER_LIMIT} 个，已经满了`
  return null
}

/** 改名校验；返回 { folder, title } 或 { error }。 */
export function validateRenameFolder({ folders, from, to } = {}) {
  const list = Array.isArray(folders) ? folders.filter(Boolean) : []
  const oldTitle = normalizeFolderTitle(from)
  const nextTitle = normalizeFolderTitle(to)
  if (!oldTitle) return { error: '要给旧夹名（--rename "旧名"）' }
  if (!nextTitle) return { error: '要给新夹名（--to "新名"）' }

  const folder = findFolderByTitle(list, oldTitle)
  if (!folder) return { error: `找不到收藏夹「${oldTitle}」` }
  const def = pickDefaultFolder(list)
  if (def && String(def.id) === String(folder.id)) return { error: '「默认收藏夹」是 B站 自带夹，不能改名' }
  if (normalizeFolderTitle(folder.title) === nextTitle) return { error: '新旧夹名一样，不用改' }

  const invalid = validateNewFolderTitle({
    title: nextTitle,
    folders: list.filter((item) => String(item.id) !== String(folder.id)),
  })
  if (invalid) return { error: invalid }
  return { folder, title: nextTitle }
}

/**
 * 收藏时决定进哪个夹。
 *
 * 顺序（2026-11-13 主人定）：
 *   1. 显式 --folder：精确匹配；不存在时只有带 --create 才新建；
 *   2. 没给 --folder：有同名 kind 夹就进它；
 *   3. 都没有：进默认夹；
 *   4. 没有默认夹：报错（正常账号不会走到这里）。
 *
 * 返回 { folder, create, source } 或 { error }。
 * create=true 时 folder 是待建对象（id=null），由命令层创建后再换成真实夹。
 */
export function resolveFolderPlan({ folders, folder, kind, create = false } = {}) {
  const list = Array.isArray(folders) ? folders.filter(Boolean) : []
  const wanted = normalizeFolderTitle(folder)
  const kindTitle = normalizeFolderTitle(kind)

  if (wanted) {
    const existing = findFolderByTitle(list, wanted)
    if (existing) return { folder: existing, create: false, source: 'named' }
    if (!create) {
      return {
        error: `收藏夹「${wanted}」不存在。想新建就加 --create，或先 fav --mkdir "${wanted}" --dry / --go`,
      }
    }
    const invalid = validateNewFolderTitle({ title: wanted, folders: list })
    if (invalid) return { error: invalid }
    return { folder: { id: null, title: wanted }, create: true, source: 'create' }
  }

  if (kindTitle) {
    const byKind = findFolderByTitle(list, kindTitle)
    if (byKind) return { folder: byKind, create: false, source: 'kind' }
  }

  const def = pickDefaultFolder(list)
  if (!def) {
    return { error: '这个号还没有任何收藏夹（B站 正常会有一个「默认收藏夹」）；先在网页上收藏一次再来' }
  }
  return { folder: def, create: false, source: 'default' }
}

async function readJsonResponse(response) {
  try {
    return await response.json()
  } catch {
    throw new Error(`HTTP ${response.status} 返回不是 JSON`)
  }
}

function biliError(action, json) {
  const code = Number(json?.code)
  const hint = code === -111
    ? '（csrf 失效，重新登录一次）'
    : code === -101
      ? '（没登录 / 登录态失效）'
      : ''
  return `${action}失败：code=${json?.code ?? '?'} ${json?.message ?? ''}${hint}`
}

async function postForm(url, fields, { headers, fetchImpl = fetch } = {}) {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) body.set(key, String(value ?? ''))
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const json = await readJsonResponse(response)
  return { json, status: response.status }
}

/** 读当前账号的全部收藏夹（只读 GET）。 */
export async function fetchFolders({ mid, headers, fetchImpl = fetch } = {}) {
  const url = `${BILI_API}/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(String(mid ?? ''))}`
  const response = await fetchImpl(url, { headers })
  const json = await readJsonResponse(response)
  if (json?.code !== 0) throw new Error(biliError('读取收藏夹', json))
  return (Array.isArray(json?.data?.list) ? json.data.list : [])
    .filter((folder) => folder && folder.id != null)
}

/** 新建公开收藏夹；返回接口 data（命令层会再 list-all 一次拿准确 id）。 */
export async function createFolder({ title, headers, csrf, fetchImpl = fetch } = {}) {
  const clean = normalizeFolderTitle(title)
  const { json, status } = await postForm(`${BILI_API}/x/v3/fav/folder/add`, {
    title: clean,
    privacy: '0',
    csrf: String(csrf ?? ''),
  }, { headers, fetchImpl })
  if (json?.code !== 0) throw new Error(biliError('新建收藏夹', json))
  return { data: json?.data ?? null, status }
}

/** 改收藏夹名；privacy 固定传公开（新夹统一公开）。 */
export async function renameFolder({ mediaId, title, headers, csrf, fetchImpl = fetch } = {}) {
  const clean = normalizeFolderTitle(title)
  const { json, status } = await postForm(`${BILI_API}/x/v3/fav/folder/edit`, {
    media_id: String(mediaId ?? ''),
    title: clean,
    privacy: '0',
    csrf: String(csrf ?? ''),
  }, { headers, fetchImpl })
  if (json?.code !== 0) throw new Error(biliError('改收藏夹名', json))
  return { data: json?.data ?? null, status }
}

/** 把视频从一个夹移到另一个夹：同一个 resource/deal 请求里 add + del。 */
export async function moveVideoToFolder({ aid, fromFolderId, toFolderId, headers, csrf, fetchImpl = fetch } = {}) {
  const { json, status } = await postForm(`${BILI_API}/x/v3/fav/resource/deal`, {
    rid: String(aid ?? ''),
    type: '2',
    add_media_ids: String(toFolderId ?? ''),
    del_media_ids: String(fromFolderId ?? ''),
    csrf: String(csrf ?? ''),
  }, { headers, fetchImpl })
  if (json?.code !== 0) throw new Error(biliError('移动收藏', json))
  return { data: json?.data ?? null, status }
}

/** 从指定收藏夹删掉一个视频。 */
export async function removeVideoFromFolder({ aid, folderId, headers, csrf, fetchImpl = fetch } = {}) {
  const { json, status } = await postForm(`${BILI_API}/x/v3/fav/resource/deal`, {
    rid: String(aid ?? ''),
    type: '2',
    add_media_ids: '',
    del_media_ids: String(folderId ?? ''),
    csrf: String(csrf ?? ''),
  }, { headers, fetchImpl })
  if (json?.code !== 0) throw new Error(biliError('删除收藏', json))
  return { data: json?.data ?? null, status }
}

/** 把视频加进指定收藏夹。 */
export async function addVideoToFolder({ aid, folderId, headers, csrf, fetchImpl = fetch } = {}) {
  const { json, status } = await postForm(`${BILI_API}/x/v3/fav/resource/deal`, {
    rid: String(aid ?? ''),
    type: '2',
    add_media_ids: String(folderId ?? ''),
    del_media_ids: '',
    csrf: String(csrf ?? ''),
  }, { headers, fetchImpl })
  if (json?.code !== 0) throw new Error(biliError('收藏', json))
  return { data: json?.data ?? null, status }
}
