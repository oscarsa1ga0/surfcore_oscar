// 日记调度单测：不连 DSH，用假 sessionController + 真临时文件验证“只跑一次/补执行/重试上限”。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  buildDailyDigest, buildReviewPrompt, normalizeDiaryConfig, planDueReview, startDiaryScheduler,
} from '../plugins/surfcore/lib/diary-scheduler.js';
import { captureCandidate, createEntry, readSchedulerState, writeSchedulerState } from '../src/diary-store.js';

const temps = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-sched-'));
  temps.push(root);
  return root;
}
after(() => { for (const dir of temps) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } });

const TODAY = '2026-11-12';
const at = (iso) => Date.parse(iso);

test('planDueReview：14:30 / 23:30 两次、补执行、同日去重、重试上限、开关', () => {
  const config = normalizeDiaryConfig({ reviewAt: '14:30', reviewAtEvening: '23:30', catchUpHours: 6, maxAttempts: 2 });
  assert.deepEqual(config.reviewTimes, ['14:30', '23:30']);
  assert.equal(planDueReview({ now: at('2026-11-12T14:31:00+08:00'), config, state: {} })?.slot, '14:30');
  assert.equal(planDueReview({ now: at('2026-11-12T14:00:00+08:00'), config, state: {} }), null);
  assert.equal(planDueReview({ now: at('2026-11-12T20:00:00+08:00'), config, state: {} })?.slot, '14:30');
  // 14:30 已错过 6 小时，不在 21:16 突然补；等 23:30。
  assert.equal(planDueReview({ now: at('2026-11-12T21:16:00+08:00'), config, state: {} }), null);
  // 14:30 已经回顾过，23:30 仍要跑。
  assert.equal(planDueReview({ now: at('2026-11-12T23:31:00+08:00'), config, state: { lastReviewedSlot: `${TODAY}|14:30` } })?.slot, '23:30');
  // 同一天同一时段只跑一次。
  assert.equal(planDueReview({ now: at('2026-11-12T23:31:00+08:00'), config, state: { lastReviewedSlot: `${TODAY}|23:30` } }), null);
  // 补执行：第二天凌晨补前一天 23:30；超过窗口不补。
  assert.equal(planDueReview({ now: at('2026-11-13T01:00:00+08:00'), config, state: {} })?.due, TODAY);
  assert.equal(planDueReview({ now: at('2026-11-13T07:00:00+08:00'), config, state: {} }), null);
  // 手动整理不在时段前 30 分钟内，不跳过；在 30 分钟内才跳过。
  assert.equal(planDueReview({ now: at('2026-11-12T23:31:00+08:00'), config, state: { lastManualAt: '2026-11-12T19:57:00+08:00' } })?.slot, '23:30');
  assert.equal(planDueReview({ now: at('2026-11-12T23:31:00+08:00'), config, state: { lastManualAt: '2026-11-12T23:20:00+08:00' } }), null);
  assert.equal(planDueReview({ now: at('2026-11-12T14:31:00+08:00'), config, state: { lastManualAt: '2026-11-12T14:00:00+08:00' } }), null);
  // 重试上限按时段记；旧配置 23:30 自动迁移成两次。
  assert.equal(planDueReview({ now: at('2026-11-12T23:31:00+08:00'), config, state: { attempts: { [`${TODAY}|23:30`]: 2 } } }), null);
  const old = normalizeDiaryConfig({ reviewAt: '23:30' });
  assert.deepEqual(old.reviewTimes, ['14:30', '23:30']);
  assert.equal(planDueReview({ now: at('2026-11-12T14:31:00+08:00'), config: { ...config, enabled: false }, state: {} }), null);
  assert.equal(planDueReview({ now: at('2026-11-12T14:31:00+08:00'), config: { ...config, autoReview: false }, state: {} }), null);
});

