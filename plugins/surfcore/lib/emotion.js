import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readCurrentCharacter } from '../../../src/character-persona.js';
import {
  applyEmotionEvent, composeCharacterContext, DIMENSIONS, emotionCanRecord, emotionInitialized,
  EMOTION_SOURCES, emotionSnapshot,
  EVENT_RETENTION_MS, isEmotionKind, MOOD_STAGES, normalizeEmotionSettings,
} from '../../../src/emotion.js';
import { emotionPaths, makeEmotionEvent, readEmotionState, spoolEmotionEvent, validEmotionScope } from '../../../src/emotion-events.js';

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

function initializationError(code, error, hint) {
  return { ok: false, code, error, hint };
}

function parseSelfAssessment(text) {
  const trimmed = String(text ?? '').trim();
  const json = /^```(?:json)?\s*([\s\S]+?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
  const value = JSON.parse(json);
  const keys = Object.keys(DIMENSIONS);
  if (!value || typeof value !== 'object' || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key) || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 100)) {
    throw new Error('invalid self-assessment');
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

export function createEmotionService({ getRole = readCurrentCharacter, now = Date.now, log = () => {} } = {}) {
  const bindings = new Map();
  const initializing = new Set();
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
    if (!emotionInitialized(state)) {
      lastError = null;
      return { state, settings };
    }
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
          || record.at < Math.max(stamp - EVENT_RETENTION_MS, state.initialization?.at ?? 0) || record.at > stamp || !settings.enabled || !settings.sources[record.source]) continue;
      batch.push(record);
    }
    batch.sort((a, b) => a.at - b.at
      || String(a.order ?? '').padStart(24, '0').localeCompare(String(b.order ?? '').padStart(24, '0'))
      || a.id.localeCompare(b.id));
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
      return settings.enabled && emotionInitialized(state) ? emotionSnapshot(state, { now: now(), ...scope }) : null;
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
      if (!settings.enabled || !settings.sources[clean.source] || !emotionCanRecord(state, clean.at, now())) return false;
      if (!emotionInitialized(state)) {
        spoolEmotionEvent(role, clean);
        return true;
      }
      if (clean.at < (state.initialization?.at ?? 0) || !applyEmotionEvent(state, clean)) return false;
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
      const initialized = emotionInitialized(state);
      const view = initialized ? emotionSnapshot(state, { now: stamp, aggregate: true }) : null;
      const conflicts = Object.entries(state.conflicts).map(([partner, conflict]) => {
        const source = conflict.source || 'qq-private';
        const view = emotionSnapshot(state, { source, partner, channel: conflict.channel, now: stamp, aggregate: true });
        return { source, stage: view.stage, blame: view.blame, knot: view.knot, at: conflict.at };
      }).filter((item) => item.blame > 0).sort((a, b) => b.at - a.at).slice(0, 12);
      return {
        ok: true, character: { id: role.id, epoch: role.epoch, name: role.name },
        dimensions: DIMENSIONS, sources: EMOTION_SOURCES, stages: MOOD_STAGES,
        settings, ...view, conflicts, recent: state.recent.slice(-15).reverse(),
        initialization: {
          status: initialized ? 'ready' : (initializing.has(role.id) ? 'filling' : 'pending'),
          source: state.initialization?.source ?? (initialized ? 'existing' : null),
          at: state.initialization?.at ?? null,
        },
      };
    } catch (error) {
      fail(error);
      return { ok: false, ...lastError };
    }
  }

  async function initialize(body, assess) {
    const role = getRole();
    const changed = () => initializationError('EMOTION_ROLE_CHANGED', '当前角色已经切换', '刷新情绪页后再操作');
    if (!role?.id || role.id !== body?.characterId || role.epoch !== body?.epoch) return changed();
    if (initializing.has(role.id)) {
      return initializationError('EMOTION_INITIALIZING', '正在填写初始心境', '等角色填写完再刷新情绪页');
    }

    const file = emotionPaths(role).state;
    const started = now();
    try {
      const state = readEmotionState(role, started);
      if (emotionInitialized(state)) return status();
      if (!normalizeEmotionSettings(state.settings).enabled) {
        return initializationError('EMOTION_DISABLED', '当前角色情绪功能已关闭', '先启用情绪再自评');
      }
      state.initializationStartedAt = started;
      commit(file, state);
    } catch (error) {
      fail(error);
      return { ok: false, ...lastError };
    }

    initializing.add(role.id);
    let published = false;
    try {
      const result = await assess(role);
      if (result?.ok === false) return result;
      let drives;
      try { drives = parseSelfAssessment(result?.text); }
      catch { return initializationError('EMOTION_SELF_FORMAT', '这次自评没有返回有效的九维数值', '点「请她自评」重试'); }
      const current = getRole();
      if (current?.id !== role.id || current.epoch !== role.epoch) return changed();
      const state = readEmotionState(role, started);
      if (emotionInitialized(state)) return status();
      if (!normalizeEmotionSettings(state.settings).enabled) {
        return initializationError('EMOTION_DISABLED', '自评期间关闭了情绪功能', '重新启用情绪后可以再自评');
      }
      state.drives = drives;
      state.at = started;
      state.initialization = { source: 'self', at: started };
      delete state.initializationStartedAt;
      commit(file, state);
      published = true;
    } catch (error) {
      fail(error);
      return { ok: false, ...lastError };
    } finally {
      initializing.delete(role.id);
      if (!published) {
        try {
          const state = readEmotionState(role);
          if (state.initializationStartedAt === started) {
            delete state.initializationStartedAt;
            commit(file, state);
          }
        } catch (error) { fail(error); }
      }
    }
    return status();
  }

  return {
    status, record, snapshot, initialize,
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
