#!/usr/bin/env node
// 视频项目（阶段一）：项目/版本/素材/渲染任务/状态/预览/审片决策。
//
// 安全约定：
//   · 只读写当前角色的视频目录，角色解析失败直接报错（不会写进账号公共目录）；
//   · 计划必须来自受控工作区文件（--plan-file），保存前做强校验；
//   · 渲染只是“提交任务”，由插件后台执行器执行；--wait 可以等它跑完（手动用）。
import fs from 'node:fs';
import path from 'node:path';
import { requireVideoRoot, ensureVideoDirs } from '../../lib/video/paths.js';
import { openVideoStore } from '../../lib/video/project-store.js';
import { validatePlan } from '../../lib/video/plan.js';
import { registerGeneratedCard, registerImageAsset, validatePlanAssets } from '../../lib/video/assets.js';
import { revisePlan, compareVersions } from '../../lib/video/review.js';
import { readBiliConfig } from '../../lib/store.js';

const USAGE = `用法: node video-project.mjs <命令> [参数]
  list                                            项目列表
  create --title <标题>                           新建项目
  save <id> --expect-revision <n> --plan-file <文件>   保存新版本计划（CAS）
  assets <id> [list]                              已登记素材
  assets <id> register-card [--kind gradient|color|geometry] [--color 2b3a55] [--color2 182038] [--accent ffffff] [--text ...]
  assets <id> register-image <文件> [--kind avatar|image] [--name ...]   登记头像/插画
  render <id> --revision <n> [--wait] [--timeout <ms>]   提交渲染任务（--wait 等完成）
  status <id> [--job <jobId>] [--refresh]         项目/任务/工件状态
  preview <id> --revision <n>                     预览产物（九宫格/镜头帧/字幕/旁白路径）
  show-plan <id> --revision <n>                   读取一版的剪辑计划
  revise <id> --expect-revision <n> --patch-file <文件>   按镜头 id/封面/音轨改一版
  compare <id> --from <n> --to <n>                比较镜头、封面、时长与缓存复用
  review <id> --revision <n> --decision keep|revise|shelve [--reason <理由>]
全局: --json 输出 JSON`;

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return null;
  return args[index + 1];
}

function flag(args, name) {
  return args.includes(name);
}

