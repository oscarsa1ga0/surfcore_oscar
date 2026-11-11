import path from 'node:path';
import { activePlatformStateDir } from '../../../src/character-persona.js';
import { readWatchHistory } from '../tools/lib/watch-history.mjs';
import { QQ_STATE_DIR } from './paths.js';
import { readJson } from './store.js';

// The Bilibili tools write watch history directly. Feed those public records into
// the same memory ingest even on installations where the QQ bridge is stopped.
export function readBiliMemoryEntries() {
  const dir = activePlatformStateDir(QQ_STATE_DIR);
  const memoryFile = path.join(dir, 'bili-memory.json');
  const indexed = readJson(memoryFile, {})?.entries;
  const entries = Array.isArray(indexed) ? [...indexed] : [];
  const seen = new Set(entries.filter((entry) => entry?.type === 'video').map((entry) => entry.bvid));
  const { items } = readWatchHistory({
    file: path.join(dir, 'watch-history.jsonl'),
    memoryFile,
    scoresFile: path.join(dir, 'scores.json'),
    limit: 200,
  });
  for (const item of items) {
    if (item.backfilled || !/^BV[\dA-Za-z]{10}$/.test(item.bvid) || !item.title || seen.has(item.bvid)) continue;
    seen.add(item.bvid);
    entries.push({ id: `bv:${item.bvid}`, type: 'video', bvid: item.bvid, title: item.title, at: item.at });
  }
  return entries;
}
