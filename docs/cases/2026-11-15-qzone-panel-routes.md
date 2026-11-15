# QQ 空间面板「未知接口」：插件漏了后端路由

## 现象

SurfCore 设置页「QQ 空间状态」显示：

- `读取不到（重启桥接后可用）：未知接口：/dsh-surfcore/api/qzone/status`
- 点「立即空间活动」→ `未知接口：/dsh-surfcore/api/socialV2/qzone/activity`

## 根因

- `plugins/surfcore/lib/client.js` 的面板调用这两个接口；
- `plugins/surfcore/lib/index.js` 的路由表**从来没有 qzone 路由**（全文搜不到 qzone），落到兜底 404「未知接口」；
- 桥接控制台其实有 `/api/qzone/status` 和 `/api/socialV2/qzone/activity`，只是没被插件代理出来。

## 修法

`plugins/surfcore/lib/index.js` 的 API 路由区新增两条带 console-token 的代理：

- `GET /dsh-surfcore/api/qzone/status` → `callBridge('/api/qzone/status')`
- `POST /dsh-surfcore/api/socialV2/qzone/activity` → `callBridge('/api/socialV2/qzone/activity', {method:'POST', body})`

## 验证

- `node --check` 通过；
- 桥接端点直连（带 `x-console-token`）返回 `ok:true`、gateway `NapCat.Onebot 4.18.42`；
- 插件路由要**重启 DSH** 后才注册，重启后设置页点「刷新状态」验证。