test('buildDailyDigest：只取当天，包含聊天/候选/B站事件', () => {
  const root = tempRoot();
  const characterDir = path.join(root, 'characters', 'char-x');
  const qqStateDir = path.join(root, 'qq-state');
  fs.mkdirSync(path.join(characterDir, 'bili'), { recursive: true });
  fs.mkdirSync(qqStateDir, { recursive: true });
  fs.writeFileSync(path.join(characterDir, 'bili', 'whale-log.jsonl'), [
    JSON.stringify({ at: '2026-11-12T10:00:00+08:00', kind: 'watch', target: 'BV1xx', note: '看了个猫猫视频' }),
    JSON.stringify({ at: '2026-11-11T10:00:00+08:00', kind: 'watch', target: 'BV-old', note: '昨天的' }),
  ].join('\n'));
  captureCandidate(path.join(characterDir, 'diary'), { note: '今天第一次自己起 B 站名字', now: at('2026-11-12T12:00:00+08:00') });
  createEntry(path.join(characterDir, 'diary'), { content: '今天先写一句。', now: at('2026-11-12T20:00:00+08:00') });
  fs.writeFileSync(path.join(qqStateDir, 'social-v2.json'), JSON.stringify({
    conversations: {
      'private:10001': { recentMessages: [
        { time: at('2026-11-12T09:00:00+08:00'), isSelf: false, sender: '主人', text: '今天想吃什么' },
        { time: at('2026-11-12T09:01:00+08:00'), isSelf: true, text: '想吃鱼' },
        { time: at('2026-11-11T09:00:00+08:00'), isSelf: false, sender: '主人', text: '昨天的消息' },
      ] },
    },
  }));

  const digest = buildDailyDigest({ characterDir, qqStateDir, day: TODAY, now: at('2026-11-12T23:30:00+08:00') });
  assert.match(digest.text, /今天想吃什么/);
  assert.match(digest.text, /想吃鱼/);
  assert.doesNotMatch(digest.text, /昨天的消息/);
  assert.match(digest.text, /第一次自己起 B 站名字/);
  assert.match(digest.text, /猫猫视频/);
  assert.doesNotMatch(digest.text, /昨天的/);
  assert.equal(digest.counters.messages >= 2, true);
  assert.equal(digest.counters.candidates >= 1, true);
});

test('buildDailyDigest：优先用当天完整历史，覆盖上午和晚上', () => {
  const root = tempRoot();
  const characterDir = path.join(root, 'characters', 'char-x');
  fs.mkdirSync(characterDir, { recursive: true });
  const history = {
    day: TODAY,
    conversations: {
      'private:10001': [
        { time: at('2026-11-12T08:00:00+08:00'), isSelf: false, sender: '主人', text: '早上好，今天想做什么' },
        { time: at('2026-11-12T08:01:00+08:00'), isSelf: true, text: '早上好，我想去逛 B 站' },
        { time: at('2026-11-12T20:00:00+08:00'), isSelf: false, sender: '主人', text: '晚上继续聊' },
      ],
    },
  };
  const digest = buildDailyDigest({ characterDir, history, day: TODAY, now: at('2026-11-12T23:30:00+08:00') });
  assert.match(digest.text, /早上好，今天想做什么/);
  assert.match(digest.text, /我想去逛 B 站/);
  assert.match(digest.text, /晚上继续聊/);
  assert.equal(digest.counters.history, 3);
  assert.equal(digest.counters.messages, 3);
});

test('buildDailyDigest：消息很多时按小时采样，上午/晚上都保留', () => {
  const root = tempRoot();
  const characterDir = path.join(root, 'characters', 'char-x');
  fs.mkdirSync(characterDir, { recursive: true });
  const list = [];
  for (let i = 0; i < 90; i += 1) {
    list.push({ time: at('2026-11-12T08:00:00+08:00') + i * 1000, isSelf: false, sender: '主人', text: `上午第${i}条` });
  }
  for (let i = 0; i < 90; i += 1) {
    list.push({ time: at('2026-11-12T20:00:00+08:00') + i * 1000, isSelf: false, sender: '主人', text: `晚上第${i}条` });
  }
  const digest = buildDailyDigest({ characterDir, history: { conversations: { 'private:1': list } }, day: TODAY, now: at('2026-11-12T23:30:00+08:00') });
  assert.match(digest.text, /上午第0条/);
  assert.match(digest.text, /晚上第89条/);
  assert.equal(digest.counters.sampled, true);
  assert.ok(digest.counters.messages < 180, '应采样而不是全量塞入');
});

