# B 站唤醒看不到「最近写过什么日记」

## 现象

- 用户原话：「b站端她怎么不知道我的语音包训好了，她已经能说话了，怎么回事？」
- 2026-11-14 12:50 QQ 侧首条语音发送成功；18:00 B 站这一轮醒来后仍然说「语音包还在你那边训…等真出声那天写」。
- 影响面：B 站侧的自我认知会落后于事实；不丢数据、不对外发送，但会写出与事实相反的动态/私信。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS / DSH desktop（2026-11-14） |
| SurfCore 版本 | feat/macos-qq 分支 |
| 安装方式 | git 工作副本 |

## 根因

- 代码位置：`plugins/surfcore/lib/scheduler.js` 的 `identityContextLines()`（B 站唤醒上下文拼装）。
- 问题链条：
  1. B 站唤醒上下文只有：人格卡 → 自我锚点 → 管理员 → 对齐 → QQ 记忆 → QQ 最后私聊摘要 → B 站记忆卡。
  2. 日记只以「任务第 2 步：去读两本冲浪日记」的形式出现，是**指令**不是**事实**；读不读取决于她这一轮执行。
  3. QQ 侧有 `diaryPromptLineV2`（`src/bridge.js`）注入「【日记】你最近写过：今天《…》（id，私人）」，B 站侧没有对应的一行。
  4. 于是「今天已经开口说过话」只存在于共享日记 `d-20261114-001` 里，没有进入 B 站上下文；她按旧印象推理成「还在训」。
- 为什么之前没发现：B 站提示里确实提了「读日记」，看起来像已经覆盖；但读文件和注入事实是两件事。

## 完整逻辑（给用户看的那一遍）

- **链路**：DSH 插件宿主（`plugins/surfcore/lib/index.js`）启动 `scheduler.js` → 到点 `wakePrompt()` → `identityContextLines()` 拼上下文 → `ctx.sessionController.prompt()` 塞进 `bili-whale-*` 会话。
- **机制**：B 站会话是长会话，跨天保留上下文；新事实只能靠「注入」或「她主动读」进入。注入侧缺了日记这一块，主动读又依赖模型执行，于是出现事实盲区。
- **爆炸半径**：1 个插件进程 × 1 个读者（B 站唤醒）× 静默=3 → 3 分；不碰密钥、不花钱。
- **取舍**：
  - A. 把整篇日记正文注入 → 上下文变大、隐私面变大，否。
  - B. 只注入最近 3 篇的日期/标题/可见性/id（与 QQ 侧一致），正文仍走 `diary_read` —— 选 B。
- **生效与重启**：`scheduler.js` 由 DSH 插件宿主在启动时 import，改完需要**重启 DSH**（或重载插件）才生效；只重启 QQ 桥接不够。

## 修法

- `plugins/surfcore/lib/scheduler.js`：新增 `diaryLineForBili()`（复用 `src/diary-store.js` 的 `listEntries` + `readCurrentCharacter`），在 `identityContextLines()` 里排在 QQ 摘要之后、记忆卡之前。
- 只输出标题级信息（日期 / 标题 / 可见性 / id），并附一句「要回顾就用 diary_list / diary_search 找、diary_read 读」；正文仍走 `diary_read`。
- 回滚：删掉 `diaryLineForBili()` 与那一行调用即可。

## 验证

- 单测/脚本：`node plugins/surfcore/scripts/test-admin-bili-prompt.mjs` 通过；`npm run test:audit` 通过（150/157，失败项为原有环境问题）。
- 预览（用真实角色数据跑同一段逻辑）：
  `今天《第一次开口，也第一次自己按了发送》(d-20261114-001,私人)；昨天《输了一个赌，还把自己的话记到了别人名下》(d-20261113-001,私人)；11-12《第一天自己逛 B 站，晚上被自己的套话抓了个现行》(d-20261112-001,私人)`
- 没验证到的部分：DSH 重启后真实唤醒 prompt 里的实际位置与长度（需要在下一轮 B 站唤醒后看 plugin.log / 会话）。

## 遗留 / 后续

- 需要重启 DSH 才生效。
- 语音能力状态（【能力状态】行）按用户要求**这次没加**，只加了日记行。
