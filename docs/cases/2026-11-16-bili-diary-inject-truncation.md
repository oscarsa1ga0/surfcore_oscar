# QQ 看不到她刚写的 B 站日记：注入按「从前往后」截断

## 现象

2026-11-16 23:20 她在 B 站私人日记写了第 44 条（`### 四十四、我编了一件事`）。
当天算了一下注入内容：

```
whale-diary.md          今天 5374 字
whale-diary-private.md  今天 2362 字
合计 7738 字 → 注入时 slice(0, 6000)
第 44 条位置：7484 字 → 被截掉
```

也就是说：**今天看不到**（被预算切掉），**明天也看不到**（只抽“今天”的段落，过了午夜日期就不匹配）。

## 根因

`src/bridge.js` 里 `todayBiliDiaryText()`：

```js
const parts = [];
for (const file of files) { const seg = extractTodayDiary(raw, today); if (seg) parts.push(seg); }
const text = parts.join('\n\n');       // 旧 → 新
...
`【B站日记 · 今天】\n${biliDiaryText.slice(0, 6000)}`
```

- 段落顺序是文件顺序（旧 → 新），`slice(0, 6000)` 从头切 → **先丢最新的**；
- 两本文件叠加后总量 7738 字，最新写的那条必然在外面。

## 完整逻辑

- **链路**：主人私聊唤醒 → `personaWakeBlockV2()` → `todayBiliDiaryText()` 读
  `<character>/bili/whale-diary.md` + `whale-diary-private.md` → 按标题里的日期抽当天段落 →
  拼成 `【B站日记 · 今天】` 塞进提示词。
- **机制**：预算截断的方向和“什么最该留”相反。日记是追加写的，最旧的在前面、最新的在最后，
  从头截正好把刚写的切掉。
- **爆炸半径**：只影响 QQ 主人私聊看到的 B 站日记（群聊不注入）；不写数据、不花钱；静默丢内容。
- **取舍**：
  - A：加大预算（治标，日记继续长还会撞）；
  - B：**从最新往回装**（选这条）——被丢的永远是最老的条目；单段超预算时保留尾部。
- **生效与重启**：桥接是常驻进程，改完要**重启桥接**（DSH 重启时 `autoStartBridge` 会自动带起）。

## 修法

1. 新模块 `src/bili-diary-inject.js`：`extractDaySegments()` / `trimNewestFirst()` /
   `composeDiaryInjection()`，纯函数、可单测；
2. `bridge.js` 改为调用 `composeDiaryInjection(texts, today, 6000)`，不再 `slice(0, 6000)`。

## 验证

- `scripts/test-bili-diary-inject.mjs`：当天过滤（昨天的段落不进来）、预算不够先丢最老的、
  保持时间顺序、单段超预算保留尾部、多文件按文件顺序、没有当天段落返回空串。已登记进 `test-audit`。
- 真实数据复算：现在输出正好 6000 字，**第 43、44 条都在**（修前 44 在 7484 字处被切）。

## 遗留

- **跨天仍然看不到**：注入还是只抽“今天”的段落。想让昨天的第 44 条明天也出现在 QQ，
  需要把选择改成“最近 N 条”而不是“今天”——这次按约定只改了截断方向。
- 单段超预算时会保留该段尾部，标题行会被切掉（内容优先）。
