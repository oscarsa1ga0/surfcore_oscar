# 她把自己的 23:36 读成 15:36：工具给的是 UTC

## 现象

2026-11-16 23:47 左右她的思考里写：

> 看一眼 `d-20261116-001` 是不是也有更新（它 `updatedAt` 是 15:36，也是最近的）。

而那篇日记的实际更新时间是 **23:36:42（北京时间）**。差整 8 小时。

## 根因

- 存储层（`src/diary-store.js`）用 `iso(now)` 写 front matter，即 **UTC ISO**：
  `updatedAt: '2026-11-16T15:36:42.887Z'`。
- 工具层（`diary_list` / `diary_read` / `diary_search`）原样把 UTC 字符串返回给模型。
- 模型读时间不做时区换算，直接把「15:36」当本地时间用 —— 于是晚上 23 点的事被她当成下午 3 点。
  同样的坑还会让她误判“今天/昨天”，比如把刚写的日记当成几小时前的。

## 修法

`plugins/surfcore/lib/diary-tools.js` 增加 `localIso()` / `localizeEntry()` / `localizeResult()`：
工具返回的 `createdAt` / `updatedAt` 一律转成**带本地偏移**的 ISO：

```
2026-11-16T23:36:42+08:00
```

覆盖 `diary_write` / `diary_read` / `diary_search` / `diary_list` / `diary_edit` 的返回值。
**存储层不动**（仍是 UTC），只在展示层转换，避免影响别的读者。

## 验证

- 实测 `diary_list`：`d-20261116-001 · updated 2026-11-16T23:36:42+08:00`（修前是 `...15:36:42Z`）。
- `test-diary-tools` 新增断言：所有条目的 `createdAt` / `updatedAt` 必须以 `±HH:MM` 结尾、不能是裸 `Z`。
- `test-diary-tools` 9/9 通过。

## 遗留

- QQ 侧「最近写过的日记」那行只给日期不给时间，不受影响。
- 桥接内部比较时间仍用 ISO/时间戳，没改。
