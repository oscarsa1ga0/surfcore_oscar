// QQ 出门检查（style-gate）回归：规则加载 / 分类 / 短句跳过 / 文件缺失放行
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { evaluateQqStyle, loadStyleRules, STYLE_RULES_ENV } from '../src/style-gate.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-gate-'));
const file = path.join(dir, 'style-rules.mjs');
fs.writeFileSync(file, `
export const STYLE_RULES = [
  { name: '破折号', re: /——/, scope: 'general' },
  { name: '不是而是', re: /不是[^。]{0,10}而是/, scope: 'general' },
  { name: '复述原话再评价', re: /这句(很|太)好/, scope: 'general' },
  { name: '讲的是（评论专用）', re: /讲的是/, scope: 'comment' },
  { name: '直角引号', re: /[「」]/, scope: 'format' },
]
export function scanStyle(text, { surface = 'qq' } = {}) {
  const t = String(text ?? '')
  const all = STYLE_RULES.filter((r) => r.re.test(t))
  if (surface === 'bili') return { hits: all.map((r) => r.name), rules: all }
  return {
    hard: all.filter((r) => r.scope === 'general').map((r) => r.name),
    soft: all.filter((r) => r.scope === 'format').map((r) => r.name),
    rules: all,
  }
}
`);

process.env[STYLE_RULES_ENV] = file;
assert.ok(await loadStyleRules(), '规则文件应能加载');

const hard = await evaluateQqStyle('这不是风控，而是额度');
assert.deepEqual(hard.hard, ['不是而是']);
assert.deepEqual(hard.soft, []);

const soft = await evaluateQqStyle('好「好」好「好」好');
assert.deepEqual(soft.hard, []);
assert.deepEqual(soft.soft, ['直角引号']);

const commentOnly = await evaluateQqStyle('这条视频讲的是 AI 二创');
assert.deepEqual(commentOnly.hard, [], '评论专用规则 QQ 不看');

const short = await evaluateQqStyle('——', { minChars: 8 });
assert.equal(short.skipped, true, '短句跳过');

const echoEval = await evaluateQqStyle('这句很好，我也笑了，不是客套而是真的');
assert.ok(echoEval.hard.includes('复述原话再评价'));

process.env[STYLE_RULES_ENV] = path.join(dir, 'missing.mjs');
const missing = await evaluateQqStyle('——不是风控而是额度');
assert.equal(missing.unavailable, true, '规则文件缺失时放行');
assert.deepEqual(missing.hard, []);

fs.rmSync(dir, { recursive: true, force: true });
console.log('qq style gate tests OK');
