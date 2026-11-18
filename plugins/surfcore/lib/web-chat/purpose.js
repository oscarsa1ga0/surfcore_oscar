import { randomUUID } from 'node:crypto';
import {
  analyzePersona, applyPurposeOutcome, buildPurposePrompt, collectMaterials, deriveDrives, ensurePurposeSchedule, evaluatePurposeTick,
  formGoalHypotheses, localDateKey, markPurposeDelivered, markPurposeSkip, minePurposeSeeds,
  normalizePurposeConfig, normalizePurposeState, planNextFire, rollbackPurposeDelivered, selectPurpose,
  summarizePurposeState,
} from '../../../../src/purpose-engine.js';


export function createWebPurpose({ store, identity, config, readInputs, readState, writeState, focus, mood, onChange }) {
  let lastCheck = 0;

  function settle(chat, settings) {
    const state = normalizePurposeState(readState());
    if (state.webRunId && !store.turn(state.webRunId)) {
      rollbackPurposeDelivered(state);
      applyPurposeOutcome(state, { config: settings, outcome: 'delivery-failed' });
      delete state.webRunId;
      writeState(state);
    }
    for (const job of store.purposeOutcomes(chat)) {
      if (state.webRunId === job.id) {
        const now = Date.now();
        const text = job.replyText;
        if (job.failure) rollbackPurposeDelivered(state, { now });
        applyPurposeOutcome(state, { now, config: settings, outcome: job.failure ? 'delivery-failed' : text ? 'sent' : 'silent',
          planned: job.purpose.selected, text });
        delete state.webRunId;
        writeState(state);
      }
      store.update(job.id, job.state, { outcomePending: false, replyText: '' });
    }
  }

  function tick({ force = false, preview = false } = {}) {
    const now = Date.now();
    if (!force && !preview && now - lastCheck < 15_000) return { ok: true, skipped: 'interval' };
    if (!preview) lastCheck = now;
    const { role, name } = identity();
    const chat = role.characterId;
    const preferences = config();
    const settings = normalizePurposeConfig(preferences.purpose);
    if (!preview) settle(chat, settings);
    if (!preferences.proactive) return { ok: false, code: 'WEB_PURPOSE_DISABLED', error: '网页主动搭话尚未启用。', hint: '在 SurfCore → 鱼姬之家切换主私聊投递。' };
    const state = normalizePurposeState(readState(), now);
    const occupied = Boolean(store.queue(chat));
    if (occupied && !preview) return { ok: false, code: 'WEB_PURPOSE_BUSY', error: '鱼姬还有一轮对话待完成。', hint: '等当前回合结束后再试。' };

    const inputs = readInputs(store.snapshot(chat));
    const unscheduled = !state.nextFireAt;
    ensurePurposeSchedule(state, { now, config: settings });
    if (!force && !preview) {
      if (focus()) return { ok: true, skipped: 'focus' };
      const decision = evaluatePurposeTick({ now, config: settings, state, env: {
        enabled: settings.enabled, modeOk: true, dshReady: true, ownerAllowed: true, friendOk: true,
        ownerIdleMs: store.lastUserAt(chat) ? now - store.lastUserAt(chat) : Infinity,
      } });
      if (decision.action !== 'run') {
        if (decision.reason !== 'waiting') markPurposeSkip(state, { now, reason: decision.reason, nextFireAt: decision.nextFireAt });
        if (unscheduled || decision.reason !== 'waiting') writeState(state);
        return { ok: true, skipped: decision.reason };
      }
    }

    const lastMasterAt = store.lastUserAt(chat);
    const packet = collectMaterials({ now, config: settings, roleName: name, ...inputs });
    const persona = analyzePersona(inputs.persona);
    const seen = new Set((state.observations ?? []).flatMap((item) => item.seenIds ?? []));
    const derived = deriveDrives({ ...state, now, lastMasterAt, materials: packet.items.filter((item) => !seen.has(item.id)), personaBias: persona.bias });
    const shared = { now, config: settings, lastMasterAt, roleName: name, materials: packet.items, drives: derived.drives,
      history: state.history, pending: state.pending, goals: state.goals, observations: state.observations, persona };
    const formed = formGoalHypotheses(shared);
    const { purpose, candidates } = selectPurpose({ ...shared, goals: formed.goals, seeds: minePurposeSeeds(shared), emotion: mood() });
    if (!purpose) {
      if (!preview) {
        markPurposeSkip(state, { now, reason: 'no-purpose', nextFireAt: planNextFire({ now, config: settings, lastRunAt: state.lastRunAt, countToday: state.countToday }) });
        writeState(state);
      }
      return { ok: false, code: 'WEB_PURPOSE_EMPTY', error: '这轮还没有选出想说的话。', hint: '聊天或积累活动后，可以再试一次。' };
    }
    const prompt = buildPurposePrompt({
      now, config: settings, mode: 'web', ownerName: inputs.ownerName,
      contextBlocks: [inputs.persona, inputs.memoryCard, inputs.biliBrief].filter(Boolean),
      materials: packet.items, candidates, selected: purpose,
      pending: state.pending, history: state.history, drives: derived.drives,
    });
    if (preview) return { ok: true, selected: purpose, prompt, materials: packet.items, state: summarizePurposeState(state, { config: settings, now }) };

    const id = randomUUID();
    Object.assign(state, { drives: derived.drives, drivesAt: derived.drivesAt, goals: formed.goals, observations: formed.observations,
      lastMaterialCount: packet.items.length, webRunId: id, nextFireAt: 0 });
    markPurposeDelivered(state, { now, planned: purpose });
    writeState(state);
    try {
      store.enqueue(chat, id, { kind: 'purpose', purpose: { prompt, selected: purpose } });
    } catch (error) {
      rollbackPurposeDelivered(state, { now });
      applyPurposeOutcome(state, { now, config: settings, outcome: 'delivery-failed', planned: purpose });
      delete state.webRunId;
      writeState(state);
      throw error;
    }
    onChange();
    return { ok: true, queued: true, selected: purpose };
  }
  return { tick, status: () => summarizePurposeState(normalizePurposeState(readState()), { config: normalizePurposeConfig(config().purpose) }) };
}
