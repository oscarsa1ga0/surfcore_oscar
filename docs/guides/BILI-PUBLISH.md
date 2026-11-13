# B站自由发布 / 原创专栏

> 状态：✅ 2026-11-12 实现（自由动态 + 原创专栏；原创视频上传预留接口，未实现）。
> 相关：`plugins/surfcore/tools/commands/free-post.mjs`、`commands/article.mjs`、
> `lib/article.mjs`、`lib/bili-posts.mjs`、`scheduler.js` 的唤醒流程、`BiliTab` 设置。

## 1. 产品定位

除了既有的「四类动态 / 每日分享」，她**自己**想发东西时可以额外发。**内容不限**，不一定是 B 站视频，也不一定非得是逛的时候：

- 刚刷到的视频 / 图片 / 站内链接；
- 一句突然想到的话、一个梗、一段吐槽；
- 日记里她愿意公开的一段：**B站侧的 `whale-diary` / `whale-diary-private`**，或**晚上用 `diary_write` 写的那本（`diary_*`）**都可以；B站会话可以用 `diary_list` / `diary_read` 读，公开时自己挑适合公开的段落；`diary_share` 只用于给主人看，不是公开发布授权；
- 和主人 / 群友聊完后的心得感悟（写自己的感受，不复述私聊原文）；
- 原创专栏（长文，先草稿再发布）。

形式上仍受 B 站动态支持的类型限制：文字 / 一张图 / 任意视频卡片 / 链接；长文用 `article`。

**这不是任务**：想发就发，不想发就不发；可以一天很多条，也可以很多天一条都不发。
不设每日上限；只和四类动态/分享/专栏共用「任意两条动态之间 ≥30 分钟」的防刷屏间隔。

### 最后一次 QQ 私聊 → B站 上线前摘要（2026-11-13）

- QQ 主人私聊 **close** 时，写单文件 `memory/qq-last-context.json`（每次覆盖）：
  - close 的 `summary` / `nextOpening`；
  - 当时 purpose 的 **drives 前 5 / goals 前 5**；
  - **每次 close 时由 QQ 鱼姬本人写 memorySummary（400~550 字，第一人称）**；B站上线前直接复用，不再额外调模型；
- B站**每次上线前**，由这份快照拼出 `memory/qq-for-bili-last.md`（单文件，每次覆盖），注入 B站唤醒：
  - 优先复用 close 时写好的 memorySummary；如果旧快照没有摘要，才由 B站上线前的小模型补写 450~550 字；
  - 有 md 且没有新 close 就复用，不重复调用；
  - 只限主人私聊，不写群聊/别人私聊；
  - 可用 `memory.qqLastContext.enabled=false` 关闭。
- 目的：让 B站侧的她还记得最后一次 QQ 对话结束时的记忆和目的，而不是“上线时重新编一个”。

### 隐私边界

这是**公开发布**：

- 可以写自己的感受；
- 不要复述 QQ 私聊原文，不要写主人/他人的 QQ 号、B站 mid、真实姓名、住址、联系方式；
- 日记只挑她愿意公开、且不含私密细节的一段。

B站会话默认**看不到 QQ 私聊**（`memory.qqToBili` 关闭，且只同步公开群消息）；如果聊天里的心得想变成公开动态，需要先由 QQ 侧写进日记，B站唤醒时从日记里挑一段安全的来发。QQ 预设没有本地工具，不能直接跑 `free-post`；实际发布在 B站会话完成。

原创视频**上传**暂未实现；`--bvid` 是分享/转发视频卡片，不是上传视频文件。
接口位置和后续要接的端点见 `commands/video-upload.mjs` 注释。

## 2. 命令

统一入口：`node bili.mjs <命令>`。

### 自由动态

```bash
# 文字
node bili.mjs free-post --text "今天看到…" --dry
node bili.mjs free-post --text "今天看到…" --go

# 一张图
node bili.mjs free-post --text "…" --image /path/a.png --dry|--go

# 任意视频卡片（不评分、不占分享额度）
node bili.mjs free-post --text "这条视频…" --bvid BV1xx411c7xx --dry|--go

# 站内链接（专栏/视频等）
node bili.mjs free-post --text "…" --link https://www.bilibili.com/read/cv123 --dry|--go
```

