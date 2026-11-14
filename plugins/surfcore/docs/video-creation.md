# 视频创作（阶段一：立项目与合成）

> 实现基线 `feat/video-creation`（自 `feat/macos-qq@7a131d3` 切出）。本阶段只做**本地创作与导出**，不投稿。

## 能做什么

鱼姬从空项目出发：建项目 → 登记素材（生成卡片 / 头像插画）→ 保存剪辑计划（JSON）→ 提交渲染任务 → 后台执行器出片（旁白 + 中文字幕 + 封面 + 九宫格试听）→ 设置页播放/导出。渲染被打断后重开 DSH 会从缓存续跑。

## CLI（node plugins/surfcore/tools/bili.mjs video-project …）

```text
video-project list                                            项目列表
video-project create --title <标题>                           新建项目
video-project save <id> --expect-revision <n> --plan-file <文件>  保存计划（CAS，版本冲突报 VIDEO_REVISION_CONFLICT）
video-project assets <id> [list]                              素材列表
video-project assets <id> register-card [--kind gradient|color|geometry] [--color …] [--accent …] [--text …]
video-project assets <id> register-image <文件> [--kind avatar|image] [--name …]
video-project render <id> --revision <n> [--wait]             提交渲染任务（幂等：同版本同任务）
video-project status <id> [--job <jobId>]                     状态/失败位置/下次重试时间
video-project preview <id> --revision <n>                     成片/封面/字幕/九宫格/镜头帧路径
video-project review <id> --revision <n> --decision keep|revise|shelve
```

所有命令支持 `--json`；失败统一 `{ok:false, code, error, hint}`。命令只读写**当前角色**的视频目录，角色未解析时报 `VIDEO_NO_CHARACTER`。

## 计划 schema（v1）

```json
{
  "schemaVersion": 1,
  "title": "…",
  "format": { "aspect": "16:9", "profile": "720p30" },
  "scenes": [
    { "id": "s01",
      "visual": { "assetId": "a_…", "fit": "contain|cover", "motion": "none|zoom_in|pan" },
      "duration": { "mode": "voice", "minMs": 4000, "tailMs": 400 },
      "lines": [ { "id": "l01", "speech": "…", "caption": "…" } ],
      "transitionOut": { "kind": "cut", "durationMs": 0 } },
    { "id": "s02",
      "visual": { "assetId": "a_…", "fit": "cover", "motion": "none" },
      "duration": { "mode": "fixed", "ms": 3000 },
      "lines": [], "titleCard": "打开工程的第一个晚上" }
  ],
  "cover": { "kind": "scene_frame", "sceneId": "s01", "offsetMs": 1000, "headline": "…" },
  "submission": { "description": "…", "tags": ["…"] }
}
```

约束：总长 15–90s（按配置 `video.maxDurationSec`）、最多 12 场景（`video.maxScenes`）；voice 镜头按时长取实测语音+尾留白再按 30fps 对齐；fixed 镜头旁白放不下报 `VIDEO_SCENE_TOO_SHORT`（带缺口毫秒数）；字幕超长按句意拆分、保留时间戳。

## 存储与执行

- 数据：`<DSH_HOME>/surfcore/characters/<id>/bili/video/projects.sqlite`（项目/版本/工件/素材/任务/投稿）；媒体在 `assets/<sha256>/` 与 `projects/<pid>/revisions/<n>/`。
- 版本 CAS：编辑产生新版本，旧版可预览；任务幂等 + 租约 + fencing，重启 `recoverOnStart()` 接管 running 任务。
- 执行器：`lib/video/worker.js`，由 `lib/index.js` 随插件生命周期启停（配置开关、角色切换、dispose 三处挂钩）；全机并发默认 1。
- 渲染链：`voice.js`（音色解析与桥接同源，独立 WAV 缓存，RIFF/时长校验）→ `py/caption-render.py`（Pillow 中文字幕贴图/标题卡/封面字）→ `render.js`（按镜头 FFmpeg 分段、字幕 overlay、合成 H.264+AAC yuv420p faststart、ffprobe 质检）→ 质检通过后原子落盘。
- 缓存复用前用 ffprobe 校验可读，半成品绝不进合成链（打断恢复的关键）。

## 管理 API（`/dsh-surfcore/api/bili/video`，复用管理路由的回环/同源/鉴权）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects` | 项目分页列表（阶段/任务状态） |
| `GET /projects/:id` | 版本、工件、任务、脱敏错误 |
| `GET /projects/:id/revisions/:n/artifacts/:kind` | mp4/cover/srt/preview-grid/preview/manifest/qa，支持 Range |
| `POST /projects/:id/retry` | 重试任务（终态回队列） |
| `POST /projects/:id/shelve` | 搁置并取消待执行任务 |
| `POST /projects/:id/approve` | 阶段三开放（当前 501） |

## 配置（bili.config.json → `video`，全部默认关闭）

`enabled=false`、`offerOnWake=false`、`publishMode='draft'`（confirm/auto 阶段三生效）、`maxProjects=3`、`concurrentRenders=1`、`maxDurationSec=90`、`maxScenes=12`、`maxOutputMB=100`、`videoDirMaxMB=2048`、`dailyTtsChars=5000`、`dailyRenderSeconds=600`、`renderTimeoutMs=600000`。

## 测试与回滚

- `npm run test:video`：本地 fixture（临时 DSH_HOME，不碰真实账号/云端 TTS），30 项断言含打断恢复；依赖 Homebrew ffmpeg/ffprobe 与带 Pillow 的 Python。
- 依赖体检：Node ≥22.5（node:sqlite）、ffmpeg/ffprobe、Pillow + 中文字体（PingFang/Noto CJK），缺项时渲染任务带可读错误。
- 回滚：功能默认关闭；关闭 `video.enabled` 即停执行器。本地项目库与已出片文件保留；本阶段无任何远端写。
