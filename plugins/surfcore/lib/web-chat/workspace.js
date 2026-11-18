// 网页会话工作目录里的图片清单：让她能挑一张发出去（web_chat_send_image 只接受工作目录内的文件）。
import fs from 'node:fs';
import path from 'node:path';

const EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export function listWorkspaceImages(cwd, { max = 30, maxBytes = 8 * 1024 * 1024 } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 2 || found.length >= max) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= max) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.size > maxBytes) continue;
        found.push({ path: path.relative(cwd, full), bytes: stat.size, mtime: stat.mtimeMs });
      } catch {}
    }
  };
  walk(cwd, 0);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, max);
}
