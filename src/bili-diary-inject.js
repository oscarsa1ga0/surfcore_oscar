// B站日记注入 QQ 的选取与截断（2026-11-16）
//
// 背景：两本鲸日记是 B站 侧手写的 markdown，标题里带日期（`### 四十四、…（2026-11-16 23:20）`）。
// QQ 主人私聊唤醒时会被抽出来放进提示词，但有两处会丢东西：
//   1. 只取「今天」的段落 → 过了午夜就断；
//   2. 预算按「从前往后」截 → 最新的几条反而被切掉。
// 这里把抽取与截断拆成纯函数，截断改成「从最新往回加」，让被丢的永远是最老的。

const DAY_RE = /^##\s+(\d{4}-\d{2}-\d{2})/;
const DAY_RE_H3 = /^###+\s+.*?(\d{4}-\d{2}-\d{2})/;

/**
 * 抽出某一天的段落（保留标题行）。
 * @param {string} text
 * @param {string} day YYYY-MM-DD
 * @returns {string[]} 段落，文件顺序（旧 → 新）
 */
export function extractDaySegments(text, day) {
  const lines = String(text ?? '').split('\n');
  const segs = [];
  let curDate = '';
  let buf = [];
  const flush = () => {
    if (curDate === day && buf.length) {
      const body = buf.join('\n').trim();
      if (body) segs.push(body);
    }
    buf = [];
  };
  for (const line of lines) {
    const h2 = DAY_RE.exec(line);
    const h3 = DAY_RE_H3.exec(line);
    if (h2) { flush(); curDate = h2[1]; buf = [line]; continue; }
    if (h3) { flush(); curDate = h3[1]; buf = [line]; continue; }
    buf.push(line);
  }
  flush();
  return segs;
}

/**
 * 把若干段落按「最新优先」塞进预算，返回按时间顺序拼好的文本。
 * 单段就超预算时，只保留它的尾部（最新写的那部分）。
 * @param {string[]} segments 文件顺序（旧 → 新）
 * @param {number} budget 字符上限
 */
export function trimNewestFirst(segments, budget = 6000) {
  const max = Math.max(50, Number(budget) || 6000);
  const kept = [];
  let used = 0;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i];
    if (!seg) continue;
    const cost = seg.length + (kept.length ? 2 : 0);
    if (used + cost <= max) {
      kept.unshift(seg);
      used += cost;
      continue;
    }
    const room = max - used - (kept.length ? 2 : 0);
    if (room > 200) {
      kept.unshift(seg.slice(-room));
      used = max;
    }
    break;
  }
  return kept.join('\n\n').trim();
}

/**
 * 从多份日记文件拼出「今天」的注入文本：先把各文件的当天段落按文件顺序排好，
 * 再从最新往回装预算。
 * @param {Array<string>} texts 各文件全文（顺序即文件顺序）
 * @param {string} day
 * @param {number} budget
 */
export function composeDiaryInjection(texts, day, budget = 6000) {
  const segments = [];
  for (const text of texts) segments.push(...extractDaySegments(text, day));
  return trimNewestFirst(segments, budget);
}
