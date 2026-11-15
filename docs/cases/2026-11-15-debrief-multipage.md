# B站多 P 视频支持 `--page N`

## 背景

- 用户发现看多 P 视频（赛事回放：第一局/第二局/…/赛后采访）时，她只能看到第一 P。
- 根因：`debrief` 和 `bili-watch` 都直接用 view 接口的 `data.cid`，那是**第一页**的 cid；字幕、弹幕、抽帧全绑在这一个 cid 上，也没有列分 P。

## 做法

- `commands/debrief.mjs`：
  - 新增 `--page N`（默认 1），从 `data.pages[N-1].cid` / `.duration` 取；
  - 元信息里打印「分P: X 个 · 当前第 N P：标题（时长）」和一行分 P 列表（最多 12 个，超出省略）；
  - 越界时报「这个视频只有 X P，没有第 N P」；
  - 把 `--page` 透传给 `bili-watch`。
- `commands/bili-watch.mjs`：
  - 解析 `--page N`（先把值从参数表里摘掉，避免 "2" 被当成格子参数）；
  - 用 `pages[N-1].cid` 拿 playurl、按该 P 时长取帧；
  - 下载文件名带 `-pN-`，避免和第一 P 混淆。

## 验证

用 2 P 视频 `BV1i24P6rEmt`（创造模式 中文/英文）实测：

- `debrief BV1i24P6rEmt --page 2 --no-frames` → `分P: 2 个 · 当前第 2 P：Creator Mode-EN Version（01:40）`，弹幕里出现「自古2p没人看」，确认取的是第二 P；
- `debrief ... --page 9` → 正确报「这个视频只有 2 P」；
- `bili-watch BV1i24P6rEmt 3x3 --page 2` → 打印「分P: 2 个 · 当前第 2 P」，下载 `...-p2-....mp4`（8.42MB）并生成九宫格。

测试产生的 watch-history 两条和临时 mp4/封面已删除。

## 限制

- 默认仍只读第 1 P；要知道有哪几 P，看 `debrief` 输出的分 P 列表；
- 评论是整个视频共享的，所有 P 都能看到同一条评论区。
