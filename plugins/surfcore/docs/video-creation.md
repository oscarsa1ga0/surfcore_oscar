# 视频创作（本地剪辑与自主审片）

> 阶段二以 `feat/video-creation@499f246` 为基线。支持本地创作与导出，视频投稿属于第三阶段。

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
video-project show-plan <id> --revision <n>                  读取当前计划
video-project revise <id> --expect-revision <n> --patch-file <文件>  生成修订版
video-project compare <id> --from <n> --to <n>                查看差异和工件复用
video-project review <id> --revision <n> --decision keep|revise|shelve [--reason <理由>]
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
      "duration": { "mode": "voice", "minMs": 4000, "tailMs": 400, "gapMs": 800 },
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

约束：总长 15–90s（按配置 `video.maxDurationSec`）、最多 12 场景（`video.maxScenes`）；voice 镜头按时长取实测语音+句间停顿（`gapMs`，默认 800ms）+尾留白再按 30fps 对齐；fixed 镜头旁白放不下报 `VIDEO_SCENE_TOO_SHORT`（带缺口毫秒数，含句间停顿）；字幕超长按句意拆分、按字数占比切分整句时长（不重叠）。

## 素材与混剪

在「设置 → SurfCore → 视频创作」开启并保存后，打开「创作素材库」。导入本机视频、配乐、音效或图片时填写原创说明，或提供出处和授权说明。导入探测本地音视频流、时长及画幅。保存文件内容摘要和授权；撤销后旧片仍可预览，新的渲染会要求换素材。直接引用观看缓存会被拒绝。阶段一登记的头像和卡片继续可用。

- 视频镜头在 `visual` 写 `inMs/outMs`，用 `duration: {"mode":"clip"}` 令镜头长度取裁切后的时长。默认保留画面，`"audio":"mix"` 才混入该段原声。
- 顶层 `audioTracks` 支持 `{"kind":"music","assetId":"a_…","startMs":0,"inMs":500,"outMs":15500,"gainDb":-18}`。`kind` 可用 `sfx`；相同时间重合的轨道会叠加。旁白存在时自动压低配乐，混音目标约 −16 LUFS。
- `transitionOut` 支持 `cut` 和 `{"kind":"fade_black","durationMs":500}`，淡入淡出在相邻镜头内进行，总时长不变。
- 素材限本地普通文件。导入上限 100 MiB / 30 分钟，视频画幅最高 4096×4096。设置页记录的是使用者提供的授权信息；真实授权仍须由使用者核对。上传前的来源和公开权限留到投稿阶段验收。

## 审片与修订

渲染完成后，`preview --json` 返回关键帧的绝对时码、旁白试听、逐句稿、字幕和质检。设置页可以在两个版本的播放器间对照，并展开关键帧和质检提示。鱼姬可以用 `read_image` 看画面，语音试听用本机页面；模型当前支持的审片方式由会话可用能力决定。质检提示可能存在字幕过短、截断或黑场，鱼姬自行选择是否修正。

`review --decision revise --reason "第二个镜头缩短 1 秒"` 保存意见。然后给 `revise --patch-file` 一份 JSON，例如：

```json
{
  "scenes": [{"id": "s02", "visual": {"outMs": 5000}}],
  "cover": {"headline": "换个标题"}
}
```

修订保留旧版，换图时可将原片段的 `inMs/outMs/audio` 设为 `null` 以删除它们。大幅调整镜头顺序或增删镜头用原有 `save`。比较新旧版后，鱼姬可选 `keep`、`revise` 或 `shelve`，说明理由。旧版本可以读、播和比较，审片动作只更新当前版本。两项视频开关都打开时，B 站生物钟和手动唤醒会提示鱼姬考虑这个流程。

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
| `GET /projects/:id/revisions/:n/artifacts/:kind` | mp4/cover/srt/preview-grid/preview/manifest/qa/narration/frame-<镜头id>，支持 Range |
| `GET /projects/:id/compare?from=1&to=2` | 版本差异、时长与缓存复用 |
| `GET /assets` / `POST /assets` | 角色素材列表 / 授权导入 |
| `POST /assets/:id/revoke` | 撤销新剪辑使用，保留旧稿 |
| `POST /projects/:id/retry` | 重试任务（终态回队列） |
| `POST /projects/:id/shelve` | 搁置并取消待执行任务 |
| `POST /projects/:id/approve` | 阶段三开放（当前 501） |

## 配置（bili.config.json → `video`，全部默认关闭）

`enabled=false`、`offerOnWake=false`、`publishMode='draft'`（confirm/auto 阶段三生效）、`maxProjects=3`、`concurrentRenders=1`、`maxDurationSec=90`、`maxScenes=12`、`maxOutputMB=100`、`videoDirMaxMB=2048`、`dailyTtsChars=5000`、`dailyRenderSeconds=600`、`renderTimeoutMs=600000`。

## 测试与回滚

- `npm run test:video`：本地 fixture（临时 DSH_HOME，不碰真实账号/云端 TTS），包含第一阶段出片和恢复，以及混剪、素材授权、审片、缓存复用和预算断言；依赖 Homebrew ffmpeg/ffprobe 与带 Pillow 的 Python。
- 依赖体检：Node ≥22.5（node:sqlite）、ffmpeg/ffprobe、Pillow + 中文字体（PingFang/Noto CJK），缺项时渲染任务带可读错误。
- 回滚：功能默认关闭；关闭 `video.enabled` 即停执行器。本地项目库与已出片文件保留；本阶段无任何远端写。

资源预算按上海时间累计。只在实际调用 TTS 时记字数；重新编码时以项目时间轴记一次渲染秒数，纯换封面能复用 MP4 编码。由于一个任务会写临时媒体，目录体积在任务检查点核对；硬链接只按一份文件计空间。UI 出片与对照复用现有管理入口。

重开 DSH 后加载插件和页面。旧数据库使用增量建表，旧版本的 MP4 和素材不迁移；首次运行新渲染器会生成独立项目缓存。回退可停用视频并使用上一版插件，保留数据库、历史成片和素材。仅阶段二的新剪辑字段需在支持相应字段的版本中重新渲染。
