# 日记（Diary）

> 状态：✅ 2026-11-12 实现（SurfCore 宿主注册的工具 + 每角色独立存储 + 每日回顾）。
> 相关代码：`src/diary-store.js`、`plugins/surfcore/lib/diary-tools.js`、
> `plugins/surfcore/lib/diary-scheduler.js`、`plugins/surfcore/diary-tool-guard.mjs`、
> `dsh/agent-presets/surfcore-diary/`。

## 1. 它是什么

日记是**鱼姬写给自己的生活记录**：今天发生了什么、当时怎么想、和主人/别人的相处、
自己觉得值得留下的第一次。它和另外两套东西分开：

| | 存什么 | 谁看 |
| --- | --- | --- |
| `memory/` 记忆卡 | 需要长期记住的事实、偏好、关系 | 每次聊天注入 |
| `diary/` 日记 | 某一天的经历、想法、感受 | 她自己的私人记录；由她决定分享什么 |
| `bili/whale-diary.md` | B站冲浪的“两本日记”（旧功能，给主人看的活动摘要） | 保持原样，不和这套混 |

日记**不是**聊天记录的机械复制，也不是给主人交的工作报告；没有值得记的事时允许不写。

## 2. 存在哪

```text
~/.dsh/surfcore/characters/<character_id>/diary/
  entries/YYYY/MM/DD/entry_001.md   # 每篇一个 Markdown，YAML front matter + 正文
  candidates/YYYY-MM-DD.jsonl       # 白天的候选（diary_capture 记的）
  candidates/processed/...          # 当日回顾提交后归档
  shares.jsonl                      # 每次分享的摘录（出站授权凭据）
  index.json                        # 缓存；损坏/丢失可重建
  scheduler-state.json              # 每日回顾状态（lastReviewedDay/attempts/lastError）
  trash/YYYY-MM-DD/                 # 删除的日记（不直接 unlink）
  .lock                             # 跨进程写锁
```

- **每角色独立**：换角色不会串；删除/修改都限制在当前角色的 `diary/` 内。
- **同一天可以多篇**：`entry_001.md`、`entry_002.md`…
- **索引只是缓存**：`entries/` 才是真相；`index.json` 坏了会自动重建。
- **快照**：角色存档会带上 `diary/` 作备份；回档**不会**覆盖 diary（生活记录不该被回档抹掉）。
  要找回旧日记，人工从 `snapshots/<slot>/diary/` 复制。

## 3. 工具

由 SurfCore 宿主注册为全局工具（不是 MCP server，也不绑定 QQ）：

| 工具 | 用途 |
| --- | --- |
| `diary_write` | 写一篇日记（第一人称；可指定日期/标题/标签/可见性） |
| `diary_capture` | 暂存一件值得以后回顾的事（候选；晚上再决定写不写） |
| `diary_read` | 读自己的日记（默认今天，也可按 id/日期） |
| `diary_search` | 按关键词/日期/标签搜历史日记（返回摘要） |
| `diary_list` | 访问日记目录（日期/标题/可见性/字数） |
| `diary_edit` | 替换正文/追加/改标题/标签/可见性 |
| `diary_delete` | 删除（移到 `trash/`） |
| `diary_share` | 从一篇里选内容分享给主人（见下） |

工具只走受控存储层；模型永远拿不到文件路径参数。所有写操作有**每角色写锁** + 原子写。

## 4. 隐私：private / shareable / shared

- `private`（默认）：只给自己看。
- `shareable`：她认为可以整篇给主人看。
- 分享记录在 `shares.jsonl`；`diary_list` 会显示是否分享过。

`diary_share` 的规则：

- `shareable` 可以 `mode="full"` 整篇分享；
- `private` **只能** `mode="excerpt"`，且 `excerpt` 必须是正文里的**原文子串**（不能改写/拼接），最多 2000 字；
- 每次分享都会记下这段原文；**只有这段**被授权出站。

