# QQ 主人私聊注入「B站当天日记」

## 做法

`src/bridge.js`：

- `extractTodayDiary(text, today)`：按 `## YYYY-MM-DD` 和 `### …（YYYY-MM-DD …）` 两种日期头切段，只取今天的段落；
- `todayBiliDiaryText()`：读当前角色的 `bili/whale-diary.md` + `bili/whale-diary-private.md`，按 mtime/size 缓存；
- `buildWakePromptV2()`：只在 `key === private:<ownerQQ>` 时拼成 `【B站日记 · 今天】` 注入，最多 6000 字。

群聊不注入（私人日记不进群）；其它私聊也不注入。

## 验证

- 今天实际抽取：`whale-diary.md` 1842 字 + `whale-diary-private.md` 582 字 = 2426 字，开头分别是「## 2026-11-15 · 早上」和「### 二十四、把「额度」和「风控」搞混了（2026-11-15 09:40）」；
- `node --check src/bridge.js` 通过；桥接已重启，启动无报错。

## 限制

- 只认文件里的日期标题；如果当天条目既没有 `## 日期` 也没有标题里的日期，会漏掉；
- 注入长度上限 6000 字，超了截断；
