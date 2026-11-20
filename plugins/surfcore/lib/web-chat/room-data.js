import { listShares, readSchedulerState, scanEntries } from '../../../../src/diary-store.js';

const moodMetrics = ['joy', 'curiosity', 'reflection', 'fatigue'];

export function roomSnapshot({ active, mood, diaryDir, watches }) {
  const diary = { reviewedDay: null, shares: [] };
  if (diaryDir) {
    diary.reviewedDay = readSchedulerState(diaryDir).lastReviewedDay;
    const recent = listShares(diaryDir, { limit: 20 }).shares.filter((item) => typeof item.excerpt === 'string').reverse();
    const live = new Set(recent.length ? scanEntries(diaryDir).entries.map(({ id }) => id) : []);
    const seen = new Set();
    for (const item of recent) {
      if (!live.has(item.id) || seen.has(item.id) || !item.excerpt.trim()) continue;
      seen.add(item.id);
      diary.shares.push({ date: item.date, excerpt: item.excerpt.trim().slice(0, 240) });
      if (diary.shares.length === 3) break;
    }
  }
  return {
    activity: ['web', 'bili', 'diary', 'pet'].includes(active?.source) ? active.source : '',
    mood: mood ? {
      label: mood.mood,
      metrics: Object.fromEntries(moodMetrics.map((key) => [key, Math.max(0, Math.min(100, Math.round(mood.drives?.[key] ?? 0)))])),
    } : null,
    diary,
    watches: watches.items
      .filter((item) => item.title && /^BV[0-9A-Za-z]{10}$/.test(item.bvid))
      .slice(0, 4)
      .map(({ at, dateOnly, unknownDate, bvid, title }) => ({ at, dateOnly, unknownDate, bvid, title })),
  };
}