test('buildReviewPrompt：给原材料和边界，不规定必须写', () => {
  const prompt = buildReviewPrompt({
    day: TODAY, characterId: 'char-x', characterName: '鱼姬', persona: '我是一条鱼。',
    memory: '主人喜欢猫。', digest: '【今天的聊天片段】\n[09:00] 主人：在吗', reviewAt: '23:30',
  });
  assert.match(prompt, /2026-11-12 23:30/);
  assert.match(prompt, /写不写由你决定/);
  assert.match(prompt, /编造/);
  assert.match(prompt, /diary_write/);
  assert.match(prompt, /char-x/);
  assert.match(prompt, /同一篇日记/);
});

function fakeCtx({ failPrompt = false } = {}) {
  const created = [];
  const prompts = [];
  return {
    created,
    prompts,
    ctx: {
      sessionController: {
        async inspect() { throw new Error('not found'); },
        async create(params) { created.push(params); },
        async prompt(args, signal) {
          if (!signal || typeof signal.throwIfAborted !== 'function') throw new Error('prompt 缺少 AbortSignal（DSH 契约）');
          prompts.push(args);
          if (failPrompt) throw new Error('prompt failed');
          return { accepted: true };
        },
        cancel() {},
      },
      get() { return undefined; },
    },
  };
}

