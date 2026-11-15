# comment-digest 被 `| tail` 截断：漏掉的未读再也看不到了

> 原修法提交 `dc34b5d`（feat/video-creation，2026-11-14 19:56）；
> 2026-11-15 挑进 feat/macos-qq，提交 `04ff993`。

## 现象

- 2026-11-14 18:05 那轮，主人的评论**在** `comment-digest --hours 24 --only-unread` 的清单里，
  但她用 `| tail -4` / `| tail -5` / `| tail -12` 压输出，较早的条目被截掉。
- 收件箱（B站 msgfeed）的已读水位随查询前移：查过一次就算已读，下一次 `--only-unread`
  不再列出被截掉的那几条 —— **漏一次就永久丢**。
- 影响面：只影响「她看见谁找过她」，不写业务状态、不丢文件、不花钱；但错过就是错过，无法补。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH | macOS / DeepSeek Harness（桌面版） |
| SurfCore | 0.8.9 |
| 安装方式 | git（worktree：feat/macos-qq + feat/video-creation） |

## 根因

- 唤醒提示 `plugins/surfcore/lib/scheduler.js` 的 2.6 只给了命令和坐标，**没有约束「必须看完」**。
- `comment-digest` 要分页拉 `/x/msgfeed/reply` + `/x/msgfeed/at`，还要逐条回读楼层核实正文，
  输出天然长；模型压缩长输出的本能就是 `| tail -N`。
- 「已读」是**查询的服务端副作用**，`tail` 只是在本地丢行，服务端并不知道 —— 所以本地截断不可逆。

## 完整逻辑

- **链路**：B站会话（agentPreset standard，cwd `~/.dsh/surfcore/state/bili-agents`）
  → 提示词 2.6 → `bili.mjs comment-digest --hours 24 --only-unread`
  → `tools/lib/msgfeed.mjs` 拉两个 feed → 逐条 `resolveLatestReply` 核实正文。
- **机制**：条目多 + 每条要回读楼层 → 输出长；`--only-unread` 依赖服务端已读水位，
  而水位在查询时前移。截断发生在本地，水位前移发生在服务端，两边都不知道对方。
- **爆炸半径**：1 处提示词 + 1 个 CLI；单进程；静默=3（她不知道漏了、主人也不知道）。
- **取舍**：
  - A：CLI 强制整份输出（取消分页 / 加 `--all`）→ 可能撑爆上下文，改动大；
  - B：提示词 + 输出末尾双向提醒（**选这条**）→ 两行、可回滚；
    代价是仍依赖她遵守提示，属于"概率约束 + 最后一行保险"。
- **生效与重启**：`scheduler.js` 是插件代码，改完要重启 DSH；`comment-digest.mjs` 每次调用新进程，立即生效。

## 修法

1. `plugins/surfcore/tools/commands/comment-digest.mjs` 输出**最后一行**追加警告。
   放最后一行是故意的：她即使 `| tail -3`，这句也还在视野里。
2. `plugins/surfcore/lib/scheduler.js` 的 2.6 增加硬规则：不要用 `| tail` / `| head` 截断收件箱清单。

回滚：`git revert 04ff993`（在 feat/macos-qq 上；feat/video-creation 侧是 `dc34b5d`）。

## 验证

- `node scripts/test-audit.mjs`：退出码 0（本机 151~152/159，波动来自既有的环境相关脚本）。
- 手工（真实账号、只读）：`comment-digest --hours 24 --pages 1 --raw | tail -4`，
  末尾仍能看到「完整看这份清单」那句 —— 证明截断后警告仍可见。
- 空清单分支（`共 0 条 → 安静得很`）不打印这句，属预期：没有条目就没有「漏看」风险。
- **没验证到**：无法真实复现「漏看一次」的时序（要等真实的未读 + 已读前移），
  服务端水位前移的时序来自事故复盘与代码阅读，没有专门打点。

## 遗留 / 后续

- 更彻底的做法：把「上次报告过的条目」落本地账本，下次对比补发，让截断也不会丢；
  这次没做（收益不大，先靠提示词）。
- 待补测试：给 `comment-digest` 加一条断言，检查非空清单的最后一行必须含警告文案。
