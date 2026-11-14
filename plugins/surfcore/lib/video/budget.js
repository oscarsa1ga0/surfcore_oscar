import fs from 'node:fs';
import path from 'node:path';

export function reserveDailyUsage(db, kind, units, limit, time = new Date()) {
  if (!(limit > 0) || units <= 0) return;
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(time);
  db.exec(`CREATE TABLE IF NOT EXISTS video_usage (
    day TEXT NOT NULL, kind TEXT NOT NULL, units INTEGER NOT NULL, PRIMARY KEY(day, kind)
  )`);
  const recorded = units <= limit && db.prepare(`INSERT INTO video_usage(day, kind, units) VALUES (?, ?, ?)
    ON CONFLICT(day, kind) DO UPDATE SET units = video_usage.units + excluded.units
    WHERE video_usage.units + excluded.units <= ?`).run(day, kind, units, limit).changes > 0;
  if (!recorded) {
    const label = kind === 'tts' ? '合成字数' : '渲染秒数';
    throw Object.assign(new Error(`今日视频${label}预算不足`), {
      code: 'VIDEO_DAILY_BUDGET', hint: '等上海时间次日或调整视频创作预算后手动重试',
    });
  }
}

/** 统计角色本地工件，硬链接占用只算一次。不会跟随符号链接。 */
export function assertVideoDiskBudget(root, limit, extra = 0) {
  let bytes = 0;
  const seen = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
        if (!stat) continue;
        const key = `${stat.dev}:${stat.ino}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bytes += Number(stat.size);
      }
    }
  };
  if (limit > 0) {
    walk(root);
    if (bytes + extra > limit) {
      throw Object.assign(new Error('该角色的视频项目已达到磁盘预算'), {
        code: 'VIDEO_DISK_BUDGET', hint: '归档旧项目或提高视频目录预算，再重试',
      });
    }
  }
}
