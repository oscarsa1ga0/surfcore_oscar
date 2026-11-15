import { currentCharacter } from './state-paths.mjs'
import { enqueueEmotionEvent } from '../../../../src/emotion-events.js'

export function recordBiliEmotion(kind, key, role = currentCharacter()) {
  return enqueueEmotionEvent({ source: 'bili', kind, key }, role, (error) => {
    console.error(`[emotion] 无法记录 B 站事件：${error?.code || error?.name || 'unknown'}`)
  })
}