function output(result) {
  if (flag(process.argv.slice(2), '--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result?.ok === false) {
    console.error(`✗ ${result.code}${result.error ? `：${result.error}` : ''}`);
    if (result.hint) console.error(`  → ${result.hint}`);
  }
}

function fail(result) {
  output({ ...result, hint: result.hint || '运行 video-project help 或查看项目任务详情' });
  process.exit(result?.code === 'VIDEO_USAGE' ? 2 : 1);
}

function readJsonFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 512 * 1024) {
    throw Object.assign(new Error('计划/补丁须为不超过 512 KiB 的 JSON 文件'), { code: 'VIDEO_PLAN_UNREADABLE' });
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ok(result) {
  output(result);
  process.exit(0);
}

function humanStatus(result) {
  if (flag(process.argv.slice(2), '--json')) return;
  const p = result.project;
  console.log(`项目 ${p.id}（v${p.revision} · ${p.editState}）${p.title}`);
  for (const task of result.tasks ?? []) {
    const prog = task.progress?.stage ? ` [${task.progress.stage} ${task.progress.pct ?? ''}%]` : '';
    console.log(`  任务 ${task.jobId} ${task.kind}@v${task.revision} ${task.state}${prog} attempts=${task.attempts}`);
    if (task.error) console.log(`    ✗ ${task.errorCode}：${task.error}`);
    if (task.hint) console.log(`    → ${task.hint}`);
    if (task.state === 'retryable') console.log(`    → 下次重试 ${new Date(task.nextAt).toLocaleString()}`);
  }
  for (const rev of result.revisions ?? []) {
    const arts = (result.artifactsByRevision?.[String(rev.revision)] ?? []).map((a) => `${a.kind}(${a.relativePath})`).join(' ');
    console.log(`  版本 v${rev.revision}${rev.reviewDecision ? ` 决策=${rev.reviewDecision}` : ''}${arts ? ` 工件: ${arts}` : ''}`);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const asJson = flag(args, '--json');

  if (!cmd || ['help', '-h', '--help'].includes(cmd)) {
    if (asJson) return ok({ ok: false, code: 'VIDEO_USAGE', error: USAGE });
    console.log(USAGE);
    process.exit(0);
  }

  let root;
  let character;
  try {
    ({ root, character } = requireVideoRoot());
  } catch (error) {
    return fail({ ok: false, code: error.code, error: error.message, hint: error.hint });
  }

  const videoCfg = (() => {
    try { return readBiliConfig().config?.video ?? {}; } catch { return {}; }
  })();
  const limits = {
    minTotalMs: 15_000,
    maxTotalMs: Number(videoCfg.maxDurationSec) > 0 ? Number(videoCfg.maxDurationSec) * 1000 : 90_000,
    maxScenes: Number(videoCfg.maxScenes) > 0 ? Number(videoCfg.maxScenes) : 12,
    maxOutputBytes: (Number(videoCfg.maxOutputMB) > 0 ? Number(videoCfg.maxOutputMB) : 100) * 1024 * 1024,
  };

  const writes = ['create', 'save', 'revise', 'render', 'review'].includes(cmd)
    || (cmd === 'assets' && ['register-card', 'register-image'].includes(args[1]));
  if (writes && videoCfg.enabled !== true) {
    return fail({ ok: false, code: 'VIDEO_DISABLED', error: '视频创作已关闭', hint: '在设置 → SurfCore → 视频创作启用并保存' });
  }
  let store;
  try {
    ensureVideoDirs(root);
    store = openVideoStore(root);
  } catch (error) {
    return fail({ ok: false, code: error.code ?? 'VIDEO_STORE_OPEN', error: error.message, hint: error.hint });
  }

  try {
    if (cmd === 'list') {
      const list = store.listProjects({ limit: 50 });
      const items = list.items.map((p) => ({
        id: p.id, revision: p.revision, editState: p.editState, title: p.title,
        tasks: p.tasks.map((t) => ({ jobId: t.jobId, kind: t.kind, state: t.state, stage: t.progress?.stage ?? t.stage, errorCode: t.errorCode })),
        updatedAt: new Date(p.updatedAt).toISOString(),
      }));
      if (asJson) return ok({ ok: true, character, items, total: list.total });
      console.log(`当前角色：${character.name}（${character.id}）`);
      for (const p of items) {
        const task = p.tasks[0];
        console.log(`${p.id}  v${p.revision}  ${p.editState.padEnd(8)}  ${task ? `${task.state}${task.errorCode ? `(${task.errorCode})` : ''}` : '—'}  ${p.title}`);
      }
      return process.exit(0);
    }

    if (cmd === 'create') {
      const title = argValue(args, '--title') ?? '';
      if (!title.trim()) return fail({ ok: false, code: 'VIDEO_BAD_TITLE', error: 'create 需要 --title <标题>' });
      const project = store.createProject({ characterId: character.id, title, maxProjects: videoCfg.maxProjects ?? 3 });
      const result = { ok: true, character, project };
      if (asJson) return ok(result);
      console.log(`已创建项目 ${project.id}（v0 · idea）「${project.title}」`);
      console.log('下一步：assets register-card / register-image 准备素材 → save 保存计划 → render');
      return process.exit(0);
    }

    if (cmd === 'save') {
      const id = args[0];
      const expectRevision = Number(argValue(args, '--expect-revision') ?? NaN);
      const planFile = argValue(args, '--plan-file');
      if (!id || !Number.isInteger(expectRevision) || !planFile) {
        return fail({ ok: false, code: 'VIDEO_USAGE', error: '用法: save <id> --expect-revision <n> --plan-file <文件>' });
      }
      let plan;
      try {
        plan = readJsonFile(planFile);
      } catch (error) {
        return fail({ ok: false, code: 'VIDEO_PLAN_UNREADABLE', error: `读不到计划文件：${String(error.message ?? error)}`, hint: '计划文件必须是 UTF-8 JSON' });
      }
      const check = validatePlan(plan, { limits });
      if (!check.ok) {
        return fail({
          ok: false, code: 'VIDEO_PLAN_INVALID', error: '计划校验未通过',
          hint: check.errors.map((e) => `${e.path ?? ''}：${e.message}`).join('；'),
          errors: check.errors,
        });
      }
      validatePlanAssets(store, root, plan);
      const saved = store.savePlan(id, plan, { expectRevision });
      if (asJson) return ok({ ok: true, character, ...saved, planCheck: check });
      console.log(`已保存版本 v${saved.revision}（planHash ${saved.planHash.slice(0, 12)}）`);
      console.log('下一步：video-project render ' + id + ' --revision ' + saved.revision);
      return process.exit(0);
    }

    if (cmd === 'assets') {
      const id = args[0];
      if (!id) return fail({ ok: false, code: 'VIDEO_USAGE', error: '用法: assets <id> [list|register-card|register-image ...]' });
      const sub = args[1] ?? 'list';
      if (sub === 'list') {
        const assets = store.listAssets({ limit: 200 }).map((a) => ({
          id: a.id, kind: a.kind, source: a.source, name: a.name, bytes: a.bytes,
          sha256: a.sha256.slice(0, 12), durationMs: a.authorization?.media?.durationMs ?? null,
          authorization: { mode: a.authorization?.mode, scope: a.authorization?.scope,
            credit: a.authorization?.credit, revokedAt: a.authorization?.revokedAt },
        }));
        if (asJson) return ok({ ok: true, character, assets });
        console.log(`素材（${assets.length}）：`);
        for (const a of assets) console.log(`  ${a.id.padEnd(18)} ${a.kind.padEnd(8)} ${a.source.padEnd(10)} ${a.name}${a.durationMs ? ` · ${a.durationMs}ms` : ''}${a.authorization?.revokedAt ? ' · 已撤销' : ''}`);
        return process.exit(0);
      }
      if (sub === 'register-card') {
        const result = registerGeneratedCard(store, root, {
          kind: argValue(args, '--kind') ?? 'gradient',
          color: argValue(args, '--color') ?? '2b3a55',
          color2: argValue(args, '--color2') ?? '182038',
          accent: argValue(args, '--accent') ?? 'ffffff',
          text: argValue(args, '--text') ?? '',
          importer: 'video-project-cli',
        });
        if (asJson) return ok({ ok: true, character, ...result });
        console.log(`已登记卡片 ${result.asset.id}（${result.duplicate ? '内容已存在，复用' : '新生成'}）sha256=${result.asset.sha256.slice(0, 12)}`);
        return process.exit(0);
      }
      if (sub === 'register-image') {
        const file = args[2];
        if (!file) return fail({ ok: false, code: 'VIDEO_USAGE', error: '用法: assets <id> register-image <文件> [--kind avatar|image] [--name ...]' });
        const result = registerImageAsset(store, root, file, {
          kind: argValue(args, '--kind') ?? 'avatar',
          name: argValue(args, '--name') ?? '',
          importer: 'video-project-cli',
        });
        if (asJson) return ok({ ok: true, character, ...result });
        console.log(`已登记素材 ${result.asset.id}（${result.duplicate ? '内容已存在，复用' : '新导入'}）${result.asset.kind} ${result.asset.name}`);
        return process.exit(0);
      }
      return fail({ ok: false, code: 'VIDEO_USAGE', error: `未知素材子命令：${sub}` });
    }

    if (cmd === 'show-plan' || cmd === 'revise' || cmd === 'compare') {
      const id = args[0];
      const revision = Number(argValue(args, cmd === 'revise' ? '--expect-revision' : '--revision') ?? NaN);
      const from = Number(argValue(args, '--from') ?? NaN);
      const to = Number(argValue(args, '--to') ?? NaN);
      if (!id || (cmd === 'compare' ? !Number.isInteger(from) || !Number.isInteger(to) : !Number.isInteger(revision))) {
        return fail({ ok: false, code: 'VIDEO_USAGE', error: '缺少项目 ID 或版本号' });
      }
      let result;
      if (cmd === 'show-plan') {
        result = store.getPlan(id, revision);
        if (!result) return fail({ ok: false, code: 'VIDEO_BAD_REVISION', error: '版本不存在' });
      } else if (cmd === 'revise') {
        const file = argValue(args, '--patch-file');
        if (!file) return fail({ ok: false, code: 'VIDEO_USAGE', error: 'revise 需要 --patch-file' });
        result = revisePlan(store, id, revision, readJsonFile(file), limits, (plan) => validatePlanAssets(store, root, plan));
      } else {
        result = compareVersions(store, id, from, to);
      }
      if (asJson) return ok({ ok: true, ...result });
      console.log(JSON.stringify(result, null, 2));
      return process.exit(0);
    }

    if (cmd === 'render') {
      const id = args[0];
      const revision = Number(argValue(args, '--revision') ?? NaN);
      if (!id || !Number.isInteger(revision)) {
        return fail({ ok: false, code: 'VIDEO_USAGE', error: '用法: render <id> --revision <n> [--wait] [--timeout <ms>]' });
      }
      const enqueued = store.enqueueTask({ projectId: id, revision, kind: 'render' });
      const wait = flag(args, '--wait');
      const timeout = Number(argValue(args, '--timeout') ?? 15 * 60_000);
      if (wait) {
        const deadline = Date.now() + timeout;
        let task = enqueued.task;
        while (task && !['succeeded', 'blocked', 'cancelled'].includes(task.state) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          task = store.getTask(enqueued.jobId);
        }
        const final = store.getTask(enqueued.jobId);
        const artifacts = store.listArtifacts(id, revision).map((a) => a.kind);
        const result = { ok: final?.state === 'succeeded', character, projectId: id, revision, jobId: enqueued.jobId, task: final, artifacts };
        if (asJson) return ok(result);
        humanStatus({ project: { id, revision, editState: '', title: '' }, tasks: [final].filter(Boolean), revisions: [], artifactsByRevision: { [revision]: store.listArtifacts(id, revision) } });
        if (!result.ok) {
          return fail({ ok: false, code: final?.errorCode ?? 'VIDEO_TASK_FAILED', error: final?.error ?? '渲染未完成', hint: final?.hint });
        }
        return process.exit(0);
      }
      const result = { ok: true, character, projectId: id, revision, jobId: enqueued.jobId, task: enqueued.task, duplicate: enqueued.duplicate };
      if (asJson) return ok(result);
      console.log(`已提交渲染任务 ${enqueued.jobId}（${enqueued.duplicate ? '同版本已有活跃任务，返回同一个' : '新任务'}）`);
      console.log('用 status <id> --job ' + enqueued.jobId + ' 看进度；插件后台执行器会接手执行');
      return process.exit(0);
    }

    if (cmd === 'status') {
      const id = args[0];
      if (!id) return fail({ ok: false, code: 'VIDEO_USAGE', error: '用法: status <id> [--job <jobId>]' });
      const project = store.getProject(id);
      if (!project) return fail({ ok: false, code: 'VIDEO_PROJECT_NOT_FOUND', error: `项目不存在：${id}` });
      const jobId = argValue(args, '--job');
      const tasks = (jobId ? [store.getTask(jobId)].filter((task) => task?.projectId === id) : project.tasks).map((t) => ({
        ...t,
        nextAtIso: t.nextAt ? new Date(t.nextAt).toISOString() : null,
      }));
      const result = {
        ok: true, character, project, tasks,
        artifactsByRevision: Object.fromEntries(project.revisions.map((r) => [String(r.revision), store.listArtifacts(id, r.revision)])),
      };
      if (asJson) return ok(result);
      humanStatus(result);
      return process.exit(0);
    }

    if (cmd === 'preview') {
      const id = args[0];
      const revision = Number(argValue(args, '--revision') ?? NaN);
      if (!id || !Number.isInteger(revision)) {
        return fail({ ok: false, code: 'VIDEO_USAGE', error: '用法: preview <id> --revision <n>' });
      }
      const preview = store.getArtifact(id, revision, 'preview');
      if (!preview) return fail({ ok: false, code: 'VIDEO_ARTIFACT_NOT_FOUND', error: '还没有预览产物', hint: '先 render 这个版本' });
      const revDir = path.join(root, 'projects', id, 'revisions', String(revision));
      const previewJson = JSON.parse(fs.readFileSync(path.join(revDir, preview.relativePath), 'utf8'));
      const result = {
        ok: true, character, projectId: id, revision,
        totalMs: previewJson.totalMs,
        scenes: previewJson.scenes.map((s) => ({
          id: s.id, startMs: s.startMs, durationMs: s.durationMs, assetId: s.assetId,
          cues: s.cues.map((c) => ({ text: c.text, startMs: c.startMs, endMs: c.endMs })),
          titleCard: s.titleCard,
        })),
        captions: previewJson.captions,
        audioTracks: previewJson.audioTracks ?? [],
        narration: previewJson.narration ?? [],
        qa: (() => {
          const qa = store.getArtifact(id, revision, 'qa');
          return qa ? JSON.parse(fs.readFileSync(path.join(revDir, qa.relativePath), 'utf8')) : null;
        })(),
        keyframes: previewJson.frames.map((frame) => ({ ...frame, file: path.join(root, frame.file) })),
        files: {
          mp4: path.join(revDir, store.getArtifact(id, revision, 'mp4')?.relativePath ?? ''),
          cover: path.join(revDir, store.getArtifact(id, revision, 'cover')?.relativePath ?? ''),
          srt: path.join(revDir, store.getArtifact(id, revision, 'srt')?.relativePath ?? ''),
          grid: path.join(revDir, store.getArtifact(id, revision, 'preview-grid')?.relativePath ?? ''),
          frames: previewJson.frames.map((f) => path.join(root, f.file)),
          narration: store.getArtifact(id, revision, 'narration') ? path.join(revDir, 'narration.wav') : null,
        },
      };
      if (asJson) return ok(result);
      console.log(`预览 v${revision}：总长 ${(result.totalMs / 1000).toFixed(1)}s，${result.scenes.length} 镜头，${result.captions.length} 条字幕`);
      for (const s of result.scenes) {
        console.log(`  镜头 ${s.id} ${(s.startMs / 1000).toFixed(1)}s–${((s.startMs + s.durationMs) / 1000).toFixed(1)}s（${s.durationMs / 1000}s）`);
        for (const cue of s.cues) console.log(`    [${(cue.startMs / 1000).toFixed(1)}s] ${cue.text}`);
        if (s.titleCard) console.log(`    [标题卡] ${s.titleCard}`);
      }
      console.log(`  成片: ${result.files.mp4}`);
      console.log(`  封面: ${result.files.cover}`);
      console.log(`  字幕: ${result.files.srt}`);
      console.log(`  九宫格: ${result.files.grid}`);
      if (result.files.narration) console.log(`  旁白试听: ${result.files.narration}`);
      for (const frame of result.keyframes) console.log(`  镜头帧 ${frame.sceneId} @ ${frame.atMs ?? frame.offsetMs}ms: ${frame.file}`);
      for (const warning of result.qa?.warnings ?? []) console.log(`  质检提示：${warning.detail}`);
      return process.exit(0);
    }

    if (cmd === 'review') {
      const id = args[0];
      const revision = Number(argValue(args, '--revision') ?? NaN);
      const decision = argValue(args, '--decision');
      if (!id || !Number.isInteger(revision) || !['keep', 'revise', 'shelve'].includes(decision)) {
        return fail({ ok: false, code: 'VIDEO_USAGE', error: '用法: review <id> --revision <n> --decision keep|revise|shelve' });
      }
      const result = store.setReviewDecision(id, revision, decision, argValue(args, '--reason'));
      const out = { ok: true, character, ...result };
      if (asJson) return ok(out);
      console.log(`v${revision} 决策已记录：${decision}`);
      return process.exit(0);
    }

    return fail({ ok: false, code: 'VIDEO_USAGE', error: `未知命令：${cmd}` });
  } finally {
    store.close();
  }
}

main().catch((error) => {
  fail({ ok: false, code: error?.code ?? 'VIDEO_CLI_FAILED', error: String(error?.message ?? error), hint: error?.hint });
});
