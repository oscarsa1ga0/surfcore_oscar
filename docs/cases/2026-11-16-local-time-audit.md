# 展示层时区审计：还有哪些地方把 UTC 当本地念

## 起因

11-16 晚她把 `d-20261116-001` 的 `updatedAt` 读成「15:36」，实际是 23:36。
修完 `diary_*` 工具后顺带把「还有没有别处一样」查了一遍。

## 结论：三类要分开看

| 类型 | 结论 |
| --- | --- |
| **存储** | 一律 UTC ISO（`iso()` / `toISOString()`）—— 正确，不动 |
| **日期比较 / day key** | 抽查 `memory-card.todayKey`、`quota.dayOf`、`watch-history.localDate`、`bridge.localDayKey` 等都是本地日期 → 没发现 UTC 比较导致的跨天错 |
| **展示（给模型或人看）** | 找到 6 处直接把 UTC 交给对方，已在本次修掉 |

## 修掉的展示点

1. `diary_write / read / search / list / edit`（上一提交 `3f06cb6`）；
2. `quota status` 的「最近记录」和「这个视频 7 天内已经分享过了（时间）」；
3. `fish-guard` 的「上次点赞（时间）」两处；
4. `comment` 的「N 天内已经回过（时间）」；
5. `fans --json` 的 `newFans[].at`（修前是 `10:39Z`，她看到的是 10:39，实际 18:39）；
6. `watch-history --json` 的 `items[].at`（修前 `12:01Z`，实际 20:01）；
7. QQ 空间面板「操作日志」在客户端里用 `String(x.at).slice(11,19)` 截 UTC 时:分:秒。

## 实现

新增 `src/local-time.js`：

```js
localIso('2026-11-16T15:36:42.887Z') // → 2026-11-16T23:36:42+08:00
localizeField(obj, 'at')
```

保留偏移量，机器仍可 `new Date()` 解析；**不保留毫秒**（展示层不需要）。

## 验证

- 实测：
  - `quota status` → `2026-11-16T23:10:40+08:00 comment …`
  - `fans --json` → `"at":"2026-11-16T18:39:11+08:00"`
  - `watch-history --json` → `"at":"2026-11-16T20:01:50+08:00"`
  - `diary_list` → `updated 2026-11-16T23:36:42+08:00`
- 新增 `scripts/test-local-time.mjs`（偏移量、瞬间一致、非法值、字段级转换），已登记进 `test-audit`。
- `test-audit` 145/159；失败 14 个都是既有的（语音重构残留、identity-guard 夹具禁网、release-manifest 等），与本次无关。

## 遗留

- epoch 字段（如 `dm-await` 输出的 `ts=1794…`）没有改成人类可读；她一般看 `dm-await` 的文本行，不受影响。
- 以后新增「给模型看的时间」请直接用 `src/local-time.js`，别再 `slice` ISO 字符串。
