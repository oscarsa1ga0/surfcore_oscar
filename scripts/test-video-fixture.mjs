// 阶段一验收 fixture（本地，不碰云端 TTS / 不投稿）：
//   1) 从空项目出发：建项目 → 登记头像/卡片素材 → 保存计划 → 渲染出片；
//   2) FFprobe 双流 / 画幅 / 时长 / 中文字幕 / 封面 / 九宫格 / 质检全绿；
//   3) 打断中途渲染 → 重开执行器 → 从缓存续跑完成（验收：断点恢复）；
//   4) CAS 版本冲突、任务幂等（重复 render 返回同一任务）；
//   5) CLI（bili.mjs video-project）在临时 DSH_HOME 下可读写同一套数据。
//
// 运行：node scripts/test-video-fixture.mjs
// 旁白用本地 fixture 合成器（正弦音），不依赖 BreezeBlue/voxd。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-video-fixture-'));
process.env.DSH_HOME = DSH_HOME;

const { requireVideoRoot, ensureVideoDirs } = await import('../plugins/surfcore/lib/video/paths.js');
const { openVideoStore } = await import('../plugins/surfcore/lib/video/project-store.js');
const { registerGeneratedCard, registerImageAsset, runPy } = await import('../plugins/surfcore/lib/video/assets.js');
const { validatePlan, computeTimeline } = await import('../plugins/surfcore/lib/video/plan.js');
const { createVideoWorker } = await import('../plugins/surfcore/lib/video/worker.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`);
  }}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await sleep(intervalMs);
  }
}

// 稳定时长的 fixture 合成器：每字 180ms + 800ms 起音，上限 6s
const fixtureSynth = async ({ text }) => {
  const durMs = Math.max(800, Math.min(6000, 800 + String(text).length * 180));
  const sr = 24000;
  const samples = Math.floor((durMs / 1000) * sr);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 900), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return { wav: Buffer.concat([header, data]), durationMs: durMs };
};

console.log(`fixture DSH_HOME: ${DSH_HOME}`);

// ── 0. 角色目录（模拟角色系统的最小结构）─────────────────────────────
const charDir = path.join(DSH_HOME, 'surfcore', 'characters', 'char-test1');
fs.mkdirSync(path.join(charDir, 'bili'), { recursive: true });
fs.writeFileSync(path.join(charDir, 'character.json'), JSON.stringify({ id: 'char-test1', name: '测试角色', epoch: 1 }));
fs.mkdirSync(path.join(DSH_HOME, 'surfcore', 'characters'), { recursive: true });
fs.writeFileSync(path.join(DSH_HOME, 'surfcore', 'characters', 'current.json'), JSON.stringify({ id: 'char-test1', name: '测试角色', epoch: 1 }));

// ── 1. 项目 / 素材 / 计划 ──────────────────────────────────────────
const { root, character } = requireVideoRoot();
ensureVideoDirs(root);
const store = openVideoStore(root);
console.log(`角色 ${character.name}（${character.id}）视频根目录: ${root}`);

const project = store.createProject({ characterId: character.id, title: '鱼姬的第一份视频草稿' });
check('createProject', Boolean(project.id && project.revision === 0 && project.editState === 'idea'), project.id);

// 素材：一张渐变卡 + 一张几何卡 + 登记的“头像”（用生成卡当头像来源）
const card1 = registerGeneratedCard(store, root, { kind: 'gradient', text: '' });
const card2 = registerGeneratedCard(store, root, { kind: 'geometry', color: '1f2d3d', color2: '0d1520', accent: 'ffd75e' });
const avatarPng = path.join(root, 'assets', '.avatar-src.png');
const avatarCard = runPy(['card', '--out', avatarPng, '--kind', 'geometry', '--color', '7a5c3e', '--color2', '3e2f1f', '--accent', 'ffd9a0', '--text', '鱼']);
check('avatar 源图生成', avatarCard?.ok === true);
const avatar = registerImageAsset(store, root, avatarPng, { kind: 'avatar', name: '鱼姬头像' });
fs.unlinkSync(avatarPng);
check('registerGeneratedCard', card1.asset.id && card2.asset.id && card1.asset.id !== card2.asset.id, `${card1.asset.id} ${card2.asset.id}`);
check('registerImageAsset(avatar)', avatar.asset.kind === 'avatar' && avatar.asset.bytes > 0, avatar.asset.id);
check('asset 内容去重', registerGeneratedCard(store, root, { kind: 'gradient' }).duplicate === true);

