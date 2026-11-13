// 原创视频上传 —— 预留接口，当前未实现。
//
// 为什么先不做：
//   · 需要本地视频文件、封面、分区、分片上传、转码/审核，和动态/专栏不是一条管线；
//   · 她目前没有“生成视频”的能力，上传下载来的视频还涉及版权；
//   · 用户 2026-11-12 明确：视频先不做，但留接口。
//
// 以后要接的位置（已核对可用端点，2026-11）：
//   1) GET  https://member.bilibili.com/preupload?name=...&size=...&r=upos&profile=ugcfx/bup
//   2) 按返回的 chunk_size 分片 PUT 上传
//   3) POST https://member.bilibili.com/x/vu/web/add/v3?csrf=...（标题/简介/分区/标签/封面/版权）
//   4) 发布后走 notify + appendBiliPost({type:'video', bvid, cover, summary, text})，让记忆卡/B站 brief 记住
//
// 安全约定与 free-post/article 相同：--dry 先看、--go 才发、interact 守卫、身份闸、
// 30 分钟间隔、notify 报备、bili-posts.jsonl 记忆同步。
console.error([
  '原创视频上传尚未实现（预留接口）。',
  '当前可用：',
  '  · free-post --bvid BV...  分享/转发任意视频卡片（配她自己的话）',
  '  · article ...             发布原创专栏',
  '以后接视频上传时，从 commands/video-upload.mjs 的注释端点开始。',
].join('\n'))
process.exit(2)