**出站硬闸**：桥接在 `onebotSend` / `onebotSendSegments` 发送前，把文本和当前角色的
私人日记做 24 字窗口的字面比对；命中未授权的原文就拒绝发送，并把原因带回给模型。
`diary.leakGuard=false` 可关闭。日记读取失败/损坏时一律放行（日记故障不影响聊天）。

**边界（重要）**：

- 这是 **Agent 层**的分享权限，不能阻止本机文件所有者直接读 `~/.dsh/surfcore/characters/...`。
- 硬闸是字面比对，不做语义判断；她换一种说法转述不会被拦（这本来也是“她决定怎么讲”）。
- 语音/图片等非文本出站不在字面闸的覆盖范围内；语音内容不要包含私人日记原文。

## 5. 每日回顾

- 默认 **每天两次：本地时间 14:30 和 23:30**（`diary.reviewAt` / `diary.reviewAtEvening`）。两次写**同一篇 md**：下午写过，晚上用 `diary_edit` 追加，不新建第二篇。
- 由插件宿主每 60 秒 tick 检查；到点叫醒一个**专用日记会话**（`diary-<characterId>`，
  preset `surfcore-diary`），由她自己的 Agent 决定写不写、写什么。
- 不塞进 QQ 会话：不打断聊天、不污染上下文、不依赖 QQ 是否在线。
- 当天材料：
  - **优先**：向桥接的 `/api/diary/history` 要当天完整 QQ 历史（`count=2000`，覆盖
    00:00 到当前；消息很多时按小时取头尾采样，保证上午/下午/晚上都出现在材料里）。
    这解决了 `recentMessages` 只有最近 100 条、早上容易被挤出窗口的问题。
  - 回退：桥接/网关卡不可用时，用 `state/social-v2.json` 的 `recentMessages`（最多 100 条/会话）；
  - 角色 `bili/whale-log.jsonl` 的当天事件；
  - 当天 `candidates/`；
  - 当天已写日记的标题。
- 同一天每个时段只提交一次（14:30 / 23:30 各一次）；提交失败最多重试 `diary.maxAttempts` 次（默认 2），并记录
  `lastError`；**她选择不写不会触发重试**。
- 手动「立即整理」**不等于**完成了当天的任一时段：手动整理过，14:30 / 23:30 仍会照常跑；
  只有手动整理发生在某个时段前 30 分钟内（或之后）时，才跳过那个时段，避免刚点完又跑一遍。
- 离线补执行：如果某个时段程序没运行，恢复后在 `diary.catchUpHours`（默认 6 小时）
  窗口内补**最近一个时段**；超过窗口不补。
- 提交成功后把当天候选归档到 `candidates/processed/`。
- **和 QQ 会话的同步**：日记写在一个独立 DSH 会话里，QQ 会话不会自动看到内容；
  但主人在私聊里每次唤醒会带一行【日记】最近写过的标题/日期/可见性（群聊/其他人私聊
  不带，避免标题外泄），她知道“我写过”，可以 `diary_read` 回顾，也可以 `diary_edit` 补充。
  写日记的正文**不会**自动写进记忆卡（记忆和日记保持两套），只给一个指针，避免把日记
  混成流水账。

### 配置

`~/.dsh/surfcore/config.json`：

```json
{
  "diary": {
    "enabled": true,
    "autoReview": true,
    "reviewAt": "14:30",
    "reviewAtEvening": "23:30",
    "catchUpHours": 6,
    "maxAttempts": 2,
    "captureEnabled": true,
    "leakGuard": true,
    "digestMaxChars": 8000
  }
}
```

也可以直接在 **设置 → SurfCore → 日记** 里改；保存后调度器下一 tick 生效。

### 手动触发

设置页「日记 → 立即整理今天的日记」，或：

```bash
# 需要 DSH 的会话 Cookie；一般直接用设置页按钮
curl -s -X POST http://127.0.0.1:<DSH_PORT>/dsh-surfcore/api/diary/review \
  -H 'content-type: application/json' -d '{"action":"review"}'
```

## 5.5 公开分享（B站自由发布）

B站侧的「自由发布」可以从 B站侧 `whale-diary` / `whale-diary-private`，或这本夜间日记里挑一段公开：