// 计划：s01 三句旁白（voice 定长）+ s02 固定 3s 标题卡；封面取 s01 第 1 秒
const plan = {
  schemaVersion: 1,
  title: '鱼姬的第一份视频草稿',
  format: { aspect: '16:9', profile: '720p30' },
  scenes: [
    {
      id: 's01',
      visual: { assetId: avatar.asset.id, fit: 'contain', motion: 'zoom_in' },
      duration: { mode: 'voice', minMs: 4000, tailMs: 400 },
      lines: [
        { id: 'l01', speech: '今天我想试试看，剪视频到底有多难。', caption: '今天我想试试看，剪视频到底有多难。' },
        { id: 'l02', speech: '先写一段旁白，再让字幕跟着声音走，好像也没那么可怕。', caption: '先写一段旁白，再让字幕跟着声音走，好像也没那么可怕。' },
        { id: 'l03', speech: '把想说的话一句一句说出来，镜头就自己排好了。', caption: '把想说的话一句一句说出来，镜头就自己排好了。' },
      ],
      transitionOut: { kind: 'cut', durationMs: 0 },
    },
    {
      id: 's02',
      visual: { assetId: card2.asset.id, fit: 'cover', motion: 'pan' },
      duration: { mode: 'fixed', ms: 3000 },
      lines: [],
      titleCard: '打开工程的第一个晚上',
    },
  ],
  cover: { kind: 'scene_frame', sceneId: 's01', offsetMs: 1000, headline: '第一次剪视频' },
  submission: { description: '鱼姬第一次试着给自己剪一条片。', tags: ['自我介绍'] },
};
const planCheck = validatePlan(plan);
check('validatePlan', planCheck.ok, planCheck.errors.map((e) => `${e.path}:${e.message}`).join('; '));

const saved = store.savePlan(project.id, plan, { expectRevision: 0 });
check('savePlan CAS', saved.ok && saved.revision === 1, `v${saved.revision}`);
let casConflict = null;
try {
  store.savePlan(project.id, plan, { expectRevision: 0 });
} catch (error) {
  casConflict = error;
}
check('savePlan 版本冲突被拒', casConflict?.code === 'VIDEO_REVISION_CONFLICT');

// ── 2. 渲染（worker + fixture 合成器）───────────────────────────────
console.log('  开始渲染 v1 ...');
const worker = createVideoWorker({ store, root, synth: fixtureSynth, log: (m) => console.log(`  [worker] ${m}`), maxConcurrent: 1, tickMs: 200 });
worker.start();
const enqueued1 = store.enqueueTask({ projectId: project.id, revision: 1, kind: 'render' });
const enqueued2 = store.enqueueTask({ projectId: project.id, revision: 1, kind: 'render' });
check('重复 render 幂等（同一 jobId）', enqueued1.jobId === enqueued2.jobId && enqueued2.duplicate === true, enqueued1.jobId);

await waitFor(() => store.getTask(enqueued1.jobId)?.state === 'succeeded', 240_000, 1000);
const task1 = store.getTask(enqueued1.jobId);
check('渲染任务成功', task1.state === 'succeeded', `attempts=${task1.attempts} stage=${task1.progress?.stage}`);
const artifacts = store.listArtifacts(project.id, 1);
const byKind = Object.fromEntries(artifacts.map((a) => [a.kind, a]));
for (const kind of ['mp4', 'srt', 'cover', 'preview-grid', 'preview', 'manifest', 'qa']) {
  check(`工件 ${kind}`, Boolean(byKind[kind]?.relativePath), byKind[kind]?.relativePath ?? '缺失');
}

const revDir = path.join(root, 'projects', project.id, 'revisions', '1');
const mp4 = path.join(revDir, byKind.mp4.relativePath);
const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp4], { encoding: 'utf8' });
const probeJson = JSON.parse(probe.stdout);
const vStream = probeJson.streams?.find((s) => s.codec_type === 'video');
const aStream = probeJson.streams?.find((s) => s.codec_type === 'audio');
check('FFprobe 两条流', Boolean(vStream && aStream), `v=${vStream?.codec_name} a=${aStream?.codec_name}`);
check('H.264 + 1280x720', vStream?.codec_name === 'h264' && vStream?.width === 1280 && vStream?.height === 720);
const qa = JSON.parse(fs.readFileSync(path.join(revDir, 'qa.json'), 'utf8'));
check('质检全绿', qa.ok === true, qa.checks.filter((c) => !c.pass).map((c) => c.name).join(',') || '全部通过');
const srtText = fs.readFileSync(path.join(revDir, byKind.srt.relativePath), 'utf8');
check('字幕含中文且时长合理', /鱼姬|剪视频|旁白/.test(srtText) && (srtText.match(/-->/g) ?? []).length >= 3, `${(srtText.match(/-->/g) ?? []).length} 条`);
const previewJson2 = JSON.parse(fs.readFileSync(path.join(revDir, byKind.preview.relativePath), 'utf8'));
const captionList = previewJson2.captions ?? [];
const captionSorted = captionList.every((c, i) => i === 0 || c.startMs >= captionList[i - 1].startMs);
const captionNoOverlap = captionList.every((c, i) => i === 0 || c.startMs >= captionList[i - 1].endMs);
check('字幕时间段有序且不重叠', captionSorted && captionNoOverlap, `${captionList.length} 条`);
const timeline = computeTimeline(plan, byKind.manifest ? JSON.parse(fs.readFileSync(path.join(revDir, byKind.manifest.relativePath), 'utf8')).lineDurations : {});
check('成片时长 ≈ 时间轴', Math.abs(Number(probeJson.format.duration) * 1000 - timeline.totalMs) <= 500, `${(Number(probeJson.format.duration) * 1000).toFixed(0)}ms vs ${timeline.totalMs}ms`);

