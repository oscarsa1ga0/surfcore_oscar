/**
 * 日记的每日回顾调度（插件宿主内）。
 *
 * 复用 B 站生物钟的机制：插件常驻 DSH → 每 60 秒 tick → 到点用
 * `ctx.sessionController.prompt({ sessionId, mode:'queue', content:[...] })`
 * 叫醒一个**专用日记会话**，由她自己的 Agent 决定写不写、写什么。
 *
 * 不把日记任务塞进 QQ 会话：不打断聊天、不污染上下文、也不依赖 QQ 是否在线。
 *
 * 状态在 characters/<id>/diary/scheduler-state.json：
 *   lastReviewedDay / attempts / lastAttemptAt / lastError / submittedAt
 * 同一天只提交一次；失败最多重试 maxAttempts 次；离线恢复只补最近一次（窗口内）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  archiveCandidates, ensureDiaryDir, listCandidates, localDay, readSchedulerState,
  scanEntries, writeSchedulerState,
} from '../../../src/diary-store.js';
import { SENSITIVE_RE } from '../../../src/sensitive.js';

export const DIARY_PRESET = 'surfcore-diary';
export const DIARY_WORKSPACE_TITLE = '日记';
const TICK_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeDiaryConfig(raw = {}) {
  const out = {};
  out.enabled = raw?.enabled !== false;
  out.autoReview = raw?.autoReview !== false;
  out.reviewAt = /^\d{1,2}:\d{2}$/.test(String(raw?.reviewAt ?? '')) ? String(raw.reviewAt) : '23:30';
  out.catchUpHours = Math.max(0, Math.min(72, Number(raw?.catchUpHours ?? 6) || 0));
  out.maxAttempts = Math.max(1, Math.min(5, Math.round(Number(raw?.maxAttempts ?? 2) || 2)));
  out.captureEnabled = raw?.captureEnabled !== false;
  out.leakGuard = raw?.leakGuard !== false;
  out.digestMaxChars = Math.max(1000, Math.min(30000, Number(raw?.digestMaxChars ?? 8000) || 8000));
  out.preset = DIARY_PRESET;
  return out;
}

function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function localReviewAt(day, clock) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, clock.hour, clock.minute, 0, 0).getTime();
}

/**
 * 判断这一 tick 该不该回顾、回顾哪一天。纯函数，便于单测。
 * @returns {{due:string, at:number, attempts:number}|null}
 */
export function planDueReview({ now = Date.now(), config = {}, state = {} } = {}) {
  const cfg = normalizeDiaryConfig(config);
  if (cfg.enabled === false || cfg.autoReview === false) return null;
  const clock = parseClock(cfg.reviewAt);
  if (!clock) return null;
  const today = localDay(now);
  const yesterday = localDay(now - DAY_MS);
  const todayAt = localReviewAt(today, clock);
  const yesterdayAt = localReviewAt(yesterday, clock);
  let due = '';
  if (now >= todayAt) due = today;
  else if (now - yesterdayAt <= cfg.catchUpHours * 60 * 60 * 1000) due = yesterday;
  if (!due) return null;
  if (state?.lastReviewedDay === due) return null;
  // 手动「立即整理」不等于完成了当天的定时回顾：下午点过一次，晚上 23:30 仍应照常整理。
  // 只有手动整理发生在定时点前 30 分钟内（或定时点之后）时，才跳过这次定时，避免刚点完又跑一遍。
  const manualAt = Date.parse(String(state?.lastManualAt ?? ''));
  const dueAt = due === today ? todayAt : yesterdayAt;
  if (Number.isFinite(manualAt) && localDay(manualAt) === due && manualAt >= dueAt - 30 * 60 * 1000) return null;
  const attempts = Number(state?.attempts?.[due] ?? 0) || 0;
  if (attempts >= cfg.maxAttempts) return null;
  return { due, at: dueAt, attempts };
}

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function hhmm(ms) {
  try {
    return new Date(ms).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', hour12: false }).slice(0, 5);
  } catch {
    return '--:--';
  }
}

function dayOf(ms) {
  try { return localDay(ms); } catch { return ''; }
}

function safeLine(text, max = 160) {
  const value = String(text ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!value) return '';
  if (SENSITIVE_RE.test(value)) return '[含敏感信息，已省略]';
  return value.slice(0, max);
}

function pushBounded(lines, line, budget, counters) {
  if (!line) return;
  const used = lines.join('\n').length;
  if (used + line.length + 1 > budget) { counters.truncated = true; return; }
  lines.push(line);
}

