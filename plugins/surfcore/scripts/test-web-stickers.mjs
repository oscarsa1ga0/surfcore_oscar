import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageTypeOf, matchStickers, pickSticker, readStickerCatalog, stickerBytes } from '../lib/web-chat/stickers.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-stickers-'));
try {
  const file = path.join(dir, 'stickers.json');
  fs.writeFileSync(file, JSON.stringify([
    { no: 1, id: 'a', md5: 'AA11', url: 'https://example.invalid/1', emotion: 'happy', content: '笑' },
    { no: 2, id: 'b', md5: 'BB22', url: 'https://example.invalid/2', emotion: 'wronged', content: '委屈' },
  ]));
  const catalog = readStickerCatalog(file);
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].emotion, '开心');
  assert.equal(pickSticker(catalog, '#02').md5, 'BB22');
  assert.equal(pickSticker(catalog, '2').md5, 'BB22');
  assert.equal(pickSticker(catalog, 'AA11').no, 1);
  assert.equal(pickSticker(catalog, 'nope'), null);

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(imageTypeOf(png), 'image/png');
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response(png); };
  const first = await stickerBytes(catalog[1], { dir: path.join(dir, 'cache'), fetchImpl });
  assert.equal(first.type, 'image/png');
  const second = await stickerBytes(catalog[1], { dir: path.join(dir, 'cache'), fetchImpl });
  assert.equal(second.type, 'image/png');
  assert.equal(calls, 1, '第二次应读本地缓存，不再下载');
  assert.equal(fs.statSync(path.join(dir, 'cache', 'BB22.png')).size, 8);
  const raw = [
    { no: 3, id: 'c', md5: 'CC33', emotion: 'wronged', content: '委屈到抱碗哭', keywords: ['委屈', '要饭', '哭'] },
    { no: 4, id: 'd', md5: 'DD44', emotion: 'happy', content: '开心转圈', keywords: ['哈哈', '开心'] },
  ];
  const hits = matchStickers('我好委屈，想哭', { entries: raw, minScore: 0.2 });
  assert.ok(hits.some((hit) => hit.no === 3), '委屈的话应匹配到委屈表情');
  console.log('✓ 表情包：目录解析、编号查找、图片缓存、语义匹配');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
