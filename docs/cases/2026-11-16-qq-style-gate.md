# QQ 出门检查（AI 味规则）接入

## 需求

B站 评论的 `style-check.mjs` 规则也要用在 QQ 私聊和群聊；复述原话再评价算通用 AI 味。

## 结构

- 规则本体：`~/.dsh/surfcore/state/bili-agents/style-rules.mjs`（她平时改这份）
  - `general`：通用 AI 味，QQ 会拦
  - `comment`：只给 B站 评论（复述视频/复述对方话再留下），QQ 不看
  - `format`：格式偏好（直角引号、双引号），QQ 只提醒
- B站 侧 `style-check.mjs` 变成薄包装，行为不变（全部规则报错）；
- 桥接侧 `src/style-gate.js` 按 mtime 动态加载规则，`src/bridge.js` 在
  `sendMessagesV2`（覆盖 qq_send_message / send_burst / reply / private / group）
  和机器模式 `auditAndSend` 里检查。

## 配置

`config.json`：

```json
"socialV2": { "styleCheck": { "enabled": true, "mode": "warn", "minChars": 8 } }
```

- `warn`：命中照样发，返回里带 `styleWarn`；
- `block`：命中不发，工具报错让她改写；
- 少于 `minChars` 的短句跳过。

## 验证

- `scripts/test-qq-style-gate.mjs`：general/format/comment 分类、短句跳过、规则文件缺失放行；
- 默认规则路径下 `evaluateQqStyle('这不是风控，而是额度')` → hard 命中；
- 重启桥接后日志正常，发送链路未受影响。
