// 网页私聊安全边界：隐藏 QQ 桥接工具（网页是独立渠道，不能从页面操作 QQ）。
// 引用方式同 qq-tool-restrict：preset 子行写 surfcore/web-tool-guard.mjs，由 profile 的 link: 依赖解析。
export const name = 'web-tool-guard'

export const inject = ['tools']

export const QQ_TOOL_NAMES = [
  'mcp__snowluma-host__snowluma_status',
  'mcp__snowluma__qq_close_conversation', 'mcp__snowluma__qq_collect_sticker',
  'mcp__snowluma__qq_get_context_snapshot', 'mcp__snowluma__qq_get_forward_msg',
  'mcp__snowluma__qq_get_group_history', 'mcp__snowluma__qq_get_group_members',
  'mcp__snowluma__qq_get_message_detail', 'mcp__snowluma__qq_get_message_images',
  'mcp__snowluma__qq_get_prompt', 'mcp__snowluma__qq_get_self_image', 'mcp__snowluma__qq_get_sticker_image',
  'mcp__snowluma__qq_list_groups', 'mcp__snowluma__qq_list_stickers', 'mcp__snowluma__qq_list_voices',
  'mcp__snowluma__qq_mark_read', 'mcp__snowluma__qq_memory_append', 'mcp__snowluma__qq_memory_clear',
  'mcp__snowluma__qq_memory_query', 'mcp__snowluma__qq_memory_remove', 'mcp__snowluma__qq_qzone_comment',
  'mcp__snowluma__qq_qzone_delete', 'mcp__snowluma__qq_qzone_feeds', 'mcp__snowluma__qq_qzone_like',
  'mcp__snowluma__qq_qzone_post_detail', 'mcp__snowluma__qq_qzone_posts', 'mcp__snowluma__qq_qzone_publish',
  'mcp__snowluma__qq_qzone_set_right', 'mcp__snowluma__qq_qzone_state', 'mcp__snowluma__qq_read',
  'mcp__snowluma__qq_reply', 'mcp__snowluma__qq_reply_and_finish', 'mcp__snowluma__qq_report_feedback',
  'mcp__snowluma__qq_send_burst', 'mcp__snowluma__qq_send_group_message', 'mcp__snowluma__qq_send_message',
  'mcp__snowluma__qq_send_poke', 'mcp__snowluma__qq_send_private_message', 'mcp__snowluma__qq_send_sticker',
  'mcp__snowluma__qq_send_voice', 'mcp__snowluma__qq_set_sticker_remark', 'mcp__snowluma__qq_set_wake_config',
  'mcp__snowluma__qq_slang_query', 'mcp__snowluma__qq_slang_submit', 'mcp__snowluma__qq_status',
  'mcp__snowluma__qq_sticker_note', 'mcp__snowluma__qq_wait_for_messages',
]

export const BLOCKED_PREFIXES = ['mcp__snowluma']

export function apply(ctx) {
  const hidden = new Set()
  function hideKnown() {
    for (const name of QQ_TOOL_NAMES) {
      if (hidden.has(name)) continue
      hidden.add(name)
      try { ctx.tools.restrict({ deny: [name] }) }
      catch { hidden.delete(name) }
    }
  }
  hideKnown()
  ctx.on?.('tools/change', () => { try { hideKnown() } catch {} })
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    if (BLOCKED_PREFIXES.some((prefix) => name.startsWith(prefix))) return `网页私聊不接 QQ，工具 "${name}" 已停用`
    return undefined
  })
}