/**
 * 收集“今天可访问的经历”。只读现有状态文件，不新建聊天副本：
 *   · QQ：state/social-v2.json 的 recentMessages（桥接已经持久化的最近 100 条/会话）
 *   · B站：角色目录 bili/whale-log.jsonl（她自己的事件流）
 *   · 日记：当天的候选 + 已写条目
 * 这不是聊天全文，是给她的“原材料”；写不写、写什么由她决定。
 */
export function buildDailyDigest({
  characterDir, qqStateDir, day = '', now = Date.now(), maxChars = 8000, history = null,
} = {}) {
  const target = day || localDay(now);
  const budget = Math.max(1000, Math.min(30000, Number(maxChars) || 8000));
  const lines = [];
  const counters = { messages: 0, conversations: 0, bili: 0, candidates: 0, entries: 0, truncated: false, history: 0, sampled: false };
  const used = () => lines.join('\n').length;

  // ── 当日完整聊天（优先）：网关历史接口一次取当天全部消息，解决 recentMessages 只有 100 条的问题。
  const historyChatLines = [];
  const historyConversations = history?.conversations && typeof history.conversations === 'object'
    ? history.conversations
    : (history && typeof history === 'object' && !Array.isArray(history) ? history : null);
  if (historyConversations) {
    for (const [key, value] of Object.entries(historyConversations)) {
      const list = (Array.isArray(value) ? value : [])
        .filter((message) => Number(message?.time) && dayOf(Number(message.time)) === target)
        .sort((a, b) => Number(a.time) - Number(b.time));
      if (!list.length) continue;
      counters.conversations += 1;
      counters.history += list.length;
      // 一天消息很多时按小时取「头尾」采样，保证上午/下午/晚上都出现在材料里，
      // 而不是被 100 条窗口或预算截断成只剩晚上。
      const sample = list.length > 80
        ? (() => {
            const byHour = new Map();
            for (const message of list) {
              const hour = new Date(Number(message.time)).toLocaleTimeString('sv-SE', { hour: '2-digit', hour12: false }).slice(0, 2);
              const group = byHour.get(hour) || [];
              group.push(message);
              byHour.set(hour, group);
            }
            const picked = [];
            const seen = new Set();
            for (const hour of [...byHour.keys()].sort()) {
              const group = byHour.get(hour);
              for (const message of [...group.slice(0, 2), ...group.slice(-2)]) {
                const id = `${message.time}|${message.isSelf ? 1 : 0}|${message.text || ''}`;
                if (seen.has(id)) continue;
                seen.add(id);
                picked.push(message);
              }
            }
            counters.sampled = true;
            return picked;
          })()
        : list;
      historyChatLines.push(`— ${key.replace(/^private:/, '私聊 ').replace(/^group:/, '群 ')} —`);
      for (const message of sample) {
        const who = message.isSelf ? '我' : safeLine(message.sender || '对方', 24);
        const body = safeLine(message.text || '', 180);
        if (!body) continue;
        counters.messages += 1;
        historyChatLines.push(`[${hhmm(Number(message.time))}] ${who}：${body}`);
      }
    }
  }

  // ── QQ 聊天（回退）：桥接持久化的 recentMessages（最多 100 条/会话）。
  const social = qqStateDir ? readJson(path.join(qqStateDir, 'social-v2.json'), {}) : {};
  const conversations = social?.conversations && typeof social.conversations === 'object' ? social.conversations : {};
  const chatLines = [];
  if (!historyChatLines.length) {
    for (const [key, value] of Object.entries(conversations)) {
      const messages = Array.isArray(value?.recentMessages) ? value.recentMessages : [];
      const todayMessages = messages
        .filter((message) => Number(message?.time) && dayOf(Number(message.time)) === target)
        .slice(-40);
      if (!todayMessages.length) continue;
      counters.conversations += 1;
      chatLines.push(`— ${key.replace(/^private:/, '私聊 ').replace(/^group:/, '群 ')} —`);
      for (const message of todayMessages) {
        const who = message.isSelf ? '我' : safeLine(message.sender || message.ownerLabel || '对方', 24);
        const body = safeLine(message.text || message.plain || '', 180);
        if (!body) continue;
        counters.messages += 1;
        chatLines.push(`[${hhmm(Number(message.time))}] ${who}：${body}`);
      }
    }
  }
  const pickedChatLines = historyChatLines.length ? historyChatLines : chatLines;
  if (pickedChatLines.length) {
    lines.push('【今天的聊天片段（节选，不是全文）】');
    for (const line of pickedChatLines) pushBounded(lines, line, budget, counters);
    lines.push('');
  }

  // ── B站 事件流 ──
  const biliLog = path.join(characterDir || '', 'bili', 'whale-log.jsonl');
  try {
    const raw = fs.readFileSync(biliLog, 'utf8');
    const rows = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (!event?.at || dayOf(Date.parse(event.at)) !== target) continue;
        const note = safeLine(event.note, 100);
        rows.push(`[${hhmm(Date.parse(event.at))}] ${safeLine(event.kind, 40)}${event.target ? ` ${safeLine(event.target, 40)}` : ''}${note ? `：${note}` : ''}`);
      } catch {}
    }
    if (rows.length) {
      lines.push('【今天在其他平台的事（B站）】');
      for (const line of rows.slice(-30)) { counters.bili += 1; pushBounded(lines, line, budget, counters); }
      lines.push('');
    }
  } catch {}

  // ── 候选 ──
  try {
    const candidates = listCandidates(path.join(characterDir || '', 'diary'), { day: target, now }).items;
    if (candidates.length) {
      lines.push('【今天你自己攒下的候选】');
      for (const item of candidates.slice(-30)) {
        counters.candidates += 1;
        pushBounded(lines, `- ${safeLine(item.note, 200)}${Array.isArray(item.tags) && item.tags.length ? `（${item.tags.join('/')}）` : ''}`, budget, counters);
      }
      lines.push('');
    }
  } catch {}

  // ── 今天已经写过的 / 最近写过的 ──
  try {
    const { entries } = scanEntries(path.join(characterDir || '', 'diary'));
    const todayEntries = entries.filter((entry) => entry.date === target);
    if (todayEntries.length) {
      lines.push('【今天已经写过的日记】');
      for (const entry of todayEntries.slice(0, 5)) {
        counters.entries += 1;
        pushBounded(lines, `- ${entry.id}「${entry.title || '无题'}」${entry.visibility === 'shareable' ? '（可分享）' : '（私人）'}`, budget, counters);
      }
      lines.push('');
    }
    const recent = entries.filter((entry) => entry.date < target).slice(0, 3);
    if (recent.length) {
      lines.push('【最近写过的（只给标题，需要就看 diary_read）】');
      for (const entry of recent) pushBounded(lines, `- ${entry.date} ${entry.id}「${entry.title || '无题'}」`, budget, counters);
      lines.push('');
    }
  } catch {}

  if (!lines.length) {
    lines.push('（今天没有攒下候选，也没有可读的聊天片段或平台事件。）');
  }
  if (counters.truncated) lines.push('（以上内容按预算截断，不是全部。）');
  return { day: target, text: lines.join('\n').trim(), counters, chars: Math.min(used(), budget) };
}

