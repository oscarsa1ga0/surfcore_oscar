import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listWorkspaceImages } from '../lib/web-chat/workspace.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-workspace-'));
try {
  fs.writeFileSync(path.join(dir, 'a.png'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'pics'));
  fs.writeFileSync(path.join(dir, 'pics', 'c.gif'), Buffer.from([1]));
  fs.mkdirSync(path.join(dir, '.hidden'));
  fs.writeFileSync(path.join(dir, '.hidden', 'd.png'), Buffer.from([1]));
  const list = listWorkspaceImages(dir);
  const names = list.map((item) => item.path).sort();
  assert.deepEqual(names, ['a.png', path.join('pics', 'c.gif')]);
  console.log('✓ 图片清单：只收工作目录内的图片、跳过隐藏目录');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