// ── 3. 打断恢复 ────────────────────────────────────────────────────
console.log('  打断恢复测试 ...');
const project2 = store.createProject({ characterId: character.id, title: '打断恢复验收' });
const plan2 = {
  schemaVersion: 1,
  title: '打断恢复验收',
  format: { aspect: '16:9', profile: '720p30' },
  scenes: [
    {
      id: 's01', visual: { assetId: card1.asset.id, fit: 'cover', motion: 'none' },
      duration: { mode: 'voice', minMs: 2000, tailMs: 400 },
      lines: [
        { id: 'l01', speech: '这一段用来验证渲染中途被打断之后，重开还能不能继续。' },
        { id: 'l02', speech: '如果这条片子最后能完整出来，就说明断点续跑是真的。' },
        { id: 'l03', speech: '你看，渲染到一半停下来的任务，重启之后真的接着往下跑了。' },
      ],
    },
    { id: 's02', visual: { assetId: card2.asset.id, fit: 'cover', motion: 'none' }, duration: { mode: 'fixed', ms: 2500 }, lines: [], titleCard: '断点续跑' },
  ],
  cover: { kind: 'scene_frame', sceneId: 's02', offsetMs: 500, headline: '' },
  submission: { description: '打断恢复验收。', tags: ['测试'] },
};
store.savePlan(project2.id, plan2, { expectRevision: 0 });
const job2 = store.enqueueTask({ projectId: project2.id, revision: 1, kind: 'render' });
await waitFor(() => store.getTask(job2.jobId)?.state === 'running', 60_000, 200);
// 等它进入合成阶段再打断（此时已有部分工件落盘）
await waitFor(() => ['captions', 'render'].includes(store.getTask(job2.jobId)?.progress?.stage), 120_000, 500);
const midTask = store.getTask(job2.jobId);
check('打断前任务处于运行中', midTask.state === 'running', `stage=${midTask.progress?.stage}`);
worker.stop(); // 模拟宿主卸载：终止子进程，任务留在 running
await sleep(800);
const afterStop = store.getTask(job2.jobId);
check('停止后任务保留 running（等待恢复）', afterStop.state === 'running');
const worker2 = createVideoWorker({ store, root, synth: fixtureSynth, log: () => {}, maxConcurrent: 1, tickMs: 200 });
const recovered = worker2.start();
check('重启执行器恢复任务', recovered.jobs.length > 0 || store.getTask(job2.jobId).state !== 'running');
await waitFor(() => store.getTask(job2.jobId)?.state === 'succeeded', 240_000, 1000);
check('断点续跑完成', store.getTask(job2.jobId).state === 'succeeded');
worker2.stop();

