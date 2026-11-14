#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readBiliConfig } from '../../lib/store.js'
import { openVideoStore } from '../../lib/video/project-store.js'
import { requireVideoRoot } from '../../lib/video/paths.js'
import { requestPublication, safePublish, refreshPublication, PROJECT_ID } from '../../lib/video/publish-state.js'

const usage = 'video-upload <项目ID> --revision <版本> --dry|--draft|--go [--json]\nvideo-upload status <项目ID> [--refresh] [--json]'
let store
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    revision: { type: 'string' }, dry: { type: 'boolean' }, draft: { type: 'boolean' }, go: { type: 'boolean' },
    refresh: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log(usage)
  } else {
    const isStatus = positionals[0] === 'status'
    const projectId = positionals[isStatus ? 1 : 0]
    const actions = ['dry', 'draft', 'go'].filter((kind) => values[kind])
    const revision = Number(values.revision)
    if (!PROJECT_ID.test(projectId ?? '') || positionals.length !== (isStatus ? 2 : 1)
      || (isStatus ? actions.length || values.revision != null : actions.length !== 1 || !Number.isInteger(revision) || revision < 1 || values.refresh)) {
      throw Object.assign(new Error('缺少项目、版本或动作，或提供了冲突的参数'), { code: 'VIDEO_PUBLISH_USAGE' })
    }
    const { root } = requireVideoRoot()
    store = openVideoStore(root)
    const cfg = readBiliConfig().config
    if (isStatus && !store.getProject(projectId)) throw Object.assign(new Error('视频项目不存在'), { code: 'VIDEO_PROJECT_NOT_FOUND' })
    const ctx = { store, root, projectId, revision, cfg }
    const result = isStatus
      ? { ok: true, ...(values.refresh ? refreshPublication(ctx) : {}), publishes: store.listPublishes(projectId).map(safePublish) }
      : await requestPublication(ctx, actions[0])
    if (values.json) console.log(JSON.stringify(result))
    else console.log(JSON.stringify(result, null, 2))
  }
} catch (error) {
  const result = { ok: false, code: error.code?.startsWith('VIDEO_') ? error.code : 'VIDEO_PUBLISH_FAILED',
    error: error.code?.startsWith('VIDEO_') ? error.message : '无法处理视频投稿请求',
    hint: error.hint ?? usage }
  console.error(JSON.stringify(result))
  process.exitCode = 1
} finally {
  store?.close()
}