- B站会话有全局 `diary_*` 工具，可以 `diary_list` / `diary_read` 读；
- 只挑**你愿意公开、且不含主人/他人隐私**的段落；
- `diary_share` 是「给主人看」的授权，不是「公开发布」授权；公开前另走 `free-post --dry`；
- 默认 private 的日记不会自动公开，也不建议整篇搬。

## 6. 与 QQ 聊天

- QQ 会话通过这些工具读写日记（`qq-tool-restrict` 已放行 `diary_`）。
- 主人的要求会自然进入她自己的写作流程；她可以拒绝/只给一段。
- QQ v2 preset 里加了【日记】规则：值得才记、不每轮记、写完不主动通知、不编造。
- 日记会话的 `diary-tool-guard` **拒绝 QQ 发送工具**，所以她在日记时间物理上无法
  “写完顺手告诉主人”。

## 7. 验证 / 测试

```bash
node scripts/test-diary-store.mjs
node scripts/test-diary-tools.mjs
node scripts/test-diary-scheduler.mjs
node scripts/test-diary-guard.mjs
# 或
npm run test:diary
```

真实环境验收：

1. 重启 DSH（新工具/新 preset/设置页需要重新加载）。
2. 设置 → SurfCore → 日记：确认「回顾运行中」，把下午/晚上任一时间临时改成 1 分钟后，保存。
3. 等一轮，设置页能看到「上次回顾 <今天>」；`characters/<id>/diary/entries/<今天>/`
   出现文件，内容是第一人称、不是模板。
4. 同时发一条 QQ 消息，确认聊天不受影响。
5. 把时间改回 14:30 / 23:30。
6. 在 QQ 里让她写日记 / 给你看某篇；确认私人原文直发会被拦，`diary_share` 的摘录能发。

## 8. 已知限制

- 每日材料优先取当天完整 QQ 历史（`count=2000`，按小时采样）；如果回顾时桥接/网关卡
  不可用，回退到 `recentMessages`（每会话 100 条），这种降级情况下早上可能缺失；
  日志会标注截断/回退。
- 日记会话和 QQ 会话是两个 DSH 会话：日记正文不会自动进入 QQ 上下文；QQ 唤醒只带
  最近日记的标题指针。要让她补充/修改，直接在 QQ 里说，或 `diary_edit`。
- 旧 B站 的 `whale-diary.md` 两本日记仍然独立存在；Prompt 里已区分“B站冲浪日记”和
  “自己的生活日记”，但历史内容不会自动迁入新系统。
- 日记会话使用独立 preset；如果 DSH 没重启/没加载 preset，调度器会记录
  “创建日记会话失败”，不会反复烧模型。
- `diary_read`/`diary_search` 返回的内容可能包含私人信息；出站硬闸只拦“原文”，
  不拦转述。主人本地仍可直接读文件。

## 9. 排障

| 现象 | 处理 |
| --- | --- |
| `plugin.log` 里有 `日记工具已注册 8 个`，但 QQ 里她不知道有日记工具 | 工具是全局注册的；确认 DSH 已重启，QQ 会话按新 preset 重建（切换一次角色或重启桥接）。 |
| `plugin.log` 有 `创建日记会话失败` | 检查 `surfcore-diary` preset 是否被 DSH 加载（重启 DSH；确认 bundle 的 `dsh.bundle.patch` 含 `./presets/surfcore-diary.patch.yml`）。 |
| 提交回顾报 `reading 'throwIfAborted'` | 这是旧版调度器漏传 AbortSignal 的 bug；更新代码后重启 DSH。 |
| 设置页看不到「日记」标签 | 客户端代码随插件加载；重启 DSH / 刷新设置页。 |
| 回顾时间到了没跑 | 看 `diary.enabled/autoReview`；看 `scheduler-state.json` 的 `attempts` 是否到 `maxAttempts`；`catchUpHours` 窗口是否已过。 |
| 私人日记原文发不出去 | 这是出站硬闸在工作；用 `diary_share` 选一段摘录（必须是原文子串），或换成自己的话。 |
