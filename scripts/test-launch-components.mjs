// 一键启动/停止的接线契约：UI 入口、语音分支、结构化失败码必须同时存在。
// 只读源码，不启动任何服务（真正的启动行为由集成环境手测）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = fs.readFileSync(path.join(root, 'plugins/surfcore/lib/index.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'plugins/surfcore/lib/client.js'), 'utf8');

for (const action of ['start-selected', 'stop-selected']) {
  assert.ok(index.includes(action), `后端必须支持 ${action}`);
}
assert.ok(index.includes('NO_COMPONENTS'), '空选择必须返回结构化错误');
assert.ok(index.includes('PLATFORM_DISABLED'), 'B站启动开关关闭时必须返回结构化错误');
assert.ok(index.includes('stopSchedulerNow'), '可以停止 B站生物钟');
assert.ok(index.includes("const LAUNCH_LABELS = { bili:"), '组件入口从 B站开始');
assert.doesNotMatch(index, /startBridge\(|launchQqGateway\(/);
assert.doesNotMatch(index, /\/snowluma\/accounts|\/snowluma\/load/);
assert.ok(index.includes('vectorPack') && index.includes('VECTOR_SELF_TEST_FAILED'));
assert.ok(client.includes('launch.vector?.models') && client.includes('launch.vector?.providers'));
assert.ok(client.includes('api("/components"'));
assert.ok(client.includes('launchErr') && client.includes('item.hint'));
console.log('✅ 网页端组件启停接线通过');
