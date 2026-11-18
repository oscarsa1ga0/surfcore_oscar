// 网页私聊的轻量记忆（对应 QQ 的 qq_memory_*）：数据形状、字段、TTL、去重、上限、渲染格式
// 都按桥接的 appendMemoryV2 / formatMemoryV2 对齐；唯一不同是存储位置（web 作用域，QQ 看不到）。
import fs from 'node:fs';
import path from 'node:path';

const TOPIC_TTL = 24 * 60 * 60 * 1000;
const THOUGHT_TTL = 2 * 60 * 60 * 1000;
const trim = (text, max) => String(text ?? '').trim().slice(0, max);

function normalize(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  return {
    activeTopics: Array.isArray(data.activeTopics) ? data.activeTopics : [],
    pendingThoughts: Array.isArray(data.pendingThoughts) ? data.pendingThoughts : [],
    memberImpressions: data.memberImpressions && typeof data.memberImpressions === 'object' ? data.memberImpressions : {},
  };
}

export function readLightMemory(file) {
  try { return normalize(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return normalize({}); }
}

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

/** 同 appendMemoryV2：24h 话题过期、2h 想法过期、同文去重、上限 20/20/50。 */
export function appendLightMemory(file, category, content, extra = {}) {
  const st = readLightMemory(file);
  const text = String(content ?? '').trim();
  st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
  st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < TOPIC_TTL));
  if (category === 'activeTopic' && text) {
    const existing = st.activeTopics.find((t) => String(t.text || '') === text);
    if (existing) {
      existing.lastMentionAt = Date.now();
      if (Array.isArray(extra.participants)) {
        const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => String(p))]);
        existing.participants = [...set].slice(0, 10);
      }
      if (extra.pendingQuestion) existing.pendingQuestion = trim(extra.pendingQuestion, 200);
    } else {
      st.activeTopics.push({
        text: trim(text, 200), lastMentionAt: Date.now(),
        participants: Array.isArray(extra.participants) ? extra.participants.map(String).slice(0, 10) : [],
        pendingQuestion: trim(extra.pendingQuestion || '', 200),
      });
    }
    if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
  } else if (category === 'pendingThought' && text) {
    const existing = st.pendingThoughts.find((t) => String(t.text || '') === text);
    const expiresAt = Date.now() + (Number(extra.expiresAtMs) || THOUGHT_TTL);
    if (existing) {
      existing.createdAt = Date.now(); existing.expiresAt = expiresAt;
      if (extra.motivation) existing.motivation = trim(extra.motivation, 50);
    } else {
      st.pendingThoughts.push({
        text: trim(text, 200), createdAt: Date.now(), expiresAt,
        motivation: trim(extra.motivation || 'curiosity', 50),
      });
    }
    if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
  } else if (category === 'memberImpression') {
    const target = String(extra.target || '').trim();
    if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) throw new Error('memberImpression 需要 target');
    const old = st.memberImpressions[target] || {};
    const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
    if (text && !traits.includes(trim(text, 50))) traits.push(trim(text, 50));
    st.memberImpressions[target] = { traits, interactionCount: (Number(old.interactionCount) || 0) + 1, lastSeenAt: Date.now() };
    const entries = Object.entries(st.memberImpressions);
    if (entries.length > 50) {
      entries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
      for (let i = 0; i < entries.length - 50; i += 1) delete st.memberImpressions[entries[i][0]];
    }
  } else if (category !== 'activeTopic' && category !== 'pendingThought' && category !== 'memberImpression') {
    throw new Error('category 无效');
  }
  save(file, st);
  return st;
}

export function removeLightMemory(file, category, content = '', target = '') {
  const st = readLightMemory(file);
  if (category === 'activeTopic') st.activeTopics = st.activeTopics.filter((t) => String(t.text || '') !== String(content || ''));
  else if (category === 'pendingThought') st.pendingThoughts = st.pendingThoughts.filter((t) => String(t.text || '') !== String(content || ''));
  else if (category === 'memberImpression') delete st.memberImpressions[String(target || '')];
  else throw new Error('category 无效');
  save(file, st);
  return st;
}

/** 同 formatMemoryV2 的输出格式。 */
export function renderLightMemoryBlock(st) {
  const lines = [];
  const topics = st.activeTopics.filter((t) => t && t.text);
  if (topics.length) {
    lines.push('【进行中的话题】');
    for (const t of topics.slice(-10)) {
      const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
      const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
      lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
    }
  }
  const thoughts = st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt));
  if (thoughts.length) {
    lines.push('【你想说但还没说的】');
    for (const t of thoughts.slice(-10)) lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
  }
  const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
  const names = Object.keys(impressions);
  if (names.length) {
    lines.push('【对群友的印象】');
    for (const name of names.slice(-10)) {
      const im = impressions[name] || {};
      lines.push(`- ${name}：${Array.isArray(im.traits) && im.traits.length ? im.traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
    }
  }
  return lines.join('\n');
}
