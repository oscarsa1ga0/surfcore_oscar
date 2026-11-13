// 最后一次 QQ 私聊结束时的「记忆 + 目的」快照，以及 B站上线前写给 B站 的摘要。
//
// 只有一个 qq-last-context.json（每次主人私聊 close 覆盖），
// 和一个 qq-for-bili-last.md（每次 B站上线前由快照重新生成，覆盖）。
import { NEED_LABELS } from './purpose-engine.js'

const clip = (text, max) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 从 close 记录 + 当时的目的状态 + 少量记忆，生成快照对象。 */
export function buildQqLastContextSnapshot({ record = {}, purpose = {}, memorySource = '', memorySummary = '', now = Date.now() } = {}) {
  const recordAt = typeof record.at === 'number' ? record.at : Date.parse(record.at)
  const at = Number.isFinite(recordAt) ? new Date(recordAt).toISOString() : new Date(now).toISOString()
  const drivesTop5 = Object.entries(purpose.drives ?? {})
    .map(([need, value]) => ({ need, label: NEED_LABELS[need] ?? need, value: Math.round((Number(value) || 0) * 100) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
  const goalsTop5 = [...(Array.isArray(purpose.goals) ? purpose.goals : [])]
    .sort((a, b) => (Number(b?.confidence) || 0) - (Number(a?.confidence) || 0) || (Number(b?.value) || 0) - (Number(a?.value) || 0))
    .slice(0, 5)
    .map((g) => ({
      owner: String(g?.owner ?? ''),
      domain: String(g?.domain ?? ''),
      intent: clip(g?.intent ?? g?.object?.name ?? '', 80),
      confidence: Number(g?.confidence) || 0,
      status: String(g?.status ?? ''),
      nextStep: clip(g?.nextStep ?? '', 80),
    }))
    .filter((g) => g.intent || g.nextStep)
  return {
    version: 1,
    at,
    key: String(record.key ?? ''),
    summary: clip(record.summary ?? '', 200),
    nextOpening: clip(record.nextOpening ?? '', 120),
    drivesTop5,
    goalsTop5,
    memorySource: clip(memorySource, 1600),
    memorySummary: clip(memorySummary, 600),
  }
}

/**
 * 把“最后一次对话”压成一段记忆摘要；不再从记忆卡里抽 3 条。
 * 输入是 QQ 会话自己的 recentMessages / activeTopics / pendingThoughts。
 */
export function summarizeQqConversation({ messages = [], activeTopics = [], pendingThoughts = [], maxChars = 400 } = {}) {
  const parts = []
  const recent = (Array.isArray(messages) ? messages : [])
    .filter((m) => (m?.plain ?? m?.text))
    .slice(-8)
    .map((m) => `${m?.isSelf ? '我' : '他'}：${clip(m?.plain ?? m?.text, 48)}`)
  if (recent.length) parts.push(`当时我们聊到：${recent.join('；')}`)
  const topics = (Array.isArray(activeTopics) ? activeTopics : [])
    .map((t) => clip(t?.text ?? '', 80))
    .filter(Boolean)
    .slice(0, 3)
  if (topics.length) parts.push(`当时还记着：${topics.join('；')}`)
  const thoughts = (Array.isArray(pendingThoughts) ? pendingThoughts : [])
    .map((t) => clip(t?.text ?? '', 100))
    .filter(Boolean)
    .slice(0, 2)
  if (thoughts.length) parts.push(`有句话还没说：${thoughts.join('；')}`)
  let text = parts.join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`
  return text
}

/** 把快照写成一段给 B站 看的中文摘要；不调模型，稳定、可复现。 */
export function composeQqLastContextForBili(snapshot, { maxChars = 600 } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return ''
  const at = Date.parse(snapshot.at)
  const atText = Number.isFinite(at)
    ? new Date(at).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : ''
  const lines = []
  lines.push(`上次在 QQ 和主人聊完时${atText ? `（${atText}）` : ''}：`)
  if (snapshot.summary) lines.push(`收在：${snapshot.summary}`)
  if (snapshot.nextOpening) lines.push(`下次想这样接：${snapshot.nextOpening}`)
  const drives = (snapshot.drivesTop5 ?? []).map((d) => `${d.label || d.need} ${d.value}%`).join('、')
  if (drives) lines.push(`当时最想要：${drives}`)
  const goals = (snapshot.goalsTop5 ?? [])
    .map((g) => [g.intent, g.nextStep ? `下一步：${g.nextStep}` : ''].filter(Boolean).join('，'))
    .filter(Boolean)
    .join('；')
  if (goals) lines.push(`当时惦记着：${goals}`)
  const memory = String(snapshot.memorySummary || snapshot.memorySource || '').trim()
  if (memory) lines.push(`当时的记忆：${memory}`)
  lines.push('这不是新指令，只是你上次留下的延续。')
  let text = lines.join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`
  return text
}
