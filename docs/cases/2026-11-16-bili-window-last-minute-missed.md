# 生物钟整轮没醒：叫醒点被排进了窗口最后一分钟

## 现象

2026-11-16 晚上那轮 B 站生物钟没醒。日志：

```
23:00:43 [bili-whale] 错过窗口 22:00–23:00（23:00）→ 记 missed，排下一趟
```

`whale-night.json` 里对应的槽：

```json
{ "window": "22:00–23:00", "start": 1320, "end": 1380,
  "at": 1379.8446584213816, "atText": "23:00", "status": "missed" }
```

`at = 1379.84` 意味着叫醒点定在 **22:59:50**。

## 根因

- `plugins/surfcore/tools/lib/night-schedule.mjs` 的 `buildNightSchedule()` 在窗口里均匀取点：
  `desired = w.start + i*seg + random()*seg`，**没有排除最后一分钟**。
- 生物钟 `tick()` 每 60 秒跑一次；`scheduler.js` 里判定顺序是：

  ```js
  if (currentSlot && !st.fired && currentSlot.status === 'pending' && Number(currentSlot.end) <= nowMin()) {
    markScheduleSlot(st, currentSlot.id, 'missed', nowMin())   // 先记错过
  }
  ```

- 今天 tick 落在 22:59:43（早于 22:59:50）和 23:00:43（晚于窗口结束）。第二个 tick 一来，
  `end (1380) <= now (1380)` 成立，先记 missed，**然后才轮不到叫醒**。
  于是整轮就这么没了——不是她不想看，是叫醒点自己踩在窗口边界上。
- 概率：每个槽约 1/60 会落进最后一分钟；窗口越少，撞上的那天就是整轮丢。

## 完整逻辑

- **链路**：`night plan`（CLI，每次由插件 span）→ `buildNightSchedule()` 生成 slots → 写
  `whale-night.json` → 插件 60s tick 读状态，到点提交唤醒。
- **机制**：排程用「分钟」精度、tick 用「60 秒」粒度；窗口闭环判定用 `end <= now`。
  当 `at` 与 `end` 相差不足一个 tick，就必然出现「还没叫醒、窗口已经关」。
- **爆炸半径**：只影响那一轮（当天少一次）、不写坏数据；属于静默失败（她自己也不知道被跳过）。
- **取舍**：
  - A：tick 判定加宽限（窗口结束后 2 分钟内还允许叫醒）——会破坏"窗口过了不补醒"的约定；
  - B：**排程时把点压到 `end - 2`**（选这条）——不改运行时语义，只保证叫醒点留足一个 tick 的余量。
- **生效与重启**：`whale-night.mjs` 是每次 spawn 的 CLI，改完下一次 `night plan` 就生效，不需要重启 DSH。

## 修法

```js
const latest = Math.max(w.start, w.end - 2);       // 最后一分钟不排
const desired = Math.min(w.start + i * seg + random() * seg, latest);
```

落不下时的 fallback 也同步改成 `Math.min(latest, ...)`，避免兜底又把点推到 `end - 1`。

## 验证

- `scripts/test-night-schedule.mjs` 新增边界用例：单窗口 + `random() = 0.999` 时，
  `at <= end - 2` 且仍在窗口内；原有 13 条断言全部通过。
- 复算今天这个窗口：`random ≈ 0.997` → 现在会被压到 22:58，60s tick 一定能捕到。

## 遗留

- 今天 22:00–23:00 这一轮**不补**（设计就是"窗口过了不补醒"），今天 B 站那边少一次。
- 如果以后窗口长度本身 ≤2 分钟，`latest` 会退化成 `start`，届时需要重新考虑 tick 粒度。
