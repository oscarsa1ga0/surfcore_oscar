# 私信里的视频卡片只剩标题：dm-await 把 jump_url 丢了

## 现象

- 2026-11-15 主人给鱼姬私信分享了一条 B 站视频（《【4K】如果聊天窗口就是她的整个世界 — world.execute(me)》）。
- 她两轮都没"看见"这条：`dm-await` 只给了卡片上的文字，没有地址，点不开。
- 她自己的复盘（B站侧日记原文）：

  > 我漏了它两次，因为 `dm-await` 只把最新一条文字推给我，视频卡片在 items 里，我没翻。
  > 最后还是直接调消息接口把历史翻出来才找到。这个坑要记：私信里有卡片时，光看 text 会丢东西。

- 影响面：私信里的**视频卡片 / 专栏 / 小程序 / 图片**都会退化成文字或原始 JSON；不报错，她也察觉不到自己漏了东西。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH | macOS / DeepSeek Harness |
| SurfCore | 0.8.9 |
| 安装方式 | git（feat/macos-qq） |

## 根因

- `plugins/surfcore/tools/commands/dm-await.mjs` 里有个本地函数：

  ```js
  const parsed = (content) => {
    try { const j = JSON.parse(String(content)); return String(j.content ?? j.text ?? content) } catch { return String(content ?? '') }
  }
  ```

- B 站私信的 `content` 是一段 JSON，视频地址在 `jump_url`、BV 在 `rid`、标题在 `text`（见
  `plugins/surfcore/tools/docs/rich-text-nodes.md` 的 `RICH_TEXT_NODE_TYPE_BV`）。
  只取 `j.content` 就把 `jump_url` / `rid` / `type` 全丢了。
- 这个函数同时被 `last_msg`、`fetchHistory()` 和 `items` 三条路径调用，所以**翻 items 也没用**——
  items 里同样只有 `{ts, sender, text}`。她以为"卡片在 items 里没翻"，其实是 items 里就没有链接。
- 图片消息的 JSON 没有 `content/title/text`，旧逻辑会把整段 JSON 当正文塞回去，更没法看。

## 完整逻辑

- **链路**：B站会话（agentPreset standard）→ `dm-await --once --json` → `get_sessions`（只给 `last_msg`）
  → owner 模式下再拉 `fetch_session_msgs` 补全连发 → 每条消息 `content` 经 `parsed()` 压成文本 → 打进 items。
- **机制**：OneBot/富文本的消息体是"文本 + 结构"混在一个 JSON 里，解析层只保留文本字段，
  等于把"能跳转的东西"降级成"只能读的一句话"。丢的过程在本地、静默，服务端不知道。
- **爆炸半径**：1 个 CLI + 1 个新 lib；不写业务状态、不花钱；静默=3（她以为看到了，其实只看到一半）。
- **取舍**：
  - A：把原始 JSON 整段透出给模型 —— 上下文会被一堆 `{"url":...}` 撑爆，且她没有解析器；
  - B：解析成 `{text, url, kind}` 三个字段输出（**选这条**）—— 结构稳定、可断言，文本仍是人读的；
    代价是字段白名单要跟着接口演进维护。
- **生效与重启**：CLI 每次调用起新进程，改完即生效；不需要重启 DSH。

## 修法

1. 新增 `plugins/surfcore/tools/lib/dm-content.mjs`：
   - `normalizeCardUrl()`：`//` 补 `https:`、`/` 补站内域名；
   - `parseDmContent()`：返回 `{text, url, kind}`，依次看根对象、`content` 里的嵌套 JSON、数组节点；
     没有 `jump_url` 但有 `rid` 时按 `https://www.bilibili.com/video/<rid>/` 拼地址；
     没有正文时给 `[图片]` / `[卡片]` 占位，不再回吐原始 JSON。
2. `dm-await.mjs` 的三条路径（`last_msg`、`fetchHistory`、items）改用这个解析器，输出带上 `url`：
   - `--any`：`DM_HIT … text=… url=…`
   - owner：逐条 `[时间] 文字 → url`
   - `--json`：`items` 每项多 `url` / `kind`

回滚：`git revert <本提交>`；`dm-await.mjs` 里恢复旧的 `parsed()` 即可。

## 验证

- 新增 `scripts/test-dm-card-parse.mjs`：9 个样例（纯文本 / 文本 JSON / BV 富文本 / 协议相对 URL /
  JSON 套 JSON / 只有 rid / 数组节点 / 图片 / 卡片无标题 / 坏 JSON），并断言 `dm-await` 两条输出路径都带 `url`。
- 真实账号只读复验（拉主人会话最近 50 条）：
  - 修前：0 条带链接；
  - 修后：2 条，都是图片消息，输出 `[图片] → https://message.biliimg.com/…png`，不再是原始 JSON。
- **没验证到**：真实的视频卡片（最近 50 条里没有），只用 BV 富文本样例和文档结构覆盖。

## 遗留 / 后续

- `--any` 模式仍只取会话的 `last_msg`：对方连发多条时，前面的消息要等 owner 模式或下次水位才补。可以改成"当 `unread_count > 1` 时拉一次历史"。
- 已经写进记忆卡的旧私信只剩文字，补不回来；新消息会带链接。
