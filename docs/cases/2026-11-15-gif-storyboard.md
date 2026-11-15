# 动图（GIF / 动态 WebP）抽帧拼图

## 背景

- 她会说“今天两次了，你发个 gif 过来，我只拿到一张静止的”。
- 根因：桥接把原始动图按 `image/gif` 直接交给视觉模型，模型只解码第一帧；DSH/NapCat 没有动画解码。

## 做法

`src/bridge.js`（图片字节解析区，`fetchMediaData` 之前）：

- `gifStoryboard(buf, mimeType)`：
  - `ffprobe -count_frames` 取帧数和时长；`duration>10s`、`size>10MB`、`帧数<=1` 直接退回首帧；
  - 抽帧数 = `min(9, 帧数)`，网格按帧数自适应（≤2 用 2×1/2×2，≤4 用 2×2，≤6 用 3×2，否则 3×3）；
  - 采样用 `fps=frames/duration`，保证正好铺满格子（`select+step` 会在末格留空，实测过）；
  - 每帧 320×320、透明铺白、`tile` 拼接成一张 PNG；
  - 结果按 GIF 内容 sha1 缓存在内存（最多 30 条）。
- `fetchMediaData`：`image/gif` 或 VP8X 动画标志位为 1 的动态 WebP 走这条；成功则返回 `image/png` 拼图，并在 `text` 里写明「共 X 帧/Y 秒的动图，均匀抽了 N 帧，按行从左到右、按时间顺序」。
- ffmpeg 路径优先用 `socialV2.voice.ffmpegPath`，否则用 PATH 里的 `ffmpeg`。

## 验证

- 用 ffmpeg 生成 30 帧/3s、4 帧/1s、12s 三种 GIF 跑同一套算法：
  - 30 帧 → 9 帧 3×3，PNG 21KB；
  - 4 帧 → 4 帧 2×2；
  - 12s → 正确跳过（退回首帧）；
- 3×3 拼图读图确认：9 格全满、顺序正确。

## 限制

- 抽样可能漏掉一闪而过的关键帧；长动图（>10s）不拼图；
- 透明背景铺白，个别图会丢透明信息；
- 真实 QQ 动图链路（NapCat 取原图）这次没跑通测试：旧图片链接已过期，需要她下次收到动图时看桥接日志 `[动图] … → 抽 N 帧拼图` 确认。
