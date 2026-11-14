# 视频创作、审片与 B 站投稿

> 投稿沿用鱼姬的扫码登录。首次使用账号和分区时须确认一条稿件，创作中心回读验证通过后才可在该分区自主投稿。

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
- 素材限本地普通文件。导入上限 100 MiB / 30 分钟，视频画幅最高 4096×4096。设置页记录的是使用者提供的授权信息；真实授权仍须由使用者核对。要投稿的外部图片、视频和音频需在素材库登记时勾选「允许用于公开 B 站视频」。存量导入素材可用原文件重新登记权限。

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
| `POST /projects/:id/prepare-publish` | 按版本生成本地稿件包或待确认请求 |
| `POST /projects/:id/approve` | 确认账号、版本与稿件包后排队 |
| `POST /projects/:id/refresh-publish` | 复查审核或恢复尚未提交的任务。回执不明时可提供对账 BV |

## 配置（bili.config.json → `video`，全部默认关闭）

`enabled=false`、`offerOnWake=false`、`publishMode='draft'`、`publishTid=0`（未设分区）、`maxProjects=3`、`concurrentRenders=1`、`maxDurationSec=90`、`maxScenes=12`、`maxOutputMB=100`、`videoDirMaxMB=2048`、`dailyTtsChars=5000`、`dailyRenderSeconds=600`、`renderTimeoutMs=600000`。

## 投稿步骤

1. 在「设置 → SurfCore → 视频创作」填好 B 站创作中心的分区 ID，选择投稿档并保存。也可以在计划的 `submission.tid` 指定分区。稿件默认自制。如要转载，计划须有 `submission.copyright="repost"` 和 `submission.source` 来源链接。接口会向 B 站核对分区。
2. 用 `video-project review <项目> --revision N --decision keep` 完成审片。`video-upload <项目> --revision N --dry` 校验文件摘要和稿件信息。加 `--draft` 只存本地，`--go` 按当前模式处理。也可在版本页点「准备投稿」，它会生成供管理员核对的稿件。
3. 确认档在设置页核对版本、账号、分区、自制属性、标题、简介、素材和声明，再点「确认这版并投稿」。自主档首次会走同一确认流程。该账号和分区回读通过后，鱼姬主动调用 `--go` 才会自行排队。功能开关、沉默逛和素材撤销都会在远端写入前复查。
4. 上传中断可按分片回执继续。最终投递回执不明时，在创作中心查稿。可以将 BV 填入项目页辅助对账，后台仍须核对唯一视频媒体 ID。没有匹配项时保持待核实，刷新只继续查稿。审核通过且匹配公开账号后，写入作品日志并按已有通知渠道报备。通知不明时在页面提示核实。
5. 若 B 站返回需要补 AI 声明或发现创作中心字段变化，在创作中心修正后回项目刷新。仅有 BV 不代表账号/分区通过了自主投稿验收。

`video-upload status <项目> [--refresh] [--json]` 查看稿件。`--refresh` 由后台执行，当前结果会即时返回。

**账号范围。** 投稿使用现有鱼姬登录凭据。确认和自主权限在正常的 SurfCore 工具链生效。拥有系统级文件访问和 Shell 权限的管理员能自行调用外部程序，系统级隔离需使用受限的 DSH 会话。

**网页适配。** UPOS 分片和网页投稿依据现有方案和社区实现接入，B 站的 [AI 生成合成内容标识公告](https://www.bilibili.com/opus/1106496554576904197) 要求在站内声明。上传协议参考 [biliup](https://github.com/biliup/biliup/blob/master/crates/biliup/src/uploader/bilibili.rs) 和 [网页投稿字段](https://github.com/Lucas-Qh-Lai/bilibili-publish/blob/main/references/bilibili-upload-api.md)。第一次确认投稿是该账号上的真机验收；自动投稿依赖创作中心能回读本稿的声明、分区及自制属性。

## 测试与回滚

- `npm run test:video`：本地 fixture（临时 DSH_HOME，不碰真实账号/云端 TTS），包含第一阶段出片和恢复，以及混剪、素材授权、审片、缓存复用和预算断言；依赖 Homebrew ffmpeg/ffprobe 与带 Pillow 的 Python。
- 依赖体检：Node ≥22.5（node:sqlite）、ffmpeg/ffprobe、Pillow + 中文字体（PingFang/Noto CJK），缺项时渲染任务带可读错误。
- 回滚：功能默认关闭；关闭 `video.enabled` 即停执行器。本地项目库与已出片文件保留；已受理稿件保留本地审核记录，并可在创作中心查询。

资源预算按上海时间累计。只在实际调用 TTS 时记字数；重新编码时以项目时间轴记一次渲染秒数，纯换封面能复用 MP4 编码。由于一个任务会写临时媒体，目录体积在任务检查点核对；硬链接只按一份文件计空间。UI 出片与对照复用现有管理入口。

重开 DSH 后加载插件和页面。旧数据库使用增量建表，旧版本的 MP4 和素材不迁移；首次运行新渲染器会生成独立项目缓存。回退可停用视频并使用上一版插件，保留数据库、历史成片和素材。仅阶段二的新剪辑字段需在支持相应字段的版本中重新渲染。
