import { validEmotionScope } from '../../../src/emotion-events.js';
/** One DSH model turn at a time for SurfCore's current role. Only this host submits. */
const PRIORITY = { manual: 0, interaction: 1, scheduled: 2 };
const SOURCES = new Set(['qq', 'bili', 'diary']);
const QQ_LEASE_MS = 90_000;
const QQ_RECEIPT_LIMIT = 256;

export const QQ_DISPATCH_ROUTE = '/dsh-surfcore/api/role-dispatch/qq';

export function dispatchError(code, message, hint = '在 SurfCore → 概览 查看调度状态') {
  return Object.assign(new Error(message), { code, hint });
}

export function roleRef(character) {
  return character ? { characterId: character.id, epoch: character.epoch } : { characterId: 'default', epoch: 0 };
}

function sameRole(a, b) {
  return a?.characterId === b.characterId && a?.epoch === b.epoch;
}

function priority(job, now) {
  if (job.deadline - now <= 120_000) return 0;
  return Math.max(0, PRIORITY[job.priority] - Math.floor((now - job.queuedAt) / 60_000));
}

function receipt(result) {
  const value = result?.result ? result.result.value : result;
  return result?.result?.ok !== false && value?.ok !== false && (value?.accepted === true || Boolean(value?.command));
}

function idle(state) {
  return state?.running === false && Array.isArray(state.pendingInput) && state.pendingInput.length === 0
    && (Array.isArray(state.queue) ? state.queue.length === 0 : state.active === false && state.queue === null);
}

export function validQqDispatchRequest(request) {
  if (!request || !/^[a-f0-9-]{36}$/.test(request.id) || typeof request.role?.characterId !== 'string'
    || !Number.isSafeInteger(request.role.epoch)) return false;
  if (request.action === 'release' || request.action === 'receipt') return true;
  if (request.action === 'reserve') return Object.hasOwn(PRIORITY, request.priority);
  const prompt = request.prompt;
  return request.action === 'submit' && typeof prompt?.sessionId === 'string'
    && /^[A-Za-z0-9._-]{1,200}$/.test(prompt.sessionId)
    && (prompt.emotion === undefined || (validEmotionScope(prompt.emotion)
      && ['qq-private', 'qq-group'].includes(prompt.emotion.source)))
    && Array.isArray(prompt.content) && prompt.content.length > 0
    && prompt.content.every((part) => part?.type === 'text' && typeof part.text === 'string'
      || part?.type === 'image' && typeof part.data === 'string'
        && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mediaType));
}