/** 给日记会话的唤醒提示：只给原材料和边界，不规定她必须写什么。 */
export function buildReviewPrompt({
  day, characterId = '', characterName = '', persona = '', memory = '', digest = '', reviewAt = '23:30',
} = {}) {
  const blocks = [];
  blocks.push(`【日记时间】${day} ${reviewAt}，这一天要收尾了。`);
  if (characterName) blocks.push(`【你是谁】${characterName}`);
  if (persona) blocks.push(`【你的人格（节选）】\n${String(persona).slice(0, 4000)}`);
  if (memory) blocks.push(`【你记得的事（节选）】\n${String(memory).slice(0, 2500)}`);
  blocks.push(String(digest || '').trim() || '（今天没有可用的原材料。）');
  blocks.push([
    '【怎么写】',
    '- 写不写由你决定。没有值得记的事就什么都不做，直接结束这一轮；不写不算失败。',
    '- 写就用自己的第一人称、平时的口吻，写给自己，不是给主人交报告；不要套模板，不要为了显得丰富而编造。',
    '- 值得留、但还不想写成整篇的，用 diary_capture 记一句；想写就用 diary_write 保存（可传 source: "diary"）。',
    '- 可以翻自己以前的日记（diary_read / diary_search / diary_list）；想补写哪一天就传 date。',
    '- 如果今天已经写过、但漏了上午/某些事，优先 diary_edit 追加，不要重写整篇或再写一篇重复的。',
    '- 日记默认是私人的。主人要看时，你可以决定给看、只给一段，或拒绝；要展示先 diary_share。',
    '- 写完不用通知主人，也不要给任何人发消息。',
    characterId ? `- 当前角色 id：${characterId}（调用日记工具时可带上 characterId，防止角色切换后写错人）` : '',
  ].filter(Boolean).join('\n'));
  return blocks.join('\n\n');
}

function service(ctx, name) {
  try { const found = ctx?.[name]; if (found) return found } catch {}
  try { return ctx?.get?.(name) } catch { return undefined }
}

