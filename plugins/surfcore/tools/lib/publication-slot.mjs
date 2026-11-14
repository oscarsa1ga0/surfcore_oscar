// Account-wide lock shared by scheduled dynamics, shares, articles and video submission.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { accountBili } from './state-paths.mjs'
import { lastDynamicAt, readShareState } from './share-dynamic.mjs'

function busy() {
  return Object.assign(new Error('这个 B 站账号正在处理另一条稿件'), {
    code: 'VIDEO_PUBLISH_BUSY', hint: '等当前投递完成后刷新', retryable: true,
  })
}

export function acquirePublicationLock(mid, kind = 'public-write') {
  const key = kind === 'public-write' ? 'fish' : /^\d+$/.test(String(mid)) ? mid : 'legacy'
  const dir = accountBili('publication-slots')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${key}-${kind}.lock`)
  const temp = `${file}-${randomUUID()}.tmp`
  const token = JSON.stringify({ pid: process.pid, nonce: randomUUID() })
  fs.writeFileSync(temp, token, { mode: 0o600, flag: 'wx' })
  try {
    try { fs.linkSync(temp, file) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      let previous
      try { previous = fs.readFileSync(file, 'utf8') } catch { throw busy() }
      let owner
      try { owner = JSON.parse(previous) } catch { throw busy() }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw busy()
      try { process.kill(owner.pid, 0); throw busy() }
      catch (e) { if (e.code !== 'ESRCH') throw busy() }
      // Serialize reclaimers using a lock on the abandoned inode's immutable owner token.
      const reclaim = `${file}-reclaim-${owner.nonce}`
      if (!/^[a-f0-9-]{36}$/.test(owner.nonce)) throw busy()
      try { fs.linkSync(temp, reclaim) }
      catch (e) {
        if (e.code !== 'EEXIST') throw busy()
        let orphan
        try { orphan = JSON.parse(fs.readFileSync(reclaim, 'utf8')) } catch { throw busy() }
        if (Number.isInteger(orphan.pid) && orphan.pid > 0) {
          try { process.kill(orphan.pid, 0) }
          catch (error) {
            if (error.code === 'ESRCH' && fs.readFileSync(reclaim, 'utf8') === JSON.stringify(orphan)) {
              fs.rmSync(reclaim, { force: true })
            }
          }
        }
        throw busy()
      }
      try {
        if (fs.readFileSync(file, 'utf8') !== previous) throw busy()
        fs.unlinkSync(file)
        try { fs.linkSync(temp, file) } catch (e) { if (e.code === 'EEXIST') throw busy(); throw e }
      } finally { fs.rmSync(reclaim, { force: true }) }
    }
  } finally { fs.rmSync(temp, { force: true }) }
  return () => {
    try { if (fs.readFileSync(file, 'utf8') === token) fs.unlinkSync(file) } catch {}
  }
}

export function readPublicationMid(configuredMid) {
  if (configuredMid) return String(configuredMid)
  try { return String(JSON.parse(fs.readFileSync(accountBili('credentials.json'), 'utf8')).mid ?? '') }
  catch { return '' }
}

export function reservePublicationSlot(mid, stateFile, gapMin, now = Date.now()) {
  const release = acquirePublicationLock(mid)
  const key = /^\d+$/.test(String(mid)) ? mid : 'legacy'
  const ledger = accountBili('publication-slots', `${key}-last.json`)
  try {
    let prior = 0
    try { prior = Number(JSON.parse(fs.readFileSync(ledger, 'utf8')).at) || 0 }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const until = Math.max(prior, lastDynamicAt(readShareState(stateFile))) + gapMin * 60_000
    if (until > now) {
      throw Object.assign(new Error(`公共发布间隔还差 ${Math.ceil((until - now) / 60_000)} 分钟`), {
        code: 'VIDEO_PUBLISH_COOLDOWN', hint: '到期后会继续，已有成片与上传进度会保留',
        retryable: true, retryAfterMs: until - now,
      })
    }
  } catch (error) { release(); throw error }
  return {
    release,
    record() {
      const tmp = `${ledger}-${randomUUID()}.tmp`
      try {
        fs.writeFileSync(tmp, JSON.stringify({ at: Date.now() }), { mode: 0o600, flag: 'wx' })
        fs.renameSync(tmp, ledger)
      } finally { fs.rmSync(tmp, { force: true }) }
    },
  }
}

export function acquireLegacyPublicationSlot(mid, stateFile, gapMin) {
  try {
    const slot = reservePublicationSlot(mid, stateFile, gapMin)
    process.once('exit', slot.release)
    return slot
  } catch (error) {
    console.error(`✗ ${error.message}`)
    process.exit(3)
  }
}

export function recordLegacyPublication(slot) {
  try { slot.record() }
  catch { console.error('⚠️ 已发布，但共享间隔账本写入失败，请检查账号状态目录') }
  finally { slot.release() }
}