export function createRoleDispatch({
  controller, getRole, load, save, preparePrompt = (_job, args) => args, startupSessions = async () => [], inFlight = new Set(),
  now = Date.now, pollMs = 1500, log = () => {},
}) {
  const jobs = new Map();
  const qqReceipts = new Map();
  let active = null;
  let restored = false;
  let started = false;
  let stopped = false;
  let checking = false;
  let timer;
  let lastError = null;
  let startup = null;
  let startupCursor = 0;

  function assertRole(role) {
    if (!sameRole(role, getRole())) throw dispatchError('ROLE_DISPATCH_ROLE_CHANGED', '角色已切换，本次请求已失效');
  }

  function expire(job, error) {
    if (jobs.get(job.id) === job) jobs.delete(job.id);
    if (active === job && !job.sessionId) active = null;
    job.reject?.(error);
  }

  function launch(job) {
    active = job;
    job.stage = 'preparing';
    if (!job.run) return;
    void Promise.resolve()
      .then(() => job.run((args, signal) => submit(job, args, signal)))
      .then(job.resolve, (error) => {
        if (error?.code !== 'ROLE_DISPATCH_EXPIRED' && error?.code !== 'ROLE_DISPATCH_STOPPED'
          && error?.code !== 'ROLE_DISPATCH_ROLE_CHANGED') {
          lastError = { at: now(), source: job.source, error: '调度任务执行失败', hint: error?.hint || '查看对应工作区或诊断日志后重试' };
          log(`[role-dispatch] ${job.source} 执行失败：${error?.code || error?.name || 'unknown'}`);
        }
        job.reject(error);
      })
      .finally(() => {
        if (active === job && !job.sessionId) expire(job);
        kick();
      });
  }

  async function isSettled(sessionId) {
    try {
      const result = await controller.wait({ sessionId, timeoutMs: 800, maxMessages: 1 }, AbortSignal.timeout(3000));
      return result?.reason === 'idle' && idle(result.state);
    } catch (error) {
      if (error?.code === 'session/not-found') return true;
      if (error?.code === 'session/wait-timeout' || error?.name === 'TimeoutError') return false;
      throw error;
    }
  }

  function restore() {
    if (restored) return;
    const saved = load();
    if (saved !== null) {
      if (!saved || !SOURCES.has(saved.source) || typeof saved.id !== 'string' || typeof saved.sessionId !== 'string'
        || !saved.role || !Number.isFinite(saved.startedAt)) {
        throw dispatchError('ROLE_DISPATCH_JOURNAL', '调度记录无法读取', '在诊断页核对调度记录与 DSH 的旧会话');
      }
      active = { ...saved, stage: 'checking' };
    }
    restored = true;
  }

  async function drain() {
    restore();
    const finished = active;
    if (finished?.sessionId && !inFlight.has(finished.id)) {
      if (await isSettled(finished.sessionId) && !stopped && !inFlight.has(finished.id) && active === finished) {
        save(null);
        active = null;
        if (jobs.get(finished.id) === finished) jobs.delete(finished.id);
        if (lastError?.code === 'ROLE_DISPATCH_CHECK_FAILED') lastError = null;
      }
    }
    if (stopped || active) return;
    startup ??= await startupSessions();
    while (startupCursor < startup.length) {
      if (!(await isSettled(startup[startupCursor]))) return;
      startupCursor += 1;
    }
    if (lastError?.code === 'ROLE_DISPATCH_CHECK_FAILED') lastError = null;
    const stamp = now();
    const next = [...jobs.values()].sort((a, b) => priority(a, stamp) - priority(b, stamp) || a.queuedAt - b.queuedAt)[0];
    if (next && !stopped) launch(next);
  }

  function kick() {
    if (!started || stopped) return;
    const stamp = now();
    for (const job of jobs.values()) {
      if (job.sessionId) continue;
      if (job.signal?.aborted) expire(job, dispatchError('ROLE_DISPATCH_STOPPED', '来源任务已停止'));
      else if (!sameRole(job.role, getRole())) expire(job, dispatchError('ROLE_DISPATCH_ROLE_CHANGED', '角色已切换，本次请求已失效'));
      else if (stamp >= job.deadline || stamp >= job.leaseUntil) {
        expire(job, dispatchError('ROLE_DISPATCH_EXPIRED', '等待超过本次任务的有效时间', '需要时重新发起任务'));
      }
    }
    if (checking || (active && !active.sessionId) || (!active && restored && startup && startupCursor >= startup.length && jobs.size === 0)) return;
    checking = true;
    void drain().catch((error) => {
      if (lastError?.code !== 'ROLE_DISPATCH_CHECK_FAILED') log(`[role-dispatch] 无法确认旧会话状态：${error?.code || error?.name || 'unknown'}`);
      lastError = { at: now(), code: 'ROLE_DISPATCH_CHECK_FAILED', error: '暂时无法确认 DSH 会话状态', hint: error?.hint || '检查 DSH 连接。恢复后会自动继续排队' };
    }).finally(() => { checking = false; });
  }

  function add(spec) {
    if (stopped) throw dispatchError('ROLE_DISPATCH_STOPPED', '会话调度正在重启');
    assertRole(spec.role);
    if (jobs.size >= 256) throw dispatchError('ROLE_DISPATCH_FULL', '会话排队已满', '等待当前任务处理后再试');
    const job = { ...spec, queuedAt: now(), stage: 'queued', deadline: spec.deadline ?? Infinity, leaseUntil: Infinity };
    jobs.set(job.id, job);
    return job;
  }

  async function submit(job, args, signal) {
    if (stopped || active !== job || job.stage !== 'preparing') throw dispatchError('ROLE_DISPATCH_EXPIRED', '本次任务的执行名额已失效');
    assertRole(job.role);
    if (now() >= job.deadline || now() >= job.leaseUntil) throw dispatchError('ROLE_DISPATCH_EXPIRED', '本次任务的有效时间已过');
    job.signal?.throwIfAborted();
    signal?.throwIfAborted();
    // The journal must be committed before DSH can accept anything. No prompt content is persisted here.
    const record = { id: job.id, source: job.source, role: job.role, sessionId: args.sessionId, startedAt: now() };
    save(record);
    Object.assign(job, record, { stage: 'submitting' });
    inFlight.add(job.id);
    try {
      const prepared = preparePrompt(job, args);
      const result = await controller.prompt({ ...prepared, requestId: job.id, mode: 'queue' }, signal ?? new AbortController().signal);
      job.stage = receipt(result) ? 'running' : 'checking';
      if (job.stage === 'running' && lastError?.source === job.source) lastError = null;
      return result;
    } catch (error) {
      job.stage = 'checking';
      throw error;
    } finally {
      inFlight.delete(job.id);
      kick();
    }
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      timer = setInterval(kick, pollMs);
      timer.unref?.();
      kick();
    },
    enqueue(spec, run) {
      const existing = jobs.get(spec.id);
      if (existing && (existing.sessionId || !existing.signal?.aborted)) return existing.result;
      if (existing) expire(existing,
        dispatchError('ROLE_DISPATCH_STOPPED', '来源任务已停止'));
      const job = add({ ...spec, run });
      job.result = new Promise((resolve, reject) => { Object.assign(job, { resolve, reject }); });
      kick();
      return job.result;
    },
    onTurnEnd(sessionId) {
      if (active?.sessionId === sessionId) kick();
    },
    async qq(request) {
      const { action, id, role } = request;
      assertRole(role);
      if (action === 'receipt') {
        if (qqReceipts.has(id)) return { state: 'received', result: qqReceipts.get(id) };
        return { state: active?.id === id && active.sessionId ? 'in-flight' : 'unknown' };
      }
      let job = jobs.get(id);
      if (action === 'reserve') {
        if (active?.id === id && active.sessionId) return { state: 'in-flight' };
        job ??= add({ id, role, source: 'qq', priority: request.priority });
        if (job.source !== 'qq' || !sameRole(job.role, role)) throw dispatchError('ROLE_DISPATCH_INVALID', '任务标识冲突');
        if (now() >= job.leaseUntil && !job.sessionId) {
          expire(job);
          return { state: 'expired' };
        }
        job.leaseUntil = now() + QQ_LEASE_MS;
        kick();
        return { state: active === job ? 'granted' : 'queued' };
      }
      if (job?.source !== 'qq' || !sameRole(job.role, role)) throw dispatchError('ROLE_DISPATCH_EXPIRED', 'QQ 任务名额已失效');
      if (action === 'release') {
        if (!job.sessionId) expire(job);
        kick();
        return { state: 'released' };
      }
      const { sessionId, content, emotion } = request.prompt;
      const value = await submit(job, { sessionId, content, ...(emotion ? { emotion } : {}) });
      const result = value?.result ? value : { result: receipt(value)
        ? { ok: true, value }
        : { ok: false, error: { code: 'ROLE_DISPATCH_REJECTED', message: 'DSH 拒绝接收 QQ 回合' } } };
      qqReceipts.set(id, result);
      if (qqReceipts.size > QQ_RECEIPT_LIMIT) qqReceipts.delete(qqReceipts.keys().next().value);
      return { result };
    },
    reportFailure(source, error, hint) {
      lastError = { at: now(), source, error, hint };
    },
    status() {
      const stamp = now();
      const pending = [...jobs.values()].filter((job) => job !== active);
      const waiting = [...SOURCES].map((source) => ({ source, count: pending.filter((job) => job.source === source).length })).filter((row) => row.count);
      return {
        active: active ? { id: active.id, source: active.source, stage: active.stage, since: active.startedAt ?? active.queuedAt, canStop: Boolean(active.sessionId) && !inFlight.has(active.id) } : null,
        checking: !restored || Boolean(startup && startupCursor < startup.length) || active?.stage === 'checking',
        waiting, waitingCount: pending.length,
        oldestWaitMs: pending.length ? Math.max(0, stamp - Math.min(...pending.map((job) => job.queuedAt))) : 0,
        lastError,
      };
    },
    async stopTurn(id) {
      const job = active;
      if (!job?.sessionId || job.id !== id || inFlight.has(id)) {
        throw dispatchError('ROLE_DISPATCH_STALE', '当前回合已切换或仍在提交', '刷新调度状态后再试');
      }
      inFlight.add(id);
      try {
        const { sessionId } = job;
        const state = await controller.state({ sessionId }, AbortSignal.timeout(5000));
        const pending = state.queue?.find((item) => item.rpcId === job.id);
        if (pending) {
          try { await controller.updateQueue({ sessionId, itemId: pending.id, action: { kind: 'remove' } }); }
          catch (error) { if (error?.code !== 'session/queue-item-not-found') throw error; }
        }
        await controller.cancel({ sessionId });
        job.stage = 'checking';
      } finally {
        inFlight.delete(id);
        kick();
      }
    },
    dispose() {
      stopped = true;
      clearInterval(timer);
      for (const job of jobs.values()) expire(job, dispatchError('ROLE_DISPATCH_STOPPED', '会话调度正在重启'));
    },
  };
}
