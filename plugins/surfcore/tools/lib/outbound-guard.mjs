/**
 * B站 出站身份闸（2026-10-23 用户要求：只准自己互认，不许泄露主人和别人的信息）。
 *
 * 为什么在工具层：
 *   · B站 评论/动态是**公开面**，一旦把主人的 QQ 号、主人的 B站 mid、或对齐表里
 *     别人的账号贴出去，就再也收不回来；
 *   · 提示词里的「不许泄露」只是概率约束，正则才是确定性的。
 *
 * 受保护的东西（只认这些，避免误伤普通数字）：
 *   · 主人：合体层 `admin.qq` / `admin.biliMid`、`bili.config.json` 的 `owner.mid`；
 *   · 别人：`alignments.json` 里每个 link 的各平台 id（QQ 号 / B站 mid / 贴吧 uid）；
 *   · 任何「QQ / 群号 + 数字」形态（即使不在名单里，那也是在往外递联系方式）。
 * 对外内容同时检查主人的已配置昵称、归属表述与结构化回复目标。
 *
 * 只负责「要不要发」，不做内容改写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { SURFCORE_DIR } from './state-paths.mjs';
import { configPath } from './config.mjs';
import { findIdentityLeaks, formatIdentityLeakError } from '../../../../src/identity-guard.js';

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const normalize = (value) => String(value ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').trim().toLowerCase();
const isId = (value) => /^\d{4,20}$/.test(value);
const GENERIC_NAMES = new Set(['主人', '管理员', '你', '我']);
const OWNER_RELATION = /(?:我(?:的|家)?|本鱼(?:的)?|鱼姬的)(?:主人|管理员|饲主)\s*(?:是|叫|就是|的\s*(?:b\s*站|账号|昵称|主页|空间))|(?:是|就是)\s*(?:我(?:的|家)?|本鱼(?:的)?|鱼姬的)(?:主人|管理员|饲主)/u;

function collectIdentityPolicy(surfcoreDir) {
  const unified = readJson(path.join(surfcoreDir, 'config.json'), {}) ?? {};
  const bili = readJson(surfcoreDir === SURFCORE_DIR ? configPath : path.join(surfcoreDir, 'bili.config.json'), {}) ?? {};
  const align = readJson(path.join(surfcoreDir, 'alignments.json'), {}) ?? {};
  const admin = unified && typeof unified.admin === 'object' && unified.admin ? unified.admin : {};
  const owner = bili && typeof bili.owner === 'object' && bili.owner ? bili.owner : {};
  const self = bili && typeof bili.self === 'object' && bili.self ? bili.self : {};
  const selfMid = normalize(self.mid);
  const ownerMids = new Set([admin.biliMid, owner.mid].map(normalize).filter(isId));
  const ownerNames = new Set([admin.biliName, owner.name, admin.displayName].map(normalize).filter(Boolean));
  const ids = new Set();
  const add = (value) => {
    const s = normalize(value);
    if (!isId(s) || s === selfMid) return;
    ids.add(s);
  };
  add(admin.qq);
  for (const mid of ownerMids) add(mid);
  for (const link of Array.isArray(align.links) ? align.links : []) {
    const identities = link && typeof link.identities === 'object' ? link.identities : {};
    for (const identity of Object.values(identities)) add(identity && identity.id);
  }
  return { ids, ownerMids, ownerNames };
}

export function collectProtectedIdentities({ surfcoreDir = SURFCORE_DIR } = {}) {
  return [...collectIdentityPolicy(surfcoreDir).ids];
}

/**
 * 出站前检查。命中就抛 Error（调用方负责打印并中止发送）。
 * @param {string} text 准备发出去的正文
 * @param {{surface?:string, surfcoreDir?:string, ids?:string[], privateRecipientMid?:string,
 *   targetMid?:string, targetName?:string, unverifiedTarget?:boolean}} options
 */
export function assertOutboundIdentitySafe(text, {
  surface = 'B站 内容', surfcoreDir = SURFCORE_DIR, ids, privateRecipientMid,
  targetMid, targetName, unverifiedTarget = false,
} = {}) {
  const policy = collectIdentityPolicy(surfcoreDir);
  const body = normalize(text);
  if (!policy.ownerMids.has(normalize(privateRecipientMid))) {
    if (unverifiedTarget && (policy.ownerMids.size || policy.ownerNames.size)) {
      throw new Error(`${surface}无法核验公开回复的对象。请确认回复对象后重试，或发送一条不带回复标记的内容。`);
    }
    const mentions = body.replace(/@\s+/gu, '@');
    const namesOwner = [...policy.ownerNames].some((name) =>
      mentions.includes(`@${name}`) || (!GENERIC_NAMES.has(name) && body.includes(name)));
    const identifiesOwner = namesOwner || OWNER_RELATION.test(body)
      || [...policy.ownerMids].some((mid) => body.includes(mid));
    // 2026-11-12 用户定：可以正常回复主人的评论，只要**不暴露彼此关系**。
    //   所以不再因为「回复对象是主人」就一刀切拦下；只拦「正文里点名/归属/写账号」的情况。
    //   targetMid/targetName 留着做上下文，不再单独触发拦截。
    if (identifiesOwner) {
      throw new Error(`${surface}会提及主人或暴露主人的身份。请去掉点名、@、账号信息和公开回复标记后再试。`);
    }
  }
  const hits = findIdentityLeaks(body, { ids: Array.isArray(ids) ? ids : policy.ids });
  if (hits.length) throw new Error(formatIdentityLeakError(hits, surface));
  return { ok: true, hits };
}
