// 日记会话守卫：只放行日记工具/安全搜索，拒绝 QQ 发送和本地执行工具。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { apply, name, inject } = await import('../plugins/surfcore/diary-tool-guard.mjs');

test('diary-tool-guard：放行日记/搜索，拒绝 QQ 发送与本地工具', () => {
  assert.equal(name, 'diary-tool-guard');
  assert.deepEqual(inject, ['tools']);
  let guardFn = null;
  const restricted = [];
  apply({
    tools: {
      restrict: ({ deny }) => { restricted.push(...deny); },
      guard: (fn) => { guardFn = fn; },
    },
    on: () => () => {},
  });
  assert.equal(typeof guardFn, 'function');
  for (const tool of ['diary_write', 'diary_capture', 'diary_read', 'diary_search', 'diary_list', 'diary_edit', 'diary_delete', 'diary_share']) {
    assert.equal(guardFn({ name: tool }), undefined, `${tool} 应放行`);
  }
  assert.equal(guardFn({ name: 'mcp__web-search-safe__web_fetch' }), undefined);
  assert.equal(guardFn({ name: 'ask_user_question' }), undefined);
  assert.equal(guardFn({ name: 'todo_write' }), undefined);
  for (const tool of ['mcp__snowluma__qq_send_message', 'read', 'write', 'bash', 'pwsh', 'plugin_manager']) {
    assert.match(String(guardFn({ name: tool })), /不允许/, `${tool} 应拒绝`);
  }
  assert.match(String(guardFn({ name: '' })), /无效/);
  assert.ok(restricted.includes('pwsh'));
  assert.ok(restricted.includes('plugin_manager'));
});
