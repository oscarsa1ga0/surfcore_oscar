# QQ 空间「回复评论」变成一级评论（楼中楼失效）

## 现象

- 用户原话：「肥鱼QQ空间在她的帖子下回复我的时候，没有选我的评论回复，而是直接在她的帖子评论，这是正常的还是bug」
- 空间详情：用户的评论 `comment_id=1` 的 `replies` 为空，鱼姬的评论是并列的 `comment_id=2`。
- 影响面：只影响 QQ 空间楼中楼；评论本身能发出去，不丢数据，事后可删。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS / DSH desktop（2026-11-14） |
| SurfCore 版本 | feat/macos-qq 分支 |
| 安装方式 | git 工作副本 |
| 网关 | NapCat 4.18.42（Docker，`mlikiowa/napcat-docker`），SnowLuma 参数格式 |

## 根因

- 代码位置：
  - `src/qzone-api.js:192` 旧版把 `comment`（父评论对象）和 `reply_user` 一起下发给 NapCat；
  - `src/bridge.js:9487` 旧版在只给 `commentId` 时会自动构造 `comment` 对象补上；
  - `src/mcp-snowluma-safe.js:1664` 工具说明也教模型传 `comment`。
- 问题链条：
  1. NapCat 4.18.42 的 `comment_qzone` 在 `tid` 模式下只接受 `tid/target_uin/content/images/comment_id/comment_uin/reply_uin/reply_name`；
     `comment`、`reply_user` 属于 `feed_ref` 旧格式，混用会被参数校验直接拒绝（retcode 400「当前QQ空间调用不支持 comment 参数」）。
  2. 桥接在收到 `commentId` 后一定会补 `comment` → 楼中楼请求 100% 被拒。
  3. 08:55 那次实际调用没带 `commentId`（只带 tid/content/targetUin），所以生成了一级评论；11:03 重试仍然没带 `commentId`，于是「成功」但也只是一级评论。
- 为什么之前没发现：只验证了「评论能发出去」（返回 ok + 详情里有内容），没断言 `replies` 里有这条回复。

补充：`-10052` 是另一次误传 `targetUin=评论人` 导致；桥接现在对自己的说说会自动清空 `targetUin`（`src/bridge.js:9480`）。

## 完整逻辑（给用户看的那一遍）

- **链路**：模型 → MCP `qq_qzone_comment`（`src/mcp-snowluma-safe.js`）→ 桥接 `POST /api/socialV2/qzone/comment`（`src/bridge.js`）→ `commentQzone()`（`src/qzone-api.js`）→ NapCat HTTP `comment_qzone` → QQ 空间。
- **机制**：空间用 `comment_id`+`comment_uin` 判断这是「回复某条评论」，缺一个就按一级评论处理；NapCat 再把 `reply_uin/reply_name` 变成正文前缀 `@{uin:...,nick:...}`。桥接把旧格式 `comment` 混进 SnowLuma 参数，等于让网关在参数校验阶段就把请求打回。
- **爆炸半径**：1 个进程（bridge）× 2 个读者（桥接路由、MCP 工具）× 报错=1 → 3 分；不碰密钥、不花钱，只影响空间评论结构。
- **取舍**：
  - A. 保留 `comment` 并让网关兼容（要改 Docker 里的 NapCat，升级即失效）——否。
  - B. 桥接只发 SnowLuma 参数（`comment_id`+`comment_uin`，可选 `reply_uin`/`reply_name`），父评论作者缺失时从详情补——选 B，改动最小且不依赖网关内部实现。
- **生效与重启**：改的是桥接进程代码，必须重启 `src/bridge.js`；MCP 工具描述要在 MCP server 重新拉起后才更新（不影响功能）。

## 修法

- `src/qzone-api.js`：不再下发 `comment` / `reply_user`；`commentId` 必须与 `commentUin` 成对，否则返回可读的 400；`replyUser` 映射成 `reply_uin`/`reply_name`。
- `src/bridge.js`：只补 `commentUin`（查详情取父评论作者），不再构造 `comment` 对象。
- `src/mcp-snowluma-safe.js`：工具说明改为「commentId 必填，commentUin 可省；comment 已废弃；replyUser 只在要 @ 时给」。
- 回滚：`git checkout -- src/qzone-api.js src/bridge.js src/mcp-snowluma-safe.js` 并重启桥接。

## 验证

- 自动化：`node scripts/test-audit.mjs`（150/157，失败项均为原有 Windows/工作区哈希类）、`node scripts/test-audit-regressions.mjs`（全部通过）。
- 网关参数探针（不存在的 tid）：带 `comment` → 400「当前QQ空间调用不支持 comment 参数」；只带 `comment_id`+`comment_uin` → 通过参数校验（-10049 表示 tid 不存在）。
- 端到端（临时「仅自己可见」测试说说，验证后已删除）：
  - 一级评论 `comment_id=1`；`commentQzone({commentId:'1', commentUin:'<自己>'})` → `{"ok":true,"commentId":"2","raw":{"parent_comment_id":"1"}}`；
  - 详情 `comments[0].replies` 依次出现 `自检楼中楼回复`、`…·走桥接函数`、`…·走桥接路由`，`parent_comment_id` 均为 1；
  - 走真实桥接路由（`x-console-token`）返回 `{"ok":true,"commentId":"3"}`，同样落在 `replies` 里。
- 没验证到的部分：不同可见性（仅自己/部分好友/公开）下 QQ 是否都允许楼中楼；图片评论（NapCat 明确不支持楼中楼带图）。

## 遗留 / 后续

- 一级评论的响应 `comment_id` 常为空，模型若想稍后回复自己这条评论，需要先查详情拿 id——可在桥接里补一次详情回读。
- 建议给 `comment_qzone` 加一条回归断言：回复后详情 `replies` 非空，而不是只看 `ok`。