- `--dry`：只检查/打印，不发任何请求；
- `--go`：真正发布；成功输出 `dyn_id=` 和链接；
- `--text` 可以留空（例如只发一张图 / 只转发视频卡片），但 `--text/--image/--bvid/--link` 至少要有一个；
- 和四类动态/分享/专栏共用 `daily-dynamic.json` 的间隔；
- 发完写 `bili-posts.jsonl`、记 quota（type=free，只审计、不设上限）并 notify 报备。

### 原创专栏

```bash
node bili.mjs article --title "标题" --file 文章.md --dry
node bili.mjs article --title "标题" --file 文章.md --draft     # 只进草稿箱
node bili.mjs article --title "标题" --file 文章.md --go        # 发布（正文 ≥200 字）
node bili.mjs article --check <aid>
node bili.mjs article --delete <aid>
```

- 支持 Markdown（标题/段落/粗体/链接/图片/列表/引用/代码），也接受 HTML；
- `--draft` 只进草稿箱，不公开；`--check/--delete` 用来核对/清理草稿；
- `--go` 会先建草稿再 `submit`；正文 <200 字会被拒绝（B站专栏门槛）；
- B站每天最多 5 篇专栏，代码在 `--go` 前也会挡第 6 篇（草稿不算发布）；
- 可选 `--cover <图片>`、`--category <ID>`（默认 0 = B站默认分类）；
- 发完写 `bili-posts.jsonl`、记 quota（type=article）、notify 报备。

### 原创视频上传（预留）

`node bili.mjs video-upload` 会明确提示“未实现”，并打印以后要接的端点：
`member.bilibili.com/preupload` → 分片上传 → `x/vu/web/add/v3`。
当前分享视频请用 `free-post --bvid`。

### 视频弹幕（2026-11-13 新增）

```bash
node bili.mjs danmaku-video --bvid BV... --msg "…" --at 12 --dry
node bili.mjs danmaku-video --bvid BV... --msg "…" --at 12 --go
node bili.mjs danmaku-video --bvid BV... --retract <dmid>
```

- 发到**视频页**（`x/v2/dm/post`），不是直播间；`oid` 用视频 cid，自动从 `x/web-interface/view` 取；
- `--at` 是视频内秒数，也支持 `--progress-ms`、`--mode top|bottom`、`--fontsize`、`--color`、`--page`；
- 本地防刷：默认 30 秒间隔、20 条/天、同视频同文 24h 去重；可在设置页改；
- 过 `interact` 守卫、身份闸、限额闸，成功后写 `danmaku-state.json` 并 `quota record`；
- 发完 2 分钟内可用 `--retract <dmid>` 撤回（B站限制）；
- 直播弹幕仍是 `danmaku send --room ...`，现在也会写 `quota record`（以前只过闸不记账）。

