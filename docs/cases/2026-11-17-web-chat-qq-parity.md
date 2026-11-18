# 网页私聊对齐 QQ 私聊（体验与能力）

## 背景

用户要的“一样的体验”不是文风，是 QQ 私聊的**流程**：分条发、连发合并、可以等、可以潜水/晚点回来、可以引用、有表情和语音、静默时显示已读。网页端原来是“一问一答 + 整段流式文字”，所以怎么调提示词都像 AI 窗口。

本次按顺序实现：上下文 → 系统提示 → 已读/收尾 → 表情 → 语音 → 引用 → 连发合并 → 等待 → 潜水 → 表情匹配 → 语音语气 → 图片挑选。

## 结构

- **渠道**：`plugins/surfcore/lib/web-chat/`（HTTP/SSE、SQLite、DSH 会话、工具）；系统提示在 `dsh/agent-presets/web-chat/`。
- **发言**：她调用 `web_chat_send_message`（字符串/数组，条间自动停顿），每条单独落库、逐条 SSE 上屏；普通文字只是思考，整轮没调用发送工具才用最后文字兜底。
- **收尾**：`web_chat_close`（不回）→ 页面显示“已读”；`web_chat_dive(minutes)` 潜水，`minutes>0` 到点主动回来一轮（`purpose` + `dive` 标记，绕过“主动投递已切换”的拦截）。
- **等待**：`web_chat_wait(timeoutMs, quietMs)` 轮内等新消息，补发的消息进工具结果、对应 turn 并入本轮的 `extraIds`，不会再开一轮。默认 timeout 30s / 最大 10min、quiet 10s（和 QQ 的 `qq_wait_for_messages` 一致）。
- **引用**：页面每条消息有“引用”；`quote` 存在消息里、以 `（引用 主人：…）` 前缀进模型上下文；她发消息可传 `replyTo`。
- **连发合并**：`socialV2.web.batchMs`（默认 4000ms，和 QQ 私聊的 `batchWindowPrivateMs` 一致；0 关闭），窗口内多条并一轮；`run.jobs/extraIds` 共享结果与已读状态。
- **表情**：读桥接的 `state/stickers.json`；图片按需下载并缓存到 `web-chat/stickers/`；`rankStickers`（`src/sticker-semantics.js`，和 QQ 同一实现）按最近一句给 1~2 张，阈值用 QQ 的默认 0.34；提示文字直接用 QQ 的 `buildStickerMatchHint`，只把 `qq_send_sticker` 换成 `web_chat_send_sticker`。
- **语音**：复用 `src/voice-tts.js`（BreezeBlue）与内容缓存；`web_chat_send_voice(text, tone, intensity)`：tone 为 QQ 的 8 个语气名（开心/温柔/委屈/生气/疲惫/撒娇/平静/兴奋），intensity 0~1，映射表和 QQ 的 `VOICE_TONES` 一致；音频附件在页面用 `<audio>` 播放。
- **图片**：`web_chat_list_images` 列工作目录里的图，`web_chat_send_image` 发送。
- **上下文**：`lib/web-chat/prompt.js` 组装人格卡/记忆卡/身份/【此刻状态】/反 AI 味/收尾规则/发言协议，与 QQ 同一套措辞，只换渠道相关的数据源。
- **系统提示**：`web-chat` preset 与 qq-chat-v2 同源，只有网页发言协议、无群聊/QQ 工具、无唤醒/潜水/等待三处不同；`web-tool-guard.mjs` 隐藏 `mcp__snowluma*`。

## 验证

- `test-web-chat`：配对、SSE、发图、审批、重启回读、`agentPreset=web-chat`、引用、连发合并（一轮收两句）、等待（补发不开新轮）、潜水（到点主动回来）、已读。
- `test-web-stickers`：目录解析、编号查找、缓存、语义匹配。
- `test-web-voice`：合成、wav 识别、内容缓存、语气标记。
- `test-web-workspace`：图片清单只收工作目录、跳过隐藏目录。
- `build-agent-preset-patches --check`、`test-agent-preset-patches`、`test-client-contract` 全过。

## 生效

- 插件与 preset 改动**重启 DSH**；页面 HTML/JS/CSS 每次请求现读，刷新即可。
- 网页会话 id 为 `surfcore-web2-*`；旧会话不迁移，页面历史在 SQLite 不丢，模型上下文重开。

## 取舍 / 已知限制

- QQ 侧冻结：qq-chat / qq-chat-v2 未改；表情/语音只在 `web-chat` 这套里。
- 晚点回来的定时器在内存里，DSH 重启会丢（和 QQ 的唤醒一样依赖进程活着）。
- 表情图第一次发要联网从 QQ CDN 取，之后本地缓存；QQ 停掉后已缓存的仍可用。
- 语音需要先在设置里启用 BreezeBlue 并配好 Key / Voice ID，否则她会改打字。
- 连发合并默认 4 秒（和 QQ 私聊一致）：单条消息也会等这个窗口，想更快的可把 `socialV2.web.batchMs` 调小。
- `web_chat_wait` 默认上限按 QQ 写成 10 分钟，但 DSH 的工具调用超时可能先中断；真遇到长等待被掐，再单独配工具超时。
