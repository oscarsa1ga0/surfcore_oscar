/** Cross-process emotion input. Producers spool normalized events; the SurfCore host commits state. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { characterPaths, readCurrentCharacter } from './character-persona.js';
import {
  createEmotionState, EMOTION_SOURCES, emotionSnapshot, EVENT_RETENTION_MS, isEmotionKind, normalizeEmotionSettings,
} from './emotion.js';

const digest = (text) => createHash('sha256').update(String(text)).digest('hex');

export function dialogueEmotionScope(source, conversation, speaker = '') {
  return {
    source,
    channel: digest(`${source}:${conversation}`),
    ...(speaker ? { partner: digest(`${source}:${conversation}:${speaker}`) } : {}),
  };
}

export function emotionPaths(role) {
  const folder = path.join(characterPaths(role.id).dir, 'emotion');
  return { state: path.join(folder, 'state.json'), inbox: path.join(folder, 'inbox') };
}

export function readEmotionState(role, now = Date.now()) {
  if (!role?.id) return createEmotionState(now);
  let state;
  try { state = JSON.parse(fs.readFileSync(emotionPaths(role).state, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return createEmotionState(now);
    throw error;
  }
  if (state?.version !== 1 || !Number.isFinite(state.at) || !state.drives || !state.seen
      || !state.conflicts || !state.awaiting || !state.heat || !Array.isArray(state.recent)) {
    throw new Error('情绪状态格式异常');
  }
  return state;
}

export function readCurrentEmotion(role, scope = {}) {
  if (!role?.id) return null;
  try {
    const state = readEmotionState(role);
    const config = normalizeEmotionSettings(state.settings);
    return config.enabled ? emotionSnapshot(state, scope) : null;
  } catch { return null; }
}

export function validEmotionScope(value) {
  if (!value || typeof value.source !== 'string' || !Object.hasOwn(EMOTION_SOURCES, value.source)) return false;
  return ['channel', 'partner'].every((key) => value[key] === undefined || /^[0-9a-f]{64}$/.test(value[key]));
}

export function makeEmotionEvent(event, role = readCurrentCharacter(), now = Date.now()) {
  if (!role?.id || !Number.isSafeInteger(role.epoch) || !validEmotionScope(event) || !isEmotionKind(event?.kind)
      || typeof event.key !== 'string' || !event.key || event.key.length > 500) return null;
  const at = Number.isFinite(event.at) ? event.at : now;
  if (at < now - EVENT_RETENTION_MS || at > now + 60_000) return null;
  return {
    id: digest(`${event.source}:${event.key}`), characterId: role.id, epoch: role.epoch, at: Math.min(at, now),
    order: process.hrtime.bigint().toString(),
    kind: event.kind, source: event.source, partner: event.partner, channel: event.channel,
    owner: event.owner === true, inbound: event.inbound === true,
  };
}

/** Uses the role captured when the experience began, even when a background job finishes late. */
export function enqueueEmotionEvent(event, role = readCurrentCharacter(), onError = () => {}) {
  try {
    const record = makeEmotionEvent(event, role);
    if (!record) return false;
    const current = readCurrentCharacter();
    if (current?.id !== role.id || current.epoch !== role.epoch) return false;
    const { inbox } = emotionPaths(role);
    const config = normalizeEmotionSettings(readEmotionState(role).settings);
    if (!config.enabled || !config.sources[record.source]) return false;
    fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
    const tmp = path.join(inbox, `.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      fs.renameSync(tmp, path.join(inbox, `${record.id}.json`));
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}