接口参考：[bilibili-API-collect 弹幕操作](https://raw.githubusercontent.com/SocialSisterYi/bilibili-API-collect/ab2762aeaa0aad65603478ca704cd4cbc3b9c425/docs/danmaku/action.md)
（外部社区文档，以实际接口为准；本机先用 `--dry` 验证）。

### 关注 / 取关（2026-11-13 新增）

```bash
node bili.mjs follow --list [--limit 20]
node bili.mjs follow --mid 353782040 --status
node bili.mjs follow --mid 54052968 --dry|--go
node bili.mjs follow --mid 54052968 --unfollow --dry|--go
```

- `x/relation/modify`（`act=1` 关注 / `act=2` 取关，`re_src=11`）；
- 改完回读 `x/relation?fid=` 确认 `attribute`，不是“接口说成功”就信；
- **不能关注/取关自己；不能取关主人**（私信互关会断）；
- 关注/取关共用 `follow.minGapMin`（默认 30 分钟）；关注、取关分别受 `follow.dailyMax` / `unfollowDailyMax`（默认 3/天，0=不限）；
- 成功写 `quota` 账本并 `notify` 报备；
- 关注列表会进入 `feed` 的「关注动态优先」：之后关注的人 7 天内新视频会先被刷到。

设置页「关注 / 取关（可选）」可调开关、日上限和间隔。`feed` 目前只读关注列表，不会自动关注；关注/取关是独立动作，不是选题任务。

### 视频点赞 / 投币（2026-11-13 新增）

```bash
node bili.mjs like-video --bvid BV1,BV2 --dry|--go
node bili.mjs like-video --bvid BV1 --unlike --go      # 清理测试用
node bili.mjs coin --bvid BV1 --reason "为什么特别好" --dry|--go
```

- **视频点赞**（`x/web-interface/archive/like`）：每天最多 10 个、每次最多 5 个；逐个回读 `has/like`；`--unlike` 可撤回；
- **投币**（`x/web-interface/coin/add`）：先查 `nav.money` 余额，再查 `archive/coins` 是否已投；只对特别好的视频，必须写理由（≥6 字）；默认每天最多 5 枚、单视频可选 1 或 2 枚；**1 枚要评分 ≥16，2 枚要 ≥18**（没评分先 `score`）；`select_like=0` 不会顺手点赞；
- 两者都过 `interact` 守卫、限额闸，成功写 quota 并 notify 报备；
- 评论点赞仍是 `fish-guard like`（另一套额度/风控），和视频点赞分开。

**收藏**：已去掉“同类 ≥2 条需 `--better`”的限制。现在只保留：理由 ≥6 字、每天最多 3 条、同一视频 30 天不重复、先 `--dry` 再 `--go`。

### 行为如何回流到选视频

`feed` 会把她的公开互动变成主题词权重（同一主题词取最大值，总分封顶 12）：

| 行为 | 权重 |
|---|---|
| 点赞视频 | 1.0 |
| 收藏 | 2.5 |
| 投 1 枚 | 4.0 |
| 投 2 枚 | 5.5 |

所以 **点赞 < 收藏 < 投 1 枚 < 投 2 枚**。被点赞/收藏/投币过的视频本身也会从候选里排除。
关注/取关不参与这个主题词权重；关注影响的是「关注动态优先」和 B站记忆 brief。

关注、取关、视频点赞、投币都会写进 `quota.json`，并由 `bili-memory` 生成到 `bili-memory.md` / `bili-memory-brief.md`；共享记忆卡也会把它们记成独立条目（`bili-follow` / `bili-like` / `bili-coin`），所以 QQ 那边会知道“我最近关注了谁、给哪条视频点了赞/投了币”。

## 3. 配置 / 设置页

`bili.config.json`：

```json
{
  "freePost": { "enabled": true },
  "article": { "enabled": true, "category": 0 },
  "dynamics": { "gapMin": 30 }
}
```

设置 → SurfCore → B站 → **自由发布（不是任务）**：

- 允许自由动态；
- 允许原创专栏；
- 专栏默认分类（0 = 默认）。

`dynamics.gapMin` 仍决定任意两条动态之间的间隔（默认 30 分钟）。

## 4. 安全边界

- `interact.enabled=false`（沉默逛）时：`--go` 被拒绝；`--draft`/`--dry` 仍可用于准备；
- 所有正文过 `assertOutboundIdentitySafe`（不泄露主人/他人身份、联系方式）；
- `--dry` 不发请求；`--go` 必须显式给；
- 30 分钟间隔跨四类动态/分享/自由动态/专栏；
- 发布后通过 `notify` 报备；不通知失败不影响已发内容；
- 不设每日上限是用户明确要求；但“间隔 + 公开内容”本身是防刷屏边界；
- 公共主页内容不可撤回（动态可删/专栏可删），发布前先 `--dry`。

## 5. 记忆同步（B站 → 人格）

发布成功后写：

```text
~/.dsh/surfcore/characters/<id>/bili/bili-posts.jsonl
```

- 插件记忆卡每 10 分钟读取，把「我在 B 站发了动态/写了专栏」作为 `bili-dynamic` /
  `bili-article` 记忆记录写入记忆卡；记忆卡是 QQ / B站 人格上下文的一部分；
- B站 `bili-memory.js` 每 30 分钟刷新 `bili-memory.md` / `brief`，也会合并这些作品；
  QQ 唤醒时的 B站 brief 会显示「最近在 B站（真实看过/发过）」；
- 不会改 `persona.md` 本身；「人格」通过记忆卡/简报同步，避免把日记/动态混成角色卡。

> 私信内容仍然不进 B站记忆；自由动态/专栏是公开作品，才进入记忆。

## 6. 测试

```bash
node scripts/test-bili-publish.mjs
```

覆盖：Markdown→HTML、`bili-posts.jsonl` 追加/读取、30 分钟间隔、专栏入库记忆卡。

真实接口验证（已做）：

- `article --draft` 建草稿成功（aid=373885），`--check` 读到标题/字节数，`--delete` 成功；
- `article --dry` / `free-post --dry` 通过；
- `free-post --go` 未做测试发布（避免往她的公共主页发测试内容），由她真正想发时执行。
