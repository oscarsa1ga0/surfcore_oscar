// fans 命令的输出排版。
//
// 为什么要单独抽出来：她习惯 `| tail -2` 截输出。2026-11-17 06:11 那轮，
// `fans --new` 已经发现第三位粉丝、水位也前移了，但 tail -2 只留下「水位：…」，
// 她什么都没看到 —— 而且水位已前移，之后再也看不到。
//
// 规则：**结论放最后一行，并且自解释**（谁、什么时间、水位）。tail -1 也丢不掉。

export function stampLocal(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '时间未知';
  return new Date(n * 1000).toLocaleString('zh-CN', { hour12: false });
}

/**
 * @param {object} o
 * @param {number} o.follower @param {number} o.following
 * @param {Array} o.list 全部粉丝 @param {Array} o.fresh 新粉丝
 * @param {string} o.ownerMid @param {number} o.lastSeen @param {boolean} o.newOnly
 * @returns {string[]} 逐行输出
 */
export function renderFansOutput({ follower, following, list = [], fresh = [], ownerMid = '', lastSeen = 0, newOnly = false } = {}) {
  const water = Math.max(Number(lastSeen) || 0, ...list.map((x) => Number(x.time) || 0), 0);
  const line = (x) => `- ${x.name || '（无昵称）'}  mid=${x.mid}  ${stampLocal(x.time)}${x.mid === ownerMid ? '  [主人]' : ''}`;
  const summary = (items) => items.map((x) => `${x.name || '（无昵称）'}（${stampLocal(x.time)}）`).join(' · ');

  const out = [`B站粉丝：${Number(follower) || 0} 个 · 关注 ${Number(following) || 0} 个`];
  if (!newOnly) {
    if (!list.length) out.push('（还没有粉丝）');
    else for (const x of list) out.push(line(x));
    out.push(`\n水位：${water}`);
    return out;
  }
  if (!fresh.length) {
    out.push(`没有新粉丝 ｜ 水位 ${water}`);
    return out;
  }
  for (const x of fresh) out.push(line(x));
  out.push(`\n新粉丝 ${fresh.length} 个：${summary(fresh)} ｜ 水位 ${water}`);
  return out;
}
