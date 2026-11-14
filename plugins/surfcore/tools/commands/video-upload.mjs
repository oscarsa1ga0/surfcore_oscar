// 原创视频投稿 —— 阶段三接线（方案 §7）。
//
// 阶段一/二只做本地创作与导出：先走 video-project（见 tools/commands/video-project.mjs）。
// 这里保留入口名；接投稿时从这里开始：
//   1) 本地投稿预检（--dry：包摘要/风险检查/当前授权模式，不上传任何字节）
//   2) --draft 保存本地待投稿包；--go 按 publishMode（draft/confirm/auto）流转
//   3) 网页上传适配器：preupload → 分片 PUT → 合片 → 封面 → add/v3 → 创作中心回读
// 已核对可用端点（2026-11）：见插件 docs 与方案 §7。
console.error([
  '原创视频投稿在阶段三开放。',
  '当前（阶段一）可用：',
  '  · video-project create/save/render/status/preview  本地创作、出片、试听与导出',
  '  · 导出后在 B 站官方创作中心手动提交',
].join('\n'))
process.exit(2)
