// QQ 出站「AI 味」检查（2026-11-16）
//
// 规则本体在 B站 工作区的 style-rules.mjs（她平时改那一份），这里只负责：
//   · 按 mtime 缓存地动态加载（她改完规则，下一次发送就生效）
//   · 按 surface='qq' 分出 hard（general）/ soft（format）
// 检查失败一律放行——规则文件坏了不能把发消息链路弄瘫。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STYLE_RULES_ENV = 'SURFCORE_STYLE_RULES_PATH';

export function defaultStyleRulesPath(home = os.homedir()) {
  return path.join(home, '.dsh', 'surfcore', 'state', 'bili-agents', 'style-rules.mjs');
}

let cache = { key: '', mod: null };
let lastError = '';

export function styleGateStatus() {
  return { rulesPath: process.env[STYLE_RULES_ENV] || defaultStyleRulesPath(), loaded: Boolean(cache.mod), lastError };
}

/** 动态加载规则模块；文件不存在/语法错/没有 STYLE_RULES → 返回 null。 */
export async function loadStyleRules(filePath) {
  const p = filePath || process.env[STYLE_RULES_ENV] || defaultStyleRulesPath();
  let stat;
  try { stat = fs.statSync(p); } catch { return null; }
  const key = `${p}:${stat.mtimeMs}:${stat.size}`;
  if (cache.key === key) return cache.mod;
  try {
    const mod = await import(`file://${p}?v=${stat.mtimeMs}`);
    if (!Array.isArray(mod.STYLE_RULES) || typeof mod.scanStyle !== 'function') {
      lastError = '规则文件缺少 STYLE_RULES 或 scanStyle';
      return null;
    }
    cache = { key, mod };
    lastError = '';
    return mod;
  } catch (error) {
    lastError = String(error?.message ?? error).slice(0, 200);
    return null;
  }
}

/**
 * 检查一条待发的 QQ 文本。
 * 返回 { hard, soft, skipped?, unavailable? }；hard 命中的是通用 AI 味，soft 是格式偏好。
 */
export async function evaluateQqStyle(text, { minChars = 8 } = {}) {
  const t = String(text ?? '');
  const short = [...t].length < Math.max(0, Number(minChars) || 0);
  const mod = await loadStyleRules();
  if (!mod) return { hard: [], soft: [], unavailable: true };
  const res = mod.scanStyle(t, { surface: 'qq' });
  const rules = Array.isArray(res?.rules) ? res.rules : [];
  // 短句默认跳过，但标了 always 的规则（如「我记下了」）照样查。
  const hard = Array.isArray(res?.hard) ? res.hard.filter((name) => {
    if (!short) return true;
    return rules.some((rule) => rule?.name === name && rule.always === true);
  }) : [];
  const soft = short ? [] : (Array.isArray(res?.soft) ? res.soft : []);
  return { hard, soft, ...(short ? { skipped: true } : {}) };
}
