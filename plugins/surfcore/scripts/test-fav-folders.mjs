/** 收藏夹选夹/建夹/改名规则回归（纯函数 + 请求体）。 */
import assert from 'node:assert/strict'
import {
  normalizeFolderTitle,
  folderTitleLength,
  pickDefaultFolder,
  findFolderByTitle,
  validateNewFolderTitle,
  validateRenameFolder,
  resolveFolderPlan,
  createFolder,
  addVideoToFolder,
} from '../tools/lib/fav-folders.mjs'

const folders = [
  { id: 1, title: '默认收藏夹', media_count: 3 },
  { id: 2, title: '想学', media_count: 0 },
  { id: 3, title: 'DSH 插件', media_count: 1 },
]

// 夹名清洗 / 长度
assert.equal(normalizeFolderTitle('  DSH   插件  '), 'DSH 插件')
assert.equal(normalizeFolderTitle(''), '')
assert.equal(folderTitleLength('一二三四五六七八九十一二三四五六七八九十'), 20)
assert.equal(folderTitleLength('🐟'), 1)

// 默认夹识别：精确优先，不把「默认收藏夹2」当默认
assert.equal(pickDefaultFolder(folders)?.id, 1)
assert.equal(pickDefaultFolder([{ id: 9, title: '默认收藏夹2' }, { id: 1, title: '默认收藏夹' }])?.id, 1)
assert.equal(pickDefaultFolder([]), null)

// 精确查找，不做模糊匹配
assert.equal(findFolderByTitle(folders, ' DSH   插件 ')?.id, 3)
assert.equal(findFolderByTitle(folders, 'dsh 插件'), null)
assert.equal(findFolderByTitle(folders, 'DSH'), null)

// 新建校验
assert.match(validateNewFolderTitle({ title: '', folders }), /不能为空/)
assert.match(validateNewFolderTitle({ title: '一二三四五六七八九十一二三四五六七八九十一', folders }), /最多 20 字/)
assert.match(validateNewFolderTitle({ title: '想学', folders }), /同名/)
assert.match(validateNewFolderTitle({ title: '默认收藏夹', folders }), /自带夹/)
assert.equal(validateNewFolderTitle({ title: '半夜想再看', folders }), null)
const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, title: `夹${i + 1}` }))
assert.match(validateNewFolderTitle({ title: '新夹', folders: full }), /最多 100 个/)

// 改名：默认夹不能改、重名、同名、找不到、正常
assert.match(validateRenameFolder({ folders, from: '默认收藏夹', to: 'x' }).error, /不能改名/)
assert.match(validateRenameFolder({ folders, from: '想学', to: 'DSH 插件' }).error, /同名/)
assert.match(validateRenameFolder({ folders, from: '想学', to: '想学' }).error, /一样/)
assert.match(validateRenameFolder({ folders, from: '不存在', to: 'x' }).error, /找不到/)
assert.equal(validateRenameFolder({ folders, from: '想学', to: '学习' }).title, '学习')

// 选夹顺序：显式 > kind 同名 > 默认；不存在时只有 create 才新建
assert.deepEqual(resolveFolderPlan({ folders, folder: 'DSH 插件' }), { folder: folders[2], create: false, source: 'named' })
assert.match(resolveFolderPlan({ folders, folder: '不存在' }).error, /不存在/)
assert.deepEqual(resolveFolderPlan({ folders, folder: '不存在', create: true }), {
  folder: { id: null, title: '不存在' },
  create: true,
  source: 'create',
})
assert.deepEqual(resolveFolderPlan({ folders, kind: '想学' }), { folder: folders[1], create: false, source: 'kind' })
assert.deepEqual(resolveFolderPlan({ folders, kind: '其他' }), { folder: folders[0], create: false, source: 'default' })
assert.match(resolveFolderPlan({ folders: [], kind: '想学' }).error, /还没有任何收藏夹/)

// 请求体：建夹公开、收藏走 resource/deal
{
  let seen = null
  const fakeFetch = async (url, init) => {
    seen = { url, init }
    return { status: 200, json: async () => ({ code: 0, data: { id: 77 } }) }
  }
  const result = await createFolder({
    title: '  新  夹  ',
    headers: { cookie: 'x' },
    csrf: 'csrf-token',
    fetchImpl: fakeFetch,
  })
  assert.equal(seen.url, 'https://api.bilibili.com/x/v3/fav/folder/add')
  assert.equal(seen.init.method, 'POST')
  const body = new URLSearchParams(seen.init.body)
  assert.equal(body.get('title'), '新 夹')
  assert.equal(body.get('privacy'), '0')
  assert.equal(body.get('csrf'), 'csrf-token')
  assert.equal(result.data.id, 77)
}

{
  let seen = null
  const fakeFetch = async (url, init) => {
    seen = { url, init }
    return { status: 200, json: async () => ({ code: 0, data: 0 }) }
  }
  await addVideoToFolder({
    aid: 123,
    folderId: 456,
    headers: { cookie: 'x' },
    csrf: 'csrf-token',
    fetchImpl: fakeFetch,
  })
  const body = new URLSearchParams(seen.init.body)
  assert.equal(seen.url, 'https://api.bilibili.com/x/v3/fav/resource/deal')
  assert.equal(body.get('rid'), '123')
  assert.equal(body.get('type'), '2')
  assert.equal(body.get('add_media_ids'), '456')
  assert.equal(body.get('del_media_ids'), '')
}

// csrf 失效要给可操作的提示
{
  const fakeFetch = async () => ({ status: 200, json: async () => ({ code: -111, message: 'csrf' }) })
  await assert.rejects(
    () => createFolder({ title: 'x', headers: {}, csrf: 'bad', fetchImpl: fakeFetch }),
    /csrf 失效/,
  )
}

console.log('fav folder tests OK')
