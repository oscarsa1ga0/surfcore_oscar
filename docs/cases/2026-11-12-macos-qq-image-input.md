# macOS QQ 静态图片无法送进模型

在 macOS、DSH `0.2.2-rc.1`、SurfCore `feat/macos-qq`、NapCat `4.18.42`（Docker）上，QQ 文本聊天正常，发送普通 PNG 后角色只能看到图片标签。该问题不影响文字聊天，也不涉及角色是否决定回复。

## 完整逻辑

- **链路**：NapCat 上报消息和图片引用 → `src/bridge.js` 按会话和令牌核验后下载 → `qq_get_message_images` 转成 MCP 图像内容 → DSH 模型。旧模式直接内联同一取图函数的结果。
- **能力判断**：`session.modelCatalog` 省略了 `inputModalities`。实际跟随 `deepseek-account/deepseek-flash` 时，桥接把它与旧配置的 `deepseek-official` 比较，错误地将未知判为禁用。独立推理已经确认该账号模型支持 PNG。
- **图片传输**：NapCat 的 `get_image` 返回了容器里的缓存路径和 QQ CDN 链接。Mac 不能读这个容器路径，本机测试也没有成功下载链接。NapCat 的 `download_file_image_stream` 能用同一个安全图片引用返回容器内已有的字节。
- **取舍**：强制开启 `imageInput=true` 只绕过判断，挂载容器缓存则要改 Docker 部署；现有 OneBot 接口能解决两段问题，无需额外模型、密钥、挂载或配置修改。新增通路只请求配置好的网关，对响应做限长、顺序、完成和现有图像校验；标准 `get_image` 有字节时优先使用，其他 OneBot 仍有原来的下载路径。
- **影响和回退**：只影响 QQ 图像内容的读取，沿用既有的会话准入与鉴权。失败时模型可看到图片禁用或下载失败及下一步建议。恢复本次代码前的快照并重启 QQ 桥接即可回退；没有迁移会话数据。新代码仅需重启 QQ 桥接。

## 验证

- `node scripts/test-image-input.mjs`：复现目录缺字段及容器路径，断言返回正确 PNG 字节；校验显式禁用、下载失败、超限、流截断和路径拒绝。
- `node scripts/test-model-options.mjs`、`node scripts/test-audit-regressions.mjs` 通过。整套审计 149/155；其余 6 个脚本涉及 macOS 路径、Windows 工具/换行及主分支发行清单，未改动这些功能或清单。
- 真实桥接重启后，MCP 工具返回 `image/png`、1,088,388 字节，校验图像签名有效。独立 DSH 测试会话的同一模型正确描述测试 PNG 的左红右蓝，测试会话已归档。
- 最后一跳需在 QQ 发新图后观察角色的实际对话回复；诊断期间没有发测试 QQ 消息。

## 发布交接

`feat/macos-qq`：修改 `src/model-options.js`、`src/bridge.js`，新增 `src/onebot-image-stream.js` 与图片回归；实现层修复，失败时图片查询有 `code/error/hint`，正常成功结果保持原格式。建议 patch。定向回归和真实网关/模型验证通过；全量审计尚未全绿，QQ 客户端对话待复验，本批未发布。
