import { currentCharacter } from './state-paths.mjs'
import { enqueueEmotionEvent } from '../../../../src/emotion-events.js'

export function recordBiliEmotion(kind, key, role = currentCharacter(), at = Date.now()) {
  return enqueueEmotionEvent({ source: 'bili', kind, key, at }, role, (error) => {
    console.error(`[emotion] 无法记录 B 站事件：${error?.code || error?.name || 'unknown'}`)
  })
}

/** One recommendation batch per half hour, shared by the ordinary and themed feeds. */
export function recordBiliBrowse(items, role, at = Date.now()) {
  if (!items.length) return false
  return recordBiliEmotion('browse', `browse:${Math.floor(at / (30 * 60 * 1000))}`, role, at)
}
