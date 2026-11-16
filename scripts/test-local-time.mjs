// 展示层时间：UTC ISO → 本地 ISO（带偏移）。2026-11-16 她把 23:36 的日记读成 15:36。
import assert from 'node:assert/strict';
import { localIso, localizeField } from '../src/local-time.js';

const utc = '2026-11-16T15:36:42.887Z';
const local = localIso(utc);
assert.match(local, /^2026-11-16T\d{2}:36:42[+-]\d{2}:\d{2}$/, local);
// 换算后的瞬间必须和原 UTC 一致
assert.ok(Math.abs(new Date(local).getTime() - new Date(utc).getTime()) < 1000, '差不超过 1 秒（展示层不保留毫秒）');
// 本地小时 = Date 的本地小时（不写死 23，避免测试机时区不同）
const expectedHour = new Date(utc).getHours();
assert.equal(Number(local.slice(11, 13)), expectedHour);
assert.ok(!local.endsWith('Z'), '不能返回裸 UTC');

// Date 实例、非法值、空值
assert.ok(Math.abs(new Date(localIso(new Date(utc))).getTime() - new Date(utc).getTime()) < 1000);
assert.equal(localIso(''), '');
assert.equal(localIso('不是时间'), '不是时间');

// 字段级转换
const item = { at: utc, title: 'x' };
assert.match(localizeField(item, 'at').at, /[+-]\d{2}:\d{2}$/);
assert.equal(localizeField({ title: 'x' }, 'at').at, undefined);
assert.equal(item.at, utc, '不能改原对象');

console.log('✅ 本地时间展示测试通过');