/**
 * 启动每日回顾。
 * @param {object} ctx DSH 插件宿主上下文（需要 sessionController）
 * @param {object} opts { dshHome, characterId, characterDir, characterName, sessionId, readConfig, now, log, tokenBudget, autoTick }
 */
export function startDiaryScheduler(ctx, {
  dshHome, characterId, characterDir, characterName = '', sessionId, qqStateDir = '',
  readConfig = () => ({}), now = () => Date.now(), log = () => {}, tokenBudget = null, autoTick = true,
  fetchDayHistory = null,
} = {}) {
  if (!ctx?.sessionController) throw new Error('sessionController 不可用，无法启动日记回顾');
  if (!characterDir) throw new Error('缺少角色目录，无法启动日记回顾');
  const diaryDir = path.join(characterDir, 'diary');
  const agentDir = path.join(dshHome || '', 'surfcore', 'state', 'diary-agent');
  try { ensureDiaryDir(diaryDir); } catch (error) { log(`[diary] 创建目录失败：${String(error?.message ?? error)}`); }
  // 一次性迁移：旧版调度器漏传 AbortSignal 时会把 attempts 加到上限，导致修复后当天不再重试。
  try {
    const state = readSchedulerState(diaryDir);
    if (state.lastError && /throwIfAborted|Cannot read properties of undefined/.test(state.lastError)) {
      writeSchedulerState(diaryDir, { ...state, attempts: {}, lastError: '' });
      log('[diary] 已清理旧版 AbortSignal 失败留下的重试计数');
    }
  } catch {}
  const sid = sessionId || `diary-${characterId || 'current'}`;

  let stopped = false;
  let running = false;
  let timer = null;
  let sessionReady = false;
  let lastError = '';
  let lastTickAt = 0;

  function cfg() {
    try { return normalizeDiaryConfig(readConfig() ?? {}); } catch { return normalizeDiaryConfig({}); }
  }

  async function ensureSession() {
    if (sessionReady) return true;
    try {
      await ctx.sessionController.inspect(sid);
      sessionReady = true;
      return true;
    } catch {}
    try {
      fs.mkdirSync(agentDir, { recursive: true });
    } catch {}
    // DSH 新版里 workspaceId 与 cwd 互斥：有 workspaceController 就建一个「日记」工作区，
    // 没有就退回专用 cwd（至少不落回用户主目录）。
    let workspaceId = null;
    const workspaceController = service(ctx, 'workspaceController');
    if (workspaceController?.create) {
      try {
        const value = await workspaceController.create({ path: agentDir });
        const workspace = value?.workspace ?? value?.data?.workspace ?? value;
        workspaceId = String(workspace?.workspaceId ?? '').trim() || null;
        if (workspaceId && value?.created && typeof workspaceController.rename === 'function') {
          try { await workspaceController.rename({ workspaceId, title: DIARY_WORKSPACE_TITLE }); } catch {}
        }
      } catch (error) {
        log(`[diary] 创建工作区失败，改用专用 cwd：${String(error?.message ?? error)}`);
      }
    }
    try {
      const params = workspaceId
        ? { workspaceId, agentPreset: DIARY_PRESET }
        : { cwd: agentDir, agentPreset: DIARY_PRESET };
      await ctx.sessionController.create({ sessionId: sid, ...params });
      sessionReady = true;
      log(`[diary] 已创建日记会话 ${sid}`);
      return true;
    } catch (error) {
      lastError = `创建日记会话失败：${String(error?.message ?? error)}`;
      log(`[diary] ${lastError}`);
      return false;
    }
  }

  async function budgetBlocked() {
    if (!tokenBudget?.block) return false;
    try {
      const gate = await tokenBudget.block('total');
      if (gate?.blocked) {
        lastError = gate.message || '今日 token 额度已到上限';
        log(`[diary] 跳过回顾：${lastError}`);
        return true;
      }
    } catch (error) {
      log(`[diary] token 额度检查失败（继续）：${String(error?.message ?? error).slice(0, 160)}`);
    }
    return false;
  }

  function personaText() {
    try {
      const full = path.join(characterDir, 'persona.md');
      const text = fs.readFileSync(full, 'utf8');
      return text.trim();
    } catch { return ''; }
  }

  function memoryText() {
    try {
      const file = path.join(characterDir, 'memory', 'memory-card-prompt-qq.md');
      return fs.readFileSync(file, 'utf8').trim();
    } catch { return ''; }
  }

  async function submitReview(day, { force = false } = {}) {
    const conf = cfg();
    const state = readSchedulerState(diaryDir);
    if (!force && state.lastReviewedDay === day) return { ok: true, skipped: 'already-reviewed' };
    const attempts = Number(state.attempts?.[day] ?? 0) || 0;
    if (!force && attempts >= conf.maxAttempts) return { ok: true, skipped: 'max-attempts' };
    if (await budgetBlocked()) return { ok: false, skipped: 'token-budget', error: lastError };
    if (!(await ensureSession())) return { ok: false, error: lastError };

    const digest = buildDailyDigest({
      characterDir,
      qqStateDir,
      day,
      now: now(),
      maxChars: conf.digestMaxChars,
      history: await (async () => {
        if (!fetchDayHistory) return null;
        try {
          return await fetchDayHistory({ day, count: 2000 });
        } catch (error) {
          log(`[diary] 读取当天完整聊天失败（回退 recentMessages）：${String(error?.message ?? error).slice(0, 200)}`);
          return null;
        }
      })(),
    });
    const prompt = buildReviewPrompt({
      day,
      characterId,
      characterName,
      persona: personaText(),
      memory: memoryText(),
      digest: digest.text,
      reviewAt: conf.reviewAt,
    });
    const nextState = {
      ...state,
      attempts: { ...(state.attempts || {}), [day]: attempts + 1 },
      lastAttemptAt: new Date(now()).toISOString(),
      lastError: '',
    };
    writeSchedulerState(diaryDir, nextState);
    try {
      // DSH 的 sessionController.prompt(args, signal) 第二个参数是必需的 AbortSignal
      // （B 站生物钟也是这么调的）；少传会在服务端 reading 'throwIfAborted' 崩掉。
      const result = await ctx.sessionController.prompt({
        requestId: `diary-review-${day}-${now()}`,
        sessionId: sid,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, new AbortController().signal);
      if (result?.accepted === false || result?.ok === false || result?.result?.ok === false) {
        throw new Error('DSH 拒绝接收日记回合');
      }
      const stamp = new Date(now()).toISOString();
      writeSchedulerState(diaryDir, {
        ...nextState,
        // 手动整理不占「今天的定时回顾已完成」：下午手动整理过，23:30 仍会照常跑。
        lastReviewedDay: force ? state.lastReviewedDay : day,
        lastManualAt: force ? stamp : state.lastManualAt,
        submittedAt: stamp,
        lastError: '',
      });
      try { archiveCandidates(diaryDir, { day, now: now() }); } catch (error) {
        log(`[diary] 归档候选失败：${String(error?.message ?? error)}`);
      }
      log(`[diary] 已提交 ${day} 的日记回顾（会话 ${sid}）`);
      return { ok: true, day, sessionId: sid, chars: prompt.length, digest: digest.counters };
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 500);
      writeSchedulerState(diaryDir, { ...nextState, lastError });
      log(`[diary] 提交 ${day} 回顾失败：${lastError}`);
      return { ok: false, day, error: lastError };
    }
  }

  async function tick() {
    if (stopped || running) return { ok: false, skipped: 'busy' };
    running = true;
    lastTickAt = now();
    try {
      const conf = cfg();
      if (conf.enabled === false || conf.autoReview === false) return { ok: true, skipped: 'disabled' };
      const state = readSchedulerState(diaryDir);
      const plan = planDueReview({ now: now(), config: conf, state });
      if (!plan) return { ok: true, skipped: 'not-due' };
      return await submitReview(plan.due);
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 500);
      log(`[diary] tick 失败：${lastError}`);
      return { ok: false, error: lastError };
    } finally {
      running = false;
    }
  }

  async function reviewNow() {
    const day = localDay(now());
    return submitReview(day, { force: true });
  }

  function status() {
    let plan = null;
    try { plan = planDueReview({ now: now(), config: cfg(), state: readSchedulerState(diaryDir) }); } catch {}
    return {
      running: !stopped,
      sessionId: sid,
      sessionReady,
      characterId,
      lastTickAt,
      lastError,
      due: plan?.due ?? null,
      nextReviewAt: cfg().reviewAt,
      state: readSchedulerState(diaryDir),
    };
  }

  if (autoTick) {
    timer = setInterval(() => { void tick(); }, TICK_MS);
    timer.unref?.();
    // 启动后等 5 秒再跑第一次，避开插件激活时的初始化高峰。
    setTimeout(() => { void tick(); }, 5000).unref?.();
  }

  return {
    tick,
    reviewNow,
    status,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      try { ctx.sessionController?.cancel?.({ sessionId: sid }); } catch {}
    },
  };
}