function schedulerFixture({ failPrompt = false, nowRef } = {}) {
  const root = tempRoot();
  const characterDir = path.join(root, 'characters', 'char-x');
  const qqStateDir = path.join(root, 'qq-state');
  const dshHome = path.join(root, 'dsh');
  fs.mkdirSync(characterDir, { recursive: true });
  fs.mkdirSync(qqStateDir, { recursive: true });
  fs.writeFileSync(path.join(characterDir, 'persona.md'), '# 鱼姬\n我是一条鱼。');
  fs.mkdirSync(path.join(characterDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(characterDir, 'memory', 'memory-card-prompt-qq.md'), '主人喜欢猫。');
  const fake = fakeCtx({ failPrompt });
  const config = { enabled: true, autoReview: true, reviewAt: '23:30', catchUpHours: 6, maxAttempts: 2, digestMaxChars: 4000 };
  const sched = startDiaryScheduler(fake.ctx, {
    dshHome, characterId: 'char-x', characterDir, characterName: '鱼姬', sessionId: 'diary-char-x',
    qqStateDir, readConfig: () => config, now: () => nowRef.value, log: () => {}, autoTick: false,
  });
  return { ...fake, sched, characterDir, qqStateDir, dshHome };
}

test('每日回顾：到点提交一次、写状态、归档候选；同日不再重复', async () => {
  const nowRef = { value: at('2026-11-12T23:31:00+08:00') };
  const fx = schedulerFixture({ nowRef });
  captureCandidate(path.join(fx.characterDir, 'diary'), { note: '今天值得记', now: nowRef.value });
  const first = await fx.sched.tick();
  assert.equal(first.ok, true);
  assert.equal(fx.prompts.length, 1);
  assert.match(fx.prompts[0].content[0].text, /日记时间/);
  assert.equal(fx.created[0].agentPreset, 'surfcore-diary');
  assert.equal(readSchedulerState(path.join(fx.characterDir, 'diary')).lastReviewedDay, TODAY);
  assert.equal(readSchedulerState(path.join(fx.characterDir, 'diary')).lastReviewedSlot, `${TODAY}|23:30`);
  const second = await fx.sched.tick();
  assert.equal(second.skipped, 'not-due');
  assert.equal(fx.prompts.length, 1);
  assert.equal(fs.existsSync(path.join(fx.characterDir, 'diary', 'candidates', 'processed', `${TODAY}.jsonl`)), true);
  fx.sched.stop();
});

test('每日两次：14:30 和 23:30 各提交一次，同一会话同一篇日记', async () => {
  const nowRef = { value: at('2026-11-12T14:31:00+08:00') };
  const fx = schedulerFixture({ nowRef });
  const first = await fx.sched.tick();
  assert.equal(first.ok, true);
  assert.equal(first.slot, '14:30');
  assert.equal(fx.prompts.length, 1);
  assert.match(fx.prompts[0].content[0].text, /14:30/);
  assert.match(fx.prompts[0].content[0].text, /同一篇日记/);
  assert.equal(readSchedulerState(path.join(fx.characterDir, 'diary')).lastReviewedSlot, `${TODAY}|14:30`);

  nowRef.value = at('2026-11-12T23:31:00+08:00');
  const second = await fx.sched.tick();
  assert.equal(second.ok, true);
  assert.equal(second.slot, '23:30');
  assert.equal(fx.prompts.length, 2);
  assert.match(fx.prompts[1].content[0].text, /23:30/);
  assert.match(fx.prompts[1].content[0].text, /diary_edit/);
  assert.equal(readSchedulerState(path.join(fx.characterDir, 'diary')).lastReviewedSlot, `${TODAY}|23:30`);
  assert.equal(fx.created.length, 1);
  fx.sched.stop();
});

test('提交失败：记错误、重试到上限后不再调用模型', async () => {
  const nowRef = { value: at('2026-11-12T23:31:00+08:00') };
  const fx = schedulerFixture({ failPrompt: true, nowRef });
  const first = await fx.sched.tick();
  assert.equal(first.ok, false);
  assert.equal(fx.prompts.length, 1);
  const state = readSchedulerState(path.join(fx.characterDir, 'diary'));
  assert.equal(state.attempts[`${TODAY}|23:30`], 1);
  assert.match(state.lastError, /prompt failed/);
  const second = await fx.sched.tick();
  assert.equal(second.ok, false);
  assert.equal(fx.prompts.length, 2);
  const third = await fx.sched.tick();
  assert.equal(third.skipped, 'not-due');
  assert.equal(fx.prompts.length, 2);
  fx.sched.stop();
});

test('离线补执行：第二天凌晨仍在窗口内，会补前一天；超过窗口就不补', async () => {
  const nowRef = { value: at('2026-11-13T01:00:00+08:00') };
  const fx = schedulerFixture({ nowRef });
  const result = await fx.sched.tick();
  assert.equal(result.ok, true);
  assert.equal(result.day, TODAY);
  assert.equal(readSchedulerState(path.join(fx.characterDir, 'diary')).lastReviewedDay, TODAY);
  fx.sched.stop();

  const nowRef2 = { value: at('2026-11-13T08:00:00+08:00') };
  const fx2 = schedulerFixture({ nowRef: nowRef2 });
  const result2 = await fx2.sched.tick();
  assert.equal(result2.skipped, 'not-due');
  assert.equal(fx2.prompts.length, 0);
  fx2.sched.stop();
});

test('关闭开关：不创建会话、不调用模型', async () => {
  const nowRef = { value: at('2026-11-12T23:31:00+08:00') };
  const fx = schedulerFixture({ nowRef });
  // 用 state 里已审的当日模拟“禁用”不好；直接停掉后重开一个 disabled 配置。
  fx.sched.stop();
  const fake = fakeCtx();
  const sched = startDiaryScheduler(fake.ctx, {
    dshHome: path.join(fx.dshHome, 'x'), characterId: 'char-x', characterDir: fx.characterDir,
    readConfig: () => ({ enabled: false }), now: () => nowRef.value, autoTick: false,
  });
  const result = await sched.tick();
  assert.equal(result.skipped, 'disabled');
  assert.equal(fake.prompts.length, 0);
  sched.stop();
});

test('手动立即整理：不把当天定时回顾标记为已完成', async () => {
  const nowRef = { value: at('2026-11-12T20:00:00+08:00') };
  const fx = schedulerFixture({ nowRef });
  writeSchedulerState(path.join(fx.characterDir, 'diary'), { lastReviewedDay: null, attempts: {} });
  const result = await fx.sched.reviewNow();
  assert.equal(result.ok, true);
  const state = readSchedulerState(path.join(fx.characterDir, 'diary'));
  assert.equal(state.lastReviewedDay, null, '手动整理不应吞掉 23:30 的定时回顾');
  assert.ok(state.lastManualAt, '手动整理应记录 lastManualAt');
  fx.sched.stop();
});

test('手动立即整理：绕过去重，但同样记录状态', async () => {
  const nowRef = { value: at('2026-11-12T20:00:00+08:00') };
  const fx = schedulerFixture({ nowRef });
  writeSchedulerState(path.join(fx.characterDir, 'diary'), { lastReviewedDay: TODAY, attempts: {} });
  const result = await fx.sched.reviewNow();
  assert.equal(result.ok, true);
  assert.equal(fx.prompts.length, 1);
  fx.sched.stop();
});
