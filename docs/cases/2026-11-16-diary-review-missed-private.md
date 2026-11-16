# 日记会话看不到私人日记：只认 `## 日期`，私人本用的是 `### 条目标题`

## 现象

问她 11-16 23:20 写的 B 站私人日记第 44 条「日记会话里能不能看到」。用 `buildDailyDigest()`
按当天真实数据模拟了一遍日记回顾的提示词：

```
长度 6497 · 含「今天在 B站 两本日记里写下的」段: true · 含「四十四」: false
```

段落在，但**私人日记整本当天一条都没进来**；公开本也只进了开头 2000 字。

## 根因

`plugins/surfcore/lib/diary-scheduler.js` 的 `extractDiaryDaySection()`：

```js
const m = /^##\s+(\d{4}-\d{2}-\d{2})\b/.exec(lines[i]);
```

- 只认**二级标题** `## 2026-11-16`。公开本有（`## 2026-11-16 · 早上`），
  但私人本的日期写在**三级标题**里：`### 四十四、我编了一件事（2026-11-16 23:20）`
  → 找不到 `## 日期`，函数直接返回空串，整本当天被跳过。
- 就算找到了，也是 `section.slice(0, 2000)` —— 又是「从前往后切」，下午/晚上写的在后面，
  正好被切掉。和 QQ 注入那次（`2026-11-16-bili-diary-inject-truncation.md`）是同一类错。

## 完整逻辑

- **链路**：日记回顾（14:30 / 23:30）→ `buildDailyDigest()` 拼「今天的原材料」→ 其中一段是
  「今天在 B站 两本日记里写下的」→ 写进日记会话的提示词 → 她据此写/补今天的日记。
- **机制**：两本日记的标题层级不一致（公开本 `##`、私人本 `###`），抽取函数只写死了 `##`；
  截断方向又是从头切，双重丢内容。
- **爆炸半径**：只影响日记回顾看到什么；不写数据；静默丢失（她只会觉得“今天 B 站没什么可写”）。
- **取舍**：复用 QQ 注入那套解析（`src/bili-diary-inject.js`）而不是再写一份 —— 同一份数据两个
  消费方，解析规则必须同源，否则下次又是“QQ 能看到、日记会话看不到”。
- **生效与重启**：插件代码，改完要重启 DSH。

## 修法

`diary-scheduler.js` 改为：

```js
import { extractDaySegments, trimNewestFirst } from '../../../src/bili-diary-inject.js';
const section = trimNewestFirst(extractDaySegments(text, target), 2000);
```

`extractDaySegments` 同时认 `##` / `###` 标题里的日期；`trimNewestFirst` 从最新往回装 2000 字，
被丢的永远是最老的条目。旧的 `extractDiaryDaySection()` 删掉。

## 验证

- 模拟 `buildDailyDigest()`（`maxChars: 8000`）：
  - 修前：含「四十四」= false；
  - 修后：含「四十四」「四十三」= true，且「两本日记」「今天已经写过的日记」「最近写过的」各段都在。
- `maxChars: 12000` 时全文 8304 字、不触发截断。
- 单测：`test-bili-diary-inject` 增加「只有三级标题也要算当天段落」；`test-diary-scheduler` 13/13、
  `test-diary-tools` 8/8。

## 遗留

- 总预算 8000 在聊天特别长的日子仍会 `truncated`（今天 8050/8000，超了 50 字），最末尾的
  「候选」段可能被挤掉。要更稳可以调 `diary.digestMaxChars`（设置页「日记」）。
- 跨天同理：回顾只取当天段落，昨天的第 44 条在明天的回顾里也不会出现。
