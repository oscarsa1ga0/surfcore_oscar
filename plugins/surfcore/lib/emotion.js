import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readCurrentCharacter } from '../../../src/character-persona.js';
import {
  applyEmotionEvent, composeCharacterContext, DIMENSIONS, EMOTION_SOURCES, emotionSnapshot,
  EVENT_RETENTION_MS, isEmotionKind, MOOD_STAGES, normalizeEmotionSettings,
} from '../../../src/emotion.js';
import { emotionPaths, makeEmotionEvent, readEmotionState, validEmotionScope } from '../../../src/emotion-events.js';

const MAX_BATCH = 512;
const hint = '检查当前角色的情绪目录及磁盘权限，再刷新情绪页';

function commit(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

export function createEmotionService({ getRole = readCurrentCharacter, now = Date.now, log = () => {} } = {}) {
  const bindings = new Map();
  let lastError = null;

  function fail(error) {
    if (!lastError) log(`[emotion] 状态读写失败：${error?.code || error?.name || 'EMOTION_STORE'}`);
    lastError = { code: 'EMOTION_STORE', error: '情绪状态暂时无法读取或保存', hint };
  }

  function load(role) {
    const stamp = now();
    const paths = emotionPaths(role);
    const state = readEmotionState(role, stamp);
    const settings = normalizeEmotionSettings(state.settings);
    let names = [];
    try { names = fs.readdirSync(paths.inbox); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const batch = [];
    const consumed = [];
    for (const name of names.filter((item) => /^[0-9a-f]{64}\.json$/.test(item)).slice(0, MAX_BATCH)) {
      const file = path.join(paths.inbox, name);
      let record;
      try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      consumed.push(file);
      if (record.id !== name.slice(0, -5) || record.characterId !== role.id || record.epoch !== role.epoch
          || !validEmotionScope(record) || !isEmotionKind(record.kind) || !Number.isFinite(record.at)
          || record.at < stamp - EVENT_RETENTION_MS || record.at > stamp || !settings.enabled || !settings.sources[record.source]) continue;
      batch.push(record);
    }
    batch.sort((a, b) => a.at - b.at
      || String(a.order ?? '').padStart(24, '0').localeCompare(String(b.order ?? '').padStart(24, '0'))
      || a.id.localeCompare(b.id));
    if (batch.length && !state.recent.length && !Object.keys(state.seen).length) state.at = batch[0].at;
    let changed = false;
    for (const event of batch) changed = applyEmotionEvent(state, event) || changed;
    if (changed) commit(paths.state, state);
    for (const file of consumed) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    lastError = null;
    return { state, settings };
  }

  function snapshot(scope = {}, role = getRole()) {
    if (!role?.id) return null;
    const current = getRole();
    if (current?.id !== role.id || current?.epoch !== role.epoch) return null;
    try {
      const { state, settings } = load(role);
      return settings.enabled ? emotionSnapshot(state, { now: now(), ...scope }) : null;
    } catch (error) {
      fail(error);
      return null;
    }
  }

  function record(event, role = getRole()) {
    const current = getRole();
    if (!role?.id || current?.id !== role.id || current?.epoch !== role.epoch) return false;
    try {
      const clean = makeEmotionEvent(event, role, now());
      if (!clean) return false;
      const { state, settings } = load(role);
      if (!settings.enabled || !settings.sources[clean.source] || !applyEmotionEvent(state, clean)) return false;
      commit(emotionPaths(role).state, state);
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  }

  function status() {
    const role = getRole();
    if (!role?.id) return { ok: true, character: null, dimensions: DIMENSIONS, sources: EMOTION_SOURCES, stages: MOOD_STAGES };
    try {
      const { state, settings } = load(role);
      const stamp = now();
      const view = emotionSnapshot(state, { now: stamp, aggregate: true });
      const conflicts = Object.entries(state.conflicts).map(([partner, conflict]) => {
        const source = conflict.source || 'qq-private';
        const view = emotionSnapshot(state, { source, partner, channel: conflict.channel, now: stamp, aggregate: true });
        return { source, stage: view.stage, blame: view.blame, knot: view.knot, at: conflict.at };
      }).filter((item) => item.blame > 0).sort((a, b) => b.at - a.at).slice(0, 12);
      return {
        ok: true, character: { id: role.id, epoch: role.epoch, name: role.name },
        dimensions: DIMENSIONS, sources: EMOTION_SOURCES, stages: MOOD_STAGES,
        settings, ...view, conflicts, recent: state.recent.slice(-15).reverse(),
      };
    } catch (error) {
      fail(error);
      return { ok: false, ...lastError };
    }
  }

  return {
    status, record, snapshot,
    drain() { snapshot(); },
    context(persona, scope, role) { return composeCharacterContext(persona, snapshot(scope, role)); },
    configure(body) {
      const role = getRole();
      if (!role?.id || role.id !== body?.characterId || role.epoch !== body?.epoch) {
        return { ok: false, code: 'EMOTION_ROLE_CHANGED', error: '当前角色已经切换', hint: '刷新情绪页后再修改' };
      }
      try {
        const { state, settings } = load(role);
        state.settings = normalizeEmotionSettings({
          ...settings, ...body.settings, sources: { ...settings.sources, ...body.settings?.sources },
        });
        commit(emotionPaths(role).state, state);
        return status();
      } catch (error) {
        fail(error);
        return { ok: false, ...lastError };
      }
    },
    bind(sessionId, scope, role = getRole()) {
      if (!sessionId || !role?.id || !validEmotionScope(scope)) return;
      bindings.delete(sessionId);
      if (bindings.size >= 400) bindings.delete(bindings.keys().next().value);
      bindings.set(sessionId, { role, scope });
    },
    binding(sessionId) { return bindings.get(sessionId) || null; },
    nativeRole(workspace) {
      if (!workspace || !path.isAbsolute(workspace)) return null;
      const role = getRole();
      if (!role?.id) return null;
      try {
        const settings = normalizeEmotionSettings(readEmotionState(role).settings);
        const real = fs.realpathSync(workspace);
        return [role.dir, ...settings.nativeWorkspaces].some((folder) => {
          try { return fs.realpathSync(folder) === real; } catch { return false; }
        }) ? role : null;
      } catch { return null; }
    },
  };
}
