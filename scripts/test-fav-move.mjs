// 收藏夹移动/删除的请求契约（不碰 B站，只验 add/del 字段）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { moveVideoToFolder, removeVideoFromFolder } from '../plugins/surfcore/tools/lib/fav-folders.mjs'

function fakeFetch(code = 0) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: new URLSearchParams(init.body) })
    return { status: 200, json: async () => ({ code, message: code ? 'boom' : '0', data: {} }) }
  }
  return { calls, fetchImpl }
}

test('移动：同一请求 add 新夹 + del 旧夹', async () => {
  const { calls, fetchImpl } = fakeFetch()
  const out = await moveVideoToFolder({
    aid: 117483109488775, fromFolderId: 4558244443, toFolderId: 4560000001,
    headers: {}, csrf: 'csrf', fetchImpl,
  })
  assert.equal(out.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.get('rid'), '117483109488775')
  assert.equal(calls[0].body.get('type'), '2')
  assert.equal(calls[0].body.get('add_media_ids'), '4560000001')
  assert.equal(calls[0].body.get('del_media_ids'), '4558244443')
  assert.equal(calls[0].body.get('csrf'), 'csrf')
})

test('删除：只 del 旧夹，不 add', async () => {
  const { calls, fetchImpl } = fakeFetch()
  await removeVideoFromFolder({ aid: 1, folderId: 2, headers: {}, csrf: 'c', fetchImpl })
  assert.equal(calls[0].body.get('add_media_ids'), '')
  assert.equal(calls[0].body.get('del_media_ids'), '2')
})

test('接口报错会抛，不静默成功', async () => {
  const { fetchImpl } = fakeFetch(-111)
  await assert.rejects(() => moveVideoToFolder({
    aid: 1, fromFolderId: 2, toFolderId: 3, headers: {}, csrf: 'x', fetchImpl,
  }), /移动收藏失败/)
})
