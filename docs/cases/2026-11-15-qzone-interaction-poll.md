# QQ 空间互动轮询：醒来时告诉她「有人评论了」

## 背景

- 用户问：「她 QQ 每次醒来主动看 QQ 空间吗」——答案是否。唤醒提示里只有工具清单和最近两条说说，没有新评论/点赞，桥接也不会在醒来时请求空间接口。
- 用户要：后台低频查她最近两三条说说的评论数，和上次比，有变化就在唤醒时加一句。

## 做法

- `src/qzone-state.js`：状态新增 `interactions`（tid → 上次评论数基线）和 `notices`（未投递提醒）。
- `src/qzone-gate.js`：新增 `interactionPoll: { enabled: true, minutes: 10 }`（最少 2 分钟）。
- `src/bridge.js`：
  - `scanQzoneInteractions()`：对她最近 3 条说说逐个 `get_qzone_msg_detail`，只比较 `comment_num`；第一次只建基线，之后涨了才生成提醒（带新评论者昵称）。
  - `startQzoneInteractionPoll()`：启动 25 秒后先扫一次建基线，之后每 60 秒看一次是否到了 `minutes` 间隔。
  - `qzonePromptLineV2()`：把未投递提醒拼成「【空间互动】《…》下多了 N 条评论（昵称）」，注入一次后标 `deliveredAt`。
  - 新增控制台端点 `POST /api/qzone/scan-interactions`（手动扫一次，方便测试/以后做按钮）。
- 只读：不点赞、不评论、不自动打开空间。

## 验证

- 临时「仅自己可见」说说：桥接发布 → 手动扫（基线 0）→ 发一条评论 → 手动扫 `notices: 1`、`pending` 里带 delta 和新评论者；测试说说已删除、状态与 `qzone-posts.jsonl` 已清。
- 重启后基线：`03be16b6cf29f76a1ff70c00` 评论数 2，无 pending。
- 没验证到：真实评论触发后的唤醒注入效果（需要真人在空间评论 + 她有下一轮唤醒）。

## 生效

桥接已重启（源码改动即时生效）；配置项 `socialV2.qzone.interactionPoll` 可在 `config.json` 调，改完重启桥接。
