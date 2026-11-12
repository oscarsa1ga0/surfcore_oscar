// 日记会话的工具边界。
//
// 目标：日记会话只应该有 人格 / 日记工具 / 安全搜索。
//   · 本地执行、文件、派生 agent、插件管理、调度类工具：从 schema 隐藏（restrict）；
//   · QQ/微信等发送工具：执行期拒绝（guard），避免“写完日记顺手告诉主人”。
//
// 守卫名单复用 qq-tool-restrict 的唯一一份 RESTRICTED_TOOL_NAMES，避免两处漂移。
import { RESTRICTED_TOOL_NAMES } from './qq-tool-restrict.mjs'

export const name = 'diary-tool-guard'

export const inject = ['tools']

export function apply(ctx) {
  const restricted = new Set()
  function restrictAvailable() {
    for (const tool of RESTRICTED_TOOL_NAMES) {
      if (restricted.has(tool)) continue
      restricted.add(tool)
      try {
        ctx.tools.restrict({ deny: [tool] })
      } catch {
        // 当前 DSH 版本没有这个工具名：跳过，执行期白名单仍然兜底。
        restricted.delete(tool)
      }
    }
  }
  restrictAvailable()
  ctx.on?.('tools/change', () => {
    try { restrictAvailable() } catch {}
  })

  ctx.tools.guard((exec) => {
    const tool = exec?.name
    if (typeof tool !== 'string' || tool.length === 0) return '工具名无效，已拒绝'
    if (tool.startsWith('diary_')) return
    if (tool === 'ask_user_question' || tool === 'todo_write') return
    if (tool.startsWith('mcp__web-search-safe__')) return
    return `日记会话不允许调用工具 "${tool}"（只能使用日记工具与安全搜索）`
  })
}
