// 把 UTC 时间显示成本地时间（带偏移）。
//
// 背景：存储层统一用 UTC ISO（`2026-11-16T15:36:42.887Z`），但凡是给模型或人看的时间，
// 直接把 Z 那几个数字念出来就会差 8 小时（2026-11-16 22:20 的日记被读成 15:36）。
// 这里输出 `2026-11-16T23:36:42+08:00`：机器仍可解析，人和模型也不会看错。

export function localIso(value) {
  const t = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(t.getTime())) return value;
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -t.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
    + `T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 只把对象里的某个时间字段转成本地；字段不存在时原样返回。 */
export function localizeField(obj, key) {
  if (!obj || typeof obj !== 'object') return obj;
  const value = obj[key];
  if (!value) return obj;
  return { ...obj, [key]: localIso(value) };
}
