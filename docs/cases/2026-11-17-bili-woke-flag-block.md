# 晚场没醒：woke 标记把第二个 wake 槽永久推迟

## 现象

11-17 22:52 该醒没醒。`whale-night.json` 里 `at` 一直在往后滑：

```
22:50  at=1370 pending
22:52  at=1372 pending
22:54  at=1374 pending   ← 每次看都在 now+1
```

窗口 22:00–23:00，等到 23:00 就会记 missed。

## 根因

1. 今天 06:10 醒过一次，state 里写入 `woke: true`；
2. tick 的重排条件是 `if (!st || st.date !== t || st.woke === true || ...) { runBili(['night','plan']); return }`
   —— **每天第一次醒之后，这条恒真**；
3. `night plan` → `nextPendingSlot()` 发现 `at < now`，把 `at` 改成 `now + 1`（旧逻辑：迟到就顺延）；
4. 于是每个 tick 都在「重排 → at=now+1 → return」，**永远走不到后面的 wake 分支**。

为什么 12:44 的轻醒没事：skip 分支写在重排分支**之前**，而且条件是 `now >= at`，所以它能先命中。

## 完整逻辑

- **链路**：插件 60s tick → readState → 若 woke/done 等成立则 `night plan` → 写回 state →
  下一 tick 再来一遍。
- **机制**：`woke` 是旧格式的「今天已醒」全天标记；新格式按 slot 推进，两个语义混用 →
  新 slot 被旧标记挡住。
- **爆炸半径**：一天里除第一个 slot 外的所有 `wake` 槽（skip 槽不受影响）；静默失败，无日志。
- **取舍**：A 只改 tick 条件（不动 CLI）——旧格式仍会重排，但新格式能走；
  B 再让 `planFromSlot` 复位 `woke`（**选这条 + A**）——让状态本身不再携带错误语义。

## 修法

1. `plugins/surfcore/tools/commands/whale-night.mjs` 的 `planFromSlot()`：推进 slot 时
   `woke: false`；
2. `plugins/surfcore/lib/scheduler.js` 的 tick 重排条件：`(st.woke === true && !st.slotId)`
   —— 有 slotId 时以 slot 的 `status` 为准。

## 今晚的处理

22:56 手动把 state 里的 `woke` 置回 `false`（原文件备份在
`~/.dsh/_quarantine/whale-night-backup-20261117-2256.json`），下一 tick（22:54:48）正常触发：

```
[bili-whale] 生物钟叫醒 · 22:54（22:00–23:00） · 第 3 次
```

今天收工（`done: true`，wakes 3/3）。

## 验证

- `test-night-schedule` 通过；
- 新增 `test-bili-clock-woke-reset`：钉住「planFromSlot 必须复位 woke」和
  「tick 只对无 slotId 的旧格式看 woke」，已登记进 `test-audit`。

## 生效

`whale-night.mjs` 每次 spawn 生效；`scheduler.js` 是插件代码，**重启 DSH** 后才带上新条件。
今晚是手动清状态救回来的，不改代码的话明天第二个 wake 槽还会被同样饿死。
