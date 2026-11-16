# 同一天写了三篇日记：diary_write 只会新建，不会接在后面

## 现象

2026-11-16 她在 QQ 私聊里写了三篇，当天日记目录里躺了三个文件：

| 时间 | 文件 | 来源 |
| --- | --- | --- |
| 10:38 | `entry_001.md` | 聊天中自己写（14:30 定时回顾追加过一次） |
| 18:28 | `entry_002.md` | 聊天中自己写 |
| 21:15 | `entry_003.md` | 聊天中自己写 |

三篇是同一回事的不同片段，读起来像被切成三段。

## 根因

- `diary_write` 工具直接调 `createEntry()`，而 `createEntry` 每次都取当天下一个序号
  （`entry_001 → 002 → 003`），**没有“当天已有就追加”的分支**。
- “同一天只写一篇、晚上用 `diary_edit` 追加”这条规则**只写在定时日记回顾的提示词里**
  （`plugins/surfcore/lib/diary-scheduler.js` 第 364 行，14:30 / 23:30 两次提醒）。
- QQ 聊天会话的提示词里没有这条，只有工具说明「写一篇自己的日记」。于是她在聊天里临时起意写，
  每次都走 `diary_write`，每次都是一篇新的。
- 14:30 那次定时回顾是**对的**：它走 `diary_edit`，把内容追加进了 `entry_001`（001 的
  `updatedAt` 正是 14:30）。

## 完整逻辑

- **链路**：QQ/B站 会话 → 全局工具 `diary_write`（宿主插件注册，不是 MCP）→
  `src/diary-store.js` 的 `createEntry()` → 写 `diary/entries/YYYY/MM/DD/entry_00N.md` → 重建索引。
- **机制**：工具语义是“写一篇”，不是“写进今天这篇”。序号由目录里最大编号 +1 决定，
  所以“想接着写”和“想另起一篇”在工具层没有区别。
- **爆炸半径**：只影响她自己写日记的姿势；不丢数据（三篇都在），但当天日记被切碎，
  回顾/分享时要挑好几篇。
- **取舍**：
  - A：只改提示词（“写之前先 `diary_list`，有就 `diary_edit` 追加”）——软约束，她赶时间就会跳过，
    今天的现象已经证明了；
  - B：改工具默认行为（**选这条**）——当天已有日记默认追加，另开一篇要显式 `newEntry: true`；
    代价是“同一天多篇”从默认变成需要显式请求。
- **生效与重启**：工具由插件注册，改完要**重启 DSH** 才会换成新 schema/行为。

## 修法

`plugins/surfcore/lib/diary-tools.js`：

1. `diary_write` 默认路径改成：先读目标日期（默认今天）的最后一篇，存在且没传 `newEntry: true`
   就 `editEntry(..., { append })`，返回里带 `appended: true`；
2. 新增参数 `newEntry: boolean`，只有它为 true 才走 `createEntry`；
3. content 为空时仍走 `createEntry` 抛错（保持“空白内容 → ok:false”）；
4. 追加时合并标签、**不改标题/可见性**（沿用原篇）。

文档同步：`docs/guides/DIARY.md` 的「同一天可以多篇」改成「默认一天一篇」。

回滚：`git revert`；或把 `diary_write` 的 handler 换回直接 `createEntry`。

## 验证

- `scripts/test-diary-tools.mjs` 新增用例：同一天写两次 → 第二次 `appended:true`、同 id、
  标题不变、正文两段都在；`newEntry:true` → 新 id；当天正好两篇。
- 同文件既有用例「分享边界」补了固定日期 + `newEntry:true`，避免被“追加到当天最后一篇”串味。
- `test-diary-store` 7/7、`test-diary-scheduler` 13/13、`test-diary-guard` 1/1、`test-diary-tools` 8/8。

## 遗留

- 已经写出来的 `entry_002` / `entry_003` 不会自动合并；要合成一篇得手动 `diary_edit` 拼。
- 定时回顾的提示词仍写着“用 `diary_edit` 追加”，行为不变，和新默认不冲突。
