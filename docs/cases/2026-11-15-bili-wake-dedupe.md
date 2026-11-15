# 中午 B 站生物钟“叫醒成功却没醒”：requestId 被 DSH 去重 + 动态提醒作用域 bug

## 现象

- 用户：中午那次 B 站生物钟没醒。
- plugin.log：`12:50 生物钟叫醒 · 12:50（12:30–13:30） · 第 2 次`，看起来成功；
- 但 bili-whale 会话文件最后写入是 12:28，12:50 之后没有任何回合；会话投影 `openTurnStartSeq=null`、`inbox` 为空。

## 根因

1. **requestId 去重（主因）**：`submitWatchRound` 的 requestId 是
   `bili-whale-watch-<sessionId>-<date>-<slotId>`。
   早上 06:49 那次用的也是 `2026-11-15-s1`；用户把作息改成 12:30–13:30 后重排，slot 仍是 `s1`，
   12:50 的 requestId 和 06:49 完全一样。DSH 的 prompt 按 requestId 去重：
   「已进入 queue 或日志时，重试直接返回原来的接受结果，不会重复插入消息」。
   于是 12:50 拿到“已接受”，实际没插入任何消息；`submitBili` 认为成功，日志照打“叫醒”。
2. **动态提醒作用域 bug（次因）**：12:00 的动态提醒在日志里引用回调内的 `inSlot`，
   抛 `ReferenceError: inSlot is not defined`，整条提醒失败（`plugin.log` 有记录）。

## 修法

- `plugins/surfcore/lib/scheduler.js`：
  - requestId 追加实际时间：`...-<slotId>-<Math.round(at)>`，重排后不再撞；
  - 动态提醒日志改用回调外单独计算的 `inSlotForLog`（不改回调内 `inSlot` 的语义）。

## 验证

- `node --check` 通过；
- `plugins/surfcore/scripts/test-platform-start-host.mjs` 通过（仍保证多趟唤醒 requestId 互不相同）；
- `test-admin-bili-prompt` 通过。

## 生效

`plugins/surfcore/lib/scheduler.js` 由 DSH 插件宿主加载，**要重启 DSH** 才生效；下一个生物钟窗口（今晚 22:12）是第一次实测。