// ── 4. CLI 通道（bili.mjs video-project）───────────────────────────
console.log('  CLI 通道测试 ...');
const node = process.execPath;
const runCli = (args) => spawnSync(node, [path.join(REPO, 'plugins/surfcore/tools/bili.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, DSH_HOME } });
const listOut = runCli(['video-project', 'list', '--json']);
check('CLI list', listOut.status === 0 && JSON.parse(listOut.stdout).items?.length === 2);
const statusOut = runCli(['video-project', 'status', project.id, '--json']);
const statusJson = JSON.parse(statusOut.stdout);
check('CLI status', statusOut.status === 0 && statusJson.tasks?.length >= 1 && statusJson.artifactsByRevision?.['1']?.length >= 7);
const previewOut = runCli(['video-project', 'preview', project.id, '--revision', '1', '--json']);
const previewJson = JSON.parse(previewOut.stdout);
check('CLI preview', previewOut.status === 0 && previewJson.scenes?.length === 2 && fs.existsSync(previewJson.files.mp4));
const badPlanFile = path.join(DSH_HOME, 'bad-plan.json');
fs.writeFileSync(badPlanFile, JSON.stringify({ schemaVersion: 1, title: 'x', scenes: [] }));
const saveBad = runCli(['video-project', 'save', project.id, '--expect-revision', '1', '--plan-file', badPlanFile, '--json']);
check('CLI 拒绝非法计划', saveBad.status !== 0 && JSON.parse(saveBad.stdout).code === 'VIDEO_PLAN_INVALID');

// ── 5. 管理 API（设置页播放/下载依赖的 Range 流式）────────────────────
console.log('  管理 API 流式测试 ...');
const { createVideoApi } = await import('../plugins/surfcore/lib/video/publish-web.js');
const api = createVideoApi({
  storeFactory: () => ({ store, root, character }),
  log: () => {},
});
function mockRes() {
  let resolveDone = () => {};
  const res = {
    statusCode: 200, headers: {}, chunks: [], ended: false,
    done: new Promise((resolve) => { resolveDone = resolve; }),
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk) this.write(chunk); this.ended = true; resolveDone(); },
    emit() {}, on() {}, once() {}, destroy() {},
  };
  return res;
}
async function apiGet(pathname, { method = 'GET', headers = {} } = {}) {
  const res = mockRes();
  const url = new URL(`http://127.0.0.1${pathname}`);
  await api.handle({ method, headers, url }, res, url);
  await res.done; // 流式响应：等 end 后再读
  return { res, body: Buffer.concat(res.chunks), json: (() => { try { return JSON.parse(Buffer.concat(res.chunks).toString()); } catch { return null; } })() };
}
const base = '/dsh-surfcore/api/bili/video';
const listRes = await apiGet(`${base}/projects`);
check('API 项目列表', listRes.res.statusCode === 200 && listRes.json?.items?.length === 2);
const detailRes = await apiGet(`${base}/projects/${project.id}`);
check('API 项目详情', detailRes.res.statusCode === 200 && detailRes.json?.project?.id === project.id && detailRes.json?.artifactsByRevision?.['1']?.length >= 7);
const fullRes = await apiGet(`${base}/projects/${project.id}/revisions/1/artifacts/mp4`);
const mp4Size = fs.statSync(mp4).size;
check('API 整片 200', fullRes.res.statusCode === 200 && fullRes.res.headers['content-length'] === String(mp4Size) && fullRes.body.length === mp4Size, `code=${fullRes.res.statusCode} cl=${fullRes.res.headers['content-length']} len=${fullRes.body.length} want=${mp4Size}`);
const rangeRes = await apiGet(`${base}/projects/${project.id}/revisions/1/artifacts/mp4`, { headers: { range: 'bytes=0-1023' } });
const fileHead = fs.readFileSync(mp4).subarray(0, 1024);
check('API Range 206 前 1KB', rangeRes.res.statusCode === 206 && rangeRes.res.headers['content-range'] === `bytes 0-1023/${mp4Size}` && rangeRes.body.length === 1024 && rangeRes.body.equals(fileHead));
const suffixRes = await apiGet(`${base}/projects/${project.id}/revisions/1/artifacts/mp4`, { headers: { range: 'bytes=-2048' } });
check('API Range 后缀 2KB', suffixRes.res.statusCode === 206 && suffixRes.body.length === 2048 && suffixRes.body.equals(fs.readFileSync(mp4).subarray(mp4Size - 2048)), `code=${suffixRes.res.statusCode} len=${suffixRes.body.length} cr=${suffixRes.res.headers['content-range']}`);
const headRes = await apiGet(`${base}/projects/${project.id}/revisions/1/artifacts/mp4`, { method: 'HEAD' });
check('API HEAD 只回长度', headRes.res.statusCode === 200 && headRes.res.headers['content-length'] === String(mp4Size) && headRes.body.length === 0, `code=${headRes.res.statusCode} len=${headRes.body.length}`);
const badKind = await apiGet(`${base}/projects/${project.id}/revisions/1/artifacts/../../etc/passwd`);
check('API 拒绝穿越工件路径', badKind.res.statusCode === 404 && badKind.json?.code === 'VIDEO_NOT_FOUND');
const badId = await apiGet(`${base}/projects/..%2F..%2Fetc/revisions/1/artifacts/mp4`);
check('API 拒绝非法项目 id', badId.res.statusCode === 400);
const approveRes = await apiGet(`${base}/projects/${project.id}/approve`, { method: 'POST' });
check('API approve 阶段三 501', approveRes.res.statusCode === 501 && approveRes.json?.code === 'VIDEO_PHASE3');

// ── 6. 收尾 ────────────────────────────────────────────────────────
store.close();
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
console.log(`产物目录：${root}（DSH_HOME=${DSH_HOME}）`);
if (failed > 0) process.exit(1);
