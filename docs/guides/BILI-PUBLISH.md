# B站自由发布 / 原创专栏

> 状态：✅ 2026-11-12 实现（自由动态 + 原创专栏；原创视频上传预留接口，未实现）。
> 相关：`plugins/surfcore/tools/commands/free-post.mjs`、`commands/article.mjs`、
> `lib/article.mjs`、`lib/bili-posts.mjs`、`scheduler.js` 的唤醒流程、`BiliTab` 设置。

## 1. 产品定位

除了既有的「四类动态 / 每日分享」，她逛 B 站时如果**自己**想发东西，可以额外发：

- 一句话 / 一段想法；
- 一张图；
- 任意视频卡片（配自己的话，不要求评分，也不占分享额度）；
- 专栏/站内链接；
- 原创专栏（长文，先草稿再发布）。

**这不是任务**：想发就发，不想发就不发；可以一天很多条，也可以很多天一条都不发。
不设每日上限；只和四类动态/分享/专栏共用「任意两条动态之间 ≥30 分钟」的防刷屏间隔。

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
- 可选 `--cover <图片>`、`--category <ID>`（默认 0 = B站默认分类）；
- 发完写 `bili-posts.jsonl`、记 quota（type=article）、notify 报备。

### 原创视频上传（预留）

`node bili.mjs video-upload` 会明确提示“未实现”，并打印以后要接的端点：
`member.bilibili.com/preupload` → 分片上传 → `x/vu/web/add/v3`。
当前分享视频请用 `free-post --bvid`。

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
