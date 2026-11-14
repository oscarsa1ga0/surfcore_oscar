/**
 * 后台渲染执行器（阶段一）：SQLite 队列 + 租约 + fencing + 打断恢复。
 *
 * 对应方案 §3：
 *   · 启动时恢复队列（租约过期的 running → retryable）；
 *   · 领取任务在事务里递增 fencing token，旧 worker 的提交被条件更新拒绝；
 *   · 宿主卸载时停止领活并终止受管子进程（任务留在 running，下次启动接管）；
 *   · 长操作（TTS/FFmpeg）异步等待子进程，DSH 对话只提交任务、查看状态；
 *   · 预算：全机同时最多 1 个渲染任务（maxConcurrent），渲染超时按配置。
 *
 * 任务失败分类（决定 retryable / blocked）：
 *   · 网络/TTS/FFmpeg 瞬时失败 → retryable（指数退避，最多 30 分钟一次）；
 *   · 计划、素材、质检等确定性失败 → blocked（改计划/素材后由用户重试）。
 */
import { renderRevision } from './render.js';
import { resolveVoiceSettings } from './voice.js';

// 重试分类：瞬时/网络类失败按退避重试；配置与依赖缺失是确定性失败，
// 重试只会浪费预算，直接 blocked（提示改配置后手动重试）。
const RETRYABLE_CODES = new Set([
  'VIDEO_TTS_BAD_WAV', 'VIDEO_TTS_BAD_DURATION',
  'VIDEO_FFMPEG_FAILED', 'VIDEO_FFMPEG_TIMEOUT',
  'VIDEO_ASSET_FILE_MISSING',
]);

const DEFAULT_LEASE_MS = 20 * 60 * 1000;
const DEFAULT_TICK_MS = 1500;
const HEARTBEAT_MS = 60 * 1000;

export function createVideoWorker({ store, root, getVoiceSettings = null, getLimits = () => ({}), synth = null, log = () => {}, maxConcurrent = 1, leaseMs = DEFAULT_LEASE_MS, tickMs = DEFAULT_TICK_MS, renderTimeoutMs = 10 * 60 * 1000, publisher = null }) {
  const owner = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let running = false;
  let timer = null;
  const active = new Map(); // jobId → { abort: AbortController, task }
  let stopped = false;
  let publishAbort = null;
  let publishing = false;
  let status = { running: false, startedAt: null, activeCount: 0, jobs: [] };

  const refreshStatus = () => {
    status = {
      running,
      startedAt: status.startedAt,
      owner,
      activeCount: active.size,
      jobs: [...active.values()].map(({ task }) => task.jobId),
    };
  };

  async function runTask(claimed) {
    const { task, fence } = claimed;
    const abort = new AbortController();
    active.set(task.jobId, { abort, task });
    refreshStatus();
    const limits = getLimits();
    const timeoutMs = limits.renderTimeoutMs || renderTimeoutMs;
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
    deadline.unref?.();
    const heartbeat = setInterval(() => {
      const ok = store.heartbeatTask(task.jobId, fence, leaseMs);
      if (!ok) {
        // 租约被接管（本进程卡死过）：立即放弃
        abort.abort();
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    const canCommit = () => {
      const row = store.getTaskRow(task.jobId);
      return row?.state === 'running' && row.fence === fence;
    };
    const progress = (p) => {
      if (!canCommit()) abort.abort(); // 被取消
      store.setTaskProgress(task.jobId, { ...p, owner, at: Date.now() });
    };
    try {
      const voiceSettings = synth ? null : (getVoiceSettings ? getVoiceSettings() : resolveVoiceSettings());
      const result = await renderRevision({
        store,
        root,
        projectId: task.projectId,
        revision: task.revision,
        voiceSettings,
        synth,
        limits,
        canCommit,
        onProgress: progress,
        abortSignal: abort.signal,
        log,
      });
      if (!store.completeTask(task.jobId, fence)) return { jobId: task.jobId, ok: false, code: 'VIDEO_CANCELLED' };
      store.markPreview(task.projectId, task.revision);
      return { jobId: task.jobId, ok: true, summary: result.summary };
    } catch (error) {
      const code = timedOut ? 'VIDEO_RENDER_TIMEOUT' : error?.code ?? 'VIDEO_TASK_FAILED';
      if (!timedOut && (abort.signal.aborted || code === 'VIDEO_CANCELLED')) {
        // 取消/宿主停止：任务留在 running（下次启动 recoverOnStart 立即接管续跑）。
        // 用户显式 cancel 已由 cancelProjectTasks 改状态，这里不再写。
        log(`[video-worker] 任务 ${task.jobId} 被中断，留待恢复`);
        return { jobId: task.jobId, ok: false, code, interrupted: true };
      }
      const retryable = RETRYABLE_CODES.has(code);
      const stage = store.getTask(task.jobId)?.progress?.stage ?? error?.stage ?? '';
      store.failTask(task.jobId, fence, {
        code,
        error: timedOut ? `渲染超过 ${Math.round(timeoutMs / 1000)} 秒` : String(error?.message ?? error),
        hint: String(error?.hint ?? (retryable ? '会自动按退避重试；也可以现在手动重试' : '改计划/素材后重试')),
        retryable,
        stage: error?.stage ?? stage,
      });
      return { jobId: task.jobId, ok: false, code, retryable };
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      active.delete(task.jobId);
      refreshStatus();
    }
  }

  function tickPublisher() {
    if (!publisher || publishing) return;
    publishing = true;
    const controller = new AbortController();
    publishAbort = controller;
    void publisher.tick(controller.signal).catch(() => {
      if (!controller.signal.aborted) log('[video-worker] 投稿队列暂不可用，请刷新稿件状态');
    }).finally(() => {
      publishAbort = null;
      publishing = false;
    });
  }

  async function tick() {
    if (!running || stopped) return;
    tickPublisher();
    try {
      const claimed = store.claimNextTask({ owner, leaseMs, maxConcurrent });
      if (claimed) {
        const result = await runTask(claimed);
        if (result?.ok) log(`[video-worker] 任务完成 ${result.jobId}`);
        else log(`[video-worker] 任务失败 ${result.jobId}（${result.code}${result.retryable ? '，将重试' : ''}）`);
      }
    } catch (error) {
      log(`[video-worker] tick 失败：${String(error?.message ?? error)}`);
    }
    // 串行：一轮只跑一个任务；完成后下一轮立即再领
    if (running && !stopped) scheduleNext();
  }

  function scheduleNext() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, tickMs);
    timer.unref?.();
  }

  return {
    start() {
      if (running) return status;
      running = true;
      stopped = false;
      status.startedAt = new Date().toISOString();
      try {
        const recovered = store.recoverOnStart();
        if (recovered.recovered > 0) log(`[video-worker] 恢复 ${recovered.recovered} 个中断任务`);
      } catch (error) {
        log(`[video-worker] 启动恢复失败：${String(error?.message ?? error)}`);
      }
      refreshStatus();
      void tick();
      return status;
    },

    stop() {
      stopped = true;
      publishAbort?.abort();
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const { abort } of active.values()) {
        try { abort.abort(); } catch {}
      }
      refreshStatus();
      return status;
    },

    /** 任务被外部取消时（cancelProjectTasks），立刻中断对应子进程。 */
    cancel(jobId) {
      const entry = active.get(jobId);
      if (entry) {
        try { entry.abort.abort(); } catch {}
        return true;
      }
      return false;
    },

    status() {
      return status;
    },

    /** 等待所有在跑任务结束（宿主退出前的 grace 收尾）。 */
    async drain(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while ((active.size > 0 || publishing) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return active.size;
    },
  };
}
