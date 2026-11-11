# SurfCore · 一条肥鱼，四个入口

**中文** | [English](README.en.md)

在 DeepSeek Harness（DSH）里养同一个角色。肥鱼可以刷 B 站、在桌宠窗口跟你聊天，也能接入微信私聊和 QQ。四个入口都沿用 SurfCore 当前角色的人设、长期记忆和作息，记忆的读取和分享遵守各渠道的隐私范围。

| | |
| --- | --- |
| 版本 | `0.8.9` |
| 目标 DSH | `0.2.1-rc.2 或更新（rc.3 已能安装，功能未完整回归）`（`npm run verify:adaptation` 可逐项复核） |
| 平台 | Windows（QQ / B 站 / 桌宠）、macOS（QQ / 微信私聊 / B 站 / 桌宠） |
| 许可 | MIT（QQ 网关和桌宠组件需单独安装） |
| 配套仓库 | [surfvoicelocal](https://github.com/Mieksido/surfvoicelocal) · [surfvoicecloud](https://github.com/Mieksido/surfvoicecloud) · [surfpet](https://github.com/Mieksido/surfpet) |

> 🔒 **本仓库不含任何真实数据**：角色卡是脱敏示例（`roles/`），记忆卡是空壳（`examples/`），
> 群号 / 群友名单 / QQ 号 / B站 mid 全部为占位符。运行时数据永远只在你自己的机器上。

---

## macOS 快速开始

先安装并打开一次 DSH 桌面端。退出 DSH 后，在终端运行以下命令，取本 fork 的功能分支并注册到 `desktop` 配置。

```sh
git clone --branch feat/macos-wechat https://github.com/oscarsa1ga0/surfcore_oscar.git
cd surfcore_oscar
npm ci
QQ_BRIDGE_SKIP_DSH_INSTALL=1 node scripts/setup-dsh.mjs desktop
```

需要 Node.js ≥22.13。只有 DSH 自带的 Node 时，可用 [DSH 自带运行时安装步骤](docs/cases/2026-11-11-macos-qq.md#配置) 代替上面最后两行。已经链接过此目录时，更新代码后完全退出并重开 DSH。

进入 **设置 → SurfCore**。「概览」会显示当前角色和四个入口的状态，点入口即可打开设置。

| 入口 | 第一次怎么开 |
| --- | --- |
| 微信私聊 | 在「微信」页获取二维码，扫码确认后点「启用接收」。从绑定的微信发来一条文本。[微信配置](docs/cases/2026-11-11-macos-wechat.md) |
| QQ | 在 LLBot 登录 QQ，开启 OneBot 11 的 HTTP 和正向 WebSocket。在「QQ」页填地址、token 和白名单，再打开「启动 QQ」。[Mac QQ 配置](docs/cases/2026-11-11-macos-qq.md) |
| B站 | 在「B站」页通过 Chrome 或 Edge 扫码登录，按需开启生物钟。 |
| 桌宠 | 在「桌宠」页安装 SurfPet 和与本机架构匹配的 Electron，然后启动。 |

各入口按需启用。切换「角色」后，四个入口会使用新角色的资料。想让肥鱼主动联系你，可以在「目的」页选择微信私聊、QQ 或桌宠。

Windows 的 QQ 网关用 SnowLuma，安装命令见 [Windows 安装](#二windows-安装)。

---

## 目录

- [一、这是什么](#一这是什么)
- [二、Windows 安装](#二windows-安装)
- [三、日常使用](#三日常使用)
- [四、能力总览](#四能力总览)
- [五、架构](#五架构)
- [六、文档地图](#六文档地图)
- [七、安全与边界](#七安全与边界摘要)
- [八、常见问题（FAQ）](#八常见问题faq)
- [九、开发](#九开发)
- [十、许可与合规](#十许可与合规)

---

## 一、这是什么

`surfcore` 插件在 DSH 里运行，负责角色、记忆、微信私聊、B站 生物钟和桌宠接口。启用 QQ 时，独立的 `src/bridge.js` 负责 QQ 收发、会话映射、控制台和安全闸门。

肥鱼可以：

1. **在 QQ 里当一个群友**：自己判断要不要看、要不要说、说几条、引用谁；说完能判断"这段可以结束了"，带着"下次怎么接"潜水。
2. **在 B站 当一个用户**：有自己的作息、偏好、每日额度；看视频会打分、会评论、会回帖、会发动态。
3. **记得住也忘得掉**：一份会衰减的记忆卡（进提示词）+ 一份永不遗忘的全量卡（只存档）。
4. **会主动找你**。按「目的」页设定的节奏和安静时段，可经微信私聊、QQ 或桌宠主动联系你。
5. **可以在桌面聊天**。Electron 桌宠支持文字和语音对话，也能接收主动搭话的气泡。
6. **可以在微信私聊**。扫码绑定本人微信后，通过腾讯 iLink 接收文本，并按当前角色与私聊规则回复。

> 它**不做**：不代你登录/扫码/绕过平台风控，不做多用户，不把控制台暴露到内网以外，
> 不删除任何不可恢复的数据。完整边界见 [BOUNDARIES.md](docs/guides/BOUNDARIES.md)。

---

## 二、Windows 安装

### 2.1 环境要求

| 需要 | 版本 / 说明 | 必装？ |
| --- | --- | --- |
| Windows | 10/11（沙箱 ACL 与 `.bat` 启动器按 Windows 写） | ✅ |
| Node.js | **≥ 22.13**（`node -v` 确认） | ✅ |
| DeepSeek Harness（DSH） | **`0.2.1-rc.2 或更新（rc.3 已能安装，功能未完整回归）`**，能正常打开 Web GUI | ✅ |
| SnowLuma2 | 第三方 QQ 运行时，**自己去官方 Releases 下载**并扫码登录 | ✅（只收 QQ 才需要） |
| 语音引擎 | 两个配套仓库之一（本地/云端） | ⭕ 可选 |
| 桌宠 | 配套仓库 `surfpet` | ⭕ 可选 |

> ⚠️ **SurfCore 不下载、不安装、不打包 SnowLuma**（EULA §5.4）。它只做"检测已安装 + 一键打开窗口 + 连接状态"，
> 登录与扫码始终由你自己完成。

### 2.2 五步装好

> 第一次装、或卡在某一步：看 [INSTALL.md](docs/guides/INSTALL.md)（手把手，含 SnowLuma 配置、白名单、排错表）。

```bash
# 1) 取代码
git clone --branch feat/macos-wechat https://github.com/oscarsa1ga0/surfcore_oscar.git
cd surfcore_oscar

# 2) 装依赖（postinstall 会自动修补 @snowluma/sdk 的 ESM bug）
npm install

# 3) 复制配置模板，然后编辑 config.json（见 2.3，只填 4 处）
#    Windows CMD: copy config.example.json config.json
cp config.example.json config.json

# 4) 装进 DSH（preset + 三个 MCP server + surfcore bundle，幂等，可重复跑）
node scripts/setup-dsh.mjs

# 5) 重启 DSH → 设置里出现 SurfCore →
#    在「概览」点「启动QQ」（或命令行 npm start / start.bat）
```

`setup-dsh.mjs` 做三件事：

1. 把 `qq-chat` / `qq-chat-v2` 两条 **agent preset** 插进 DSH profile（DSH 0.1.7 起的 bundle patch 机制）；
2. 在 profile 的 `cordis.patch.yml` 挂 **三个 MCP server**（QQ 工具 / SnowLuma 探活 / 只读联网搜索）；
3. 在 profile `package.json` 注册唯一一个 bundle：`surfcore`。

> 需要装到别的 profile：`node scripts/setup-dsh.mjs <profile名>`（默认 `web`）。

### 2.3 最小配置（只填这 4 处）

打开仓库根目录的 `config.json`：

| 位置 | 填什么 | 不填会怎样 |
| --- | --- | --- |
| `snowluma.wsUrl` / `httpUrl` / `accessToken` | SnowLuma 的 OneBot WS、HTTP、token（**HTTP 与 WS 可能是两个不同的值**） | 桥接连不上 QQ，控制台显示"未连接" |
| `ownerQQ` | 你自己的 QQ 号（`closed-agent` 模式只认这个人） | 管理员功能失效 |
| `allow.private` / `allow.groups` | 允许她接触的私聊/群（数组） | **白名单为空 = 谁都不响应**（不是全放行） |
| `consoleToken` | 控制台令牌；留空会自动生成到 `state/console-token` | 控制台需要令牌才能进 |

最小可用示例（把占位符换成你的）：

```jsonc
{
  "snowluma": { "wsUrl": "ws://127.0.0.1:3001", "httpUrl": "http://127.0.0.1:3000", "accessToken": "<SnowLuma token>" },
  "ownerQQ": 1000000001,
  "allow": { "private": [1000000001], "groups": [100000004] },
  "consoleToken": ""
}
```

> 其余几百个键都有默认值，全部含义见 [DATA-AND-CONFIG.md §1](docs/guides/DATA-AND-CONFIG.md)。
> 装好之后**建议一切都在设置页里改**（保存即生效，且会自动备份）。

### 2.4 首次验证

```bash
npm run test:audit                              # 离线回归（不联网、不发消息）
node scripts/check-onebot-status.mjs            # OneBot 连通性（只读）
node scripts/verify-dsh-020-adaptation.mjs      # 对本机 DSH 版本逐项复核
```

真机验证三件事：**在群里 @ 她 → DSH 里出现对应会话 → 回复回到 QQ**。

### 2.5 安装常见失败

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 设置页找不到 SurfCore | bundle 没装上 / DSH 没重启 | 重跑 `setup-dsh.mjs`，重启 DSH |
| 桥接起来了但收不到消息 | SnowLuma 未登录 / token 不对 / WS 端口不是 3001 | 控制台「运行总览」看状态；对照 `config.json` 的 `snowluma.*` |
| 群里 @ 她没反应 | 白名单没加这个群 / 模式不对 / 已暂停 | 看「访问与安全」页；确认 `allow.groups` |
| agent 只会说话、不调工具 | MCP 没挂上 / 工具被安全守卫隐藏 / 工具开关关了 | 重跑 `setup-dsh.mjs`；看设置页工具开关 |
| 控制台 401 | 没带令牌 | 用 `http://127.0.0.1:3100/?token=<consoleToken>` |
| `npm install` 后启动报 ESM 错 | postinstall 补丁没跑 | `npm rebuild` 或手动 `node scripts/patch-snowluma-sdk.mjs` |

更多故障与恢复见 [BOUNDARIES.md §3](docs/guides/BOUNDARIES.md)。

---

## 三、日常使用

### 3.1 设置页（DSH → 设置 → SurfCore）

概览显示当前角色和四个入口的状态。点击「微信私聊」「QQ」「B站」或「桌宠」可直接打开对应设置。
逐个说明见 [UI-AND-CONSOLE.md](docs/guides/UI-AND-CONSOLE.md)。

### 3.2 四种运行模式

| 模式 | 她是谁 | 能干什么 |
| --- | --- | --- |
| `chat` | 群友 | 白名单内聊天，工具面受安全守卫限制 |
| `closed-agent` | 只理管理员 | 私聊 owner，可用完整 DSH 工具 |
| `reserved` | 一代仿真群友 | 状态机 + 空格分条 + `[SILENT]` |
| `reserved2` | 二代仿真群友（**默认**） | 一切皆工具：自己看消息、发言、等待、潜水、收尾 |

### 3.3 让她主动找你（可选）

设置页「目的」：选载体（微信私聊 / QQ / 桌宠）、节奏、安静时段；先点**预览**（零副作用）再"试一次"。
硬闸门：安静时段 / 每日上限 / 主人在聊 / token 额度 / 专注模式。

### 3.4 可选装语音

两个独立仓库（[surfvoicelocal](https://github.com/Mieksido/surfvoicelocal) / [surfvoicecloud](https://github.com/Mieksido/surfvoicecloud)），装在仓库**外面**：

| 仓库 | 端口 | 特点 |
| --- | --- | --- |
| `surfvoicelocal` | 8765 | 本地 GPT-SoVITS，免费、断网可用 |
| `surfvoicecloud` | 8767 | 云端声音复刻，质量最好、按字符计费 |

装法：`git clone` 到 `surfcore/state/voice-packs/voice-local`（或 `voice-cloud`）→ 按该仓库 README 下载模型 →
`run.bat` → 回到 SurfCore **设置 → 语音** 选本地/云端并点「启动」。
**AI 发语音默认关闭**（`socialV2.voice.enabled=false` + 工具开关 `tools.sendVoice`），要显式打开。

> 模型不进 GitHub（太大）。仓库里只有启动脚本、配置与说明；模型按各自 README 的 `fetch-models` 下载。

### 3.5 可选装桌宠

[surfpet](https://github.com/Mieksido/surfpet)：Electron 桌面分身（Release 里有安装包）。**用户装 Release 的 zip，开发者 clone 源码自己构建。**

装法：设置页 **桌宠** → 填 zip 地址/目录 → 安装 → 选 `electron.exe` → 启动。
装好后：右键「文本对话 / 语音对话」，气泡上所有她的话都有「回复」按钮，右键/托盘有**专注模式**。

> 桌宠通过 `~/.dsh/surfcore/pet/host.json` 发现插件接口（本机 + 一次性令牌），不需要 DSH 的登录态。

### 3.6 B站（可选）

设置页 **B站** → 扫码登录 → 填作息窗口（例如 `20:00–24:00`）→ 选偏好 → 设额度。
她会在窗口内自己看视频、打分、评论、发动态；**默认不分享到 QQ**（可开）。

### 3.7 角色与记忆

- **角色包** = 人格卡 + 记忆卡 + B站 行为账本，整包切换。
- 新建：设置页「角色」→ 新建（或复制 `examples/character/` 到 `~/.dsh/surfcore/characters/<id>/`）。
- 记忆：QQ/B站/桌宠 三个场景写进**同一张卡**；每 10 分钟摄取一次，会衰减、会遗忘、80/90/100% 告警。
- 示例人格卡在 `roles/`（已脱敏），记忆卡空壳在 `examples/`。

### 3.8 浏览器控制台（可选）

`http://127.0.0.1:3100/?token=<consoleToken>`：运行总览、会话与审批、令牌与花费、访问与安全、调试与运维、工具参考。
只接受本机回环访问。

### 3.9 检查更新

**设置 → 概览 → 更新**：一次同时查 SurfCore / 两个语音包 / 桌宠。

- 本体与语音包走 **git**（`fetch` 只读 + `merge --ff-only`；本地有改动会拒绝）；
- 桌宠走 **Release 的 `version.json`**（比版本号 → 下 zip → sha256 校验 → 替换，**保留 `data/`**）；
- DSH 启动后 20 秒自动查一次，有更新时打开概览会弹窗，可勾「不再提示本次」。

---

## 四、能力总览

| 子系统 | 你能看到的能力 | 细节 |
| --- | --- | --- |
| **QQ** | 群/私聊收发、引用回复、分条、表情包、图片/动图、语音、拍一拍、合并转发展开、上线补历史、提问/审批回传、四种运行模式 | [MODULE-BRIDGE.md](docs/guides/MODULE-BRIDGE.md) |
| **B站** | 扫码登录、看视频/打分/收藏、评论与回帖、发动态、分享到 QQ、私信、直播间监听、34 个 CLI 命令 | [SUBSYSTEM-BILI.md](docs/guides/SUBSYSTEM-BILI.md) |
| **记忆** | 衰减卡（清晰度/遗忘/容量告警/压缩）、全量卡（append-only）、三场景共享、隐私 scope、双向记忆 | [MEMORY_CARD.md](docs/guides/MEMORY_CARD.md) |
| **人格** | 多角色整包切换、自动存档/回档、管理员双身份、身份对齐 | [CHARACTER_PERSONA.md](docs/guides/CHARACTER_PERSONA.md) |
| **微信** | 扫码绑定本人微信、文本私聊、暂停接收、主动搭话 | [微信配置](docs/cases/2026-11-11-macos-wechat.md) |
| **主动** | 目的机制、微信私聊 / QQ / 桌宠载体、对话收尾 | [PURPOSE_OUTREACH.md](docs/guides/PURPOSE_OUTREACH.md) |
| **语音** | 语音库发送、本地/云端 TTS 现场合成、语音包安装启停、音量/响度、频率上限；`qq_send_voice` / `qq_list_voices`（**AI 发语音默认关闭**） | [SUBSYSTEM-VOICE.md](docs/guides/SUBSYSTEM-VOICE.md) |
| **桌宠** | 文本/语音对话、气泡与回复按钮、专注模式、目的载体、断线重连 | [SUBSYSTEM-PET.md](docs/guides/SUBSYSTEM-PET.md) |
| **额度** | 每日 token 额度（QQ/B站/其他/总额，双单位，80% 提醒、100% 停）、消费看板 | [DATA-AND-CONFIG.md](docs/guides/DATA-AND-CONFIG.md) |
| **工具面** | 39 个 `qq_*` 工具、三个 MCP server、两代 preset、fail-closed 工具守卫 | [AGENT-TOOLS-AND-PRESETS.md](docs/guides/AGENT-TOOLS-AND-PRESETS.md) |
| **界面** | DSH 设置页、QQ 控制台 | [UI-AND-CONSOLE.md](docs/guides/UI-AND-CONSOLE.md) |

---

## 五、架构

| 入口 | 连接路径 |
| --- | --- |
| 微信私聊 | 腾讯 iLink → SurfCore 插件 → 当前角色 |
| QQ | OneBot 11 网关 → SurfCore QQ 桥接 → DSH 会话与当前角色 |
| B站 | SurfCore 生物钟与 B站 工具 → 当前角色的行为与记忆 |
| 桌宠 | SurfPet → SurfCore 桌宠接口 → 当前角色 |

macOS 用 LLBot 提供 QQ 网关，Windows 用 SnowLuma。角色切换与记忆维护仍由 SurfCore 管理。

- **两套状态根**：桥接数据在 `<仓库根>/state/`，插件数据在 `~/.dsh/surfcore/`。
- **三份配置**：`config.json`（QQ）、`~/.dsh/surfcore/config.json`（合体层）、`~/.dsh/surfcore/bili.config.json`（B站）。
- **DSH 端口会漂移**：桥接与插件都用 `discoverDshBaseUrl()` 发现，不要硬编码。

完整说明（含 6 条数据流与重启矩阵）：[ARCHITECTURE.md](docs/guides/ARCHITECTURE.md)。

---

## 六、文档地图

> **2026-10-26 全仓库逐行梳理**：12 篇、约 8,700 行、3,150 处 `文件:行号`。

| 步 | 读什么 | 读到什么程度 |
| --- | --- | --- |
| 1️⃣ 5 分钟 | **本文** | 它是什么、怎么装 |
| 2️⃣ 15 分钟 | [ARCHITECTURE.md](docs/guides/ARCHITECTURE.md) | 几个进程、怎么分层、改什么要重启什么 |
| 3️⃣ 按需 | 下面分册 | 改哪个子系统翻哪本 |

| # | 文档 | 行数 | 什么时候翻它 |
| --- | --- | --- | --- |
| 1 | [ARCHITECTURE.md](docs/guides/ARCHITECTURE.md) | 335 | 总纲 |
| 2 | [DATA-AND-CONFIG.md](docs/guides/DATA-AND-CONFIG.md) | 351 | 三份配置每个键、约 95 个状态文件 |
| 3 | [BOUNDARIES.md](docs/guides/BOUNDARIES.md) | 181 | 做不到什么、坏了怎么恢复 |
| 4 | [MODULE-BRIDGE.md](docs/guides/MODULE-BRIDGE.md) | 1,020 | 桥接全文 |
| 5 | [MODULE-CORE-A.md](docs/guides/MODULE-CORE-A.md) | 1,001 | 记忆/人格/目的/收尾/额度/账本/计价/身份 |
| 6 | [MODULE-CORE-B.md](docs/guides/MODULE-CORE-B.md) | 1,098 | B站/鱼群/表情/黑话/文本化/SSRF/DSH 客户端 |
| 7 | [MODULE-PLUGIN.md](docs/guides/MODULE-PLUGIN.md) | 1,101 | 插件宿主：装配、配置模型、设置页 API、B站 调度 |
| 8 | [UI-AND-CONSOLE.md](docs/guides/UI-AND-CONSOLE.md) | 677 | 设置页 14 标签 + 控制台 10 页 |
| 9 | [SUBSYSTEM-VOICE.md](docs/guides/SUBSYSTEM-VOICE.md) | 855 | 语音三条链路 |
| 10 | [SUBSYSTEM-PET.md](docs/guides/SUBSYSTEM-PET.md) | 904 | 桌宠全链路 |
| 11 | [SUBSYSTEM-BILI.md](docs/guides/SUBSYSTEM-BILI.md) | 981 | B站 34 命令 / 23 库 |
| 12 | [AGENT-TOOLS-AND-PRESETS.md](docs/guides/AGENT-TOOLS-AND-PRESETS.md) | 233 | 39 个工具、守卫、两代 preset |

其它：DSH 装配 [DSH_SETUP.md](docs/guides/DSH_SETUP.md) · 安全基线 [SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md) ·
踩坑 [PITFALLS.md](docs/PITFALLS.md) · 风险台账 [RISK_REGISTER.md](docs/RISK_REGISTER.md) · 全部索引 [docs/README.md](docs/README.md)。

---

## 七、安全与边界（摘要）

- **群友碰不到你的机器**：仿真会话的工具面是白名单、fail-closed，本地执行能力全部被 restrict。
- **发送必须命中白名单**：没有"管理员例外"这种后门。
- **控制台只接受本机回环** + 令牌（定长比较）+ Host/Origin 校验 + 写操作强制 JSON。
- **密钥不落日志**；`state/` 用 icacls 切断 ACL 继承。
- **不可逆删除 = 事故**：清理一律先隔离到 `_backups/`。
- **不承诺**提示注入的语义层 100% 防护（真正的边界是工具面与白名单）。

详见 [SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md)、[BOUNDARIES.md](docs/guides/BOUNDARIES.md)、[RULES.md](RULES.md)。

---

## 八、常见问题（FAQ）

| 问题 | 回答 |
| --- | --- |
| QQ 要装什么？ | macOS 用 LLBot，Windows 用 SnowLuma。只用微信、B站或桌宠时，可保持 QQ 关闭。 |
| 能不用 DSH 吗？ | 不能，插件与 preset 都跑在 DSH 里。 |
| 会自己发消息吗？ | 默认不会。主动搭话要显式开「目的」；二代下发言必须调工具。 |
| 数据会上传吗？ | 只有拼进提示词的文本会发给模型 API；不想让黑话词条出机就关 `slang.autoResearch`。 |
| 支持 Linux/macOS 吗？ | macOS 可通过 LLBot 的 OneBot 11 接入 QQ，并支持微信私聊、B 站与桌宠。Linux 暂无安装说明。 |
| 能多用户/远程吗？ | 不做。控制台只接受回环。 |
| 语音包和桌宠是必装项吗？ | 两个都可以按需安装。「目的」页可以另选微信私聊或 QQ。 |
| 改名/换角色会丢记忆吗？ | 不会。角色包整包隔离，切换带快照，可回档。 |

---

## 九、开发

```bash
npm run test:audit              # 默认门禁（75 个脚本，离线）
npm run test:regressions        # 桥接/协议回归
cd plugins/surfcore && npm test # 插件侧（含更新检查、桌宠更新保留数据的回归）

npm run privacy-scan:strict     # 发布前隐私扫描（0 命中才可发布）
npm run guard:check             # DSH 升级后先跑（asar 会话护栏补丁是否还在）
node scripts/setup-dsh.mjs      # 重装 preset + MCP
```

目录结构见 [docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)；代码分层与"改什么要重启什么"见
[ARCHITECTURE.md](docs/guides/ARCHITECTURE.md)。

---

## 十、许可与合规

- 本仓库 **MIT**。
- **SnowLuma2 是第三方专有组件**，不随仓库分发、不打包；按 EULA §5.4，本程序不对它做安装/部署/代扫码。
- 请自行遵守 QQ / B站 服务条款与当地法律；本项目不提供绕过风控的能力。

> 老版本（≤0.6.18）无法自动更新：用 [强制更新提示词.txt](dist/强制更新提示词.txt)（复制给 DSH）或 [在线版说明](docs/guides/FORCE_UPDATE_PROMPT.md)。
