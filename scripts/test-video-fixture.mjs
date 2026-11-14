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
import { Readable } from 'node:stream';
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
const { validatePlan, computeTimeline, splitCaption } = await import('../plugins/surfcore/lib/video/plan.js');
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
fs.writeFileSync(path.join(DSH_HOME, 'surfcore', 'bili.config.json'), JSON.stringify({ video: { enabled: true } }));
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
check('长中文无标点也按字数拆分', splitCaption('鱼'.repeat(80)).every((part) => part.length <= 28) && splitCaption('鱼'.repeat(80)).join('').length === 80);
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
const manifestDurations = JSON.parse(fs.readFileSync(path.join(revDir, byKind.manifest.relativePath), 'utf8')).lineDurations;
const s01scene = computeTimeline(plan, manifestDurations).scenes.find((s) => s.id === 's01');
const gapsOk = s01scene.cues.every((c, i) => i === 0 || c.startMs - s01scene.cues[i - 1].endMs >= 800);
check('voice 镜头句间停顿 ≥800ms', gapsOk, s01scene.cues.map((c) => `${c.startMs}→${c.endMs}`).join(' '));
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
const { createVideoApi, setVideoConfigReader } = await import('../plugins/surfcore/lib/video/publish-web.js');
setVideoConfigReader(() => ({ enabled: true }));
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
async function apiGet(pathname, { method = 'GET', headers = {}, body = null } = {}) {
  const res = mockRes();
  const url = new URL(`http://127.0.0.1${pathname}`);
  const req = body ? Readable.from([JSON.stringify(body)]) : {};
  await api.handle(Object.assign(req, { method, headers, url }), res, url);
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
const approveRes = await apiGet(`${base}/projects/${project.id}/approve`, { method: 'POST', body: {} });
check('API approve 拒绝缺少角色及版本的请求', approveRes.res.statusCode === 409 && approveRes.json?.code === 'VIDEO_CHARACTER_CHANGED');

// ── 6. 阶段二：素材授权、混剪、对照与增量渲染 ────────────────
const mediaDir = path.join(DSH_HOME, 'media-fixture');
fs.mkdirSync(mediaDir);
function generate(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}
const clipFile = path.join(mediaDir, 'clip.mp4');
generate(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=7',
  '-f', 'lavfi', '-i', 'sine=f=440:duration=7', '-c:v', 'libx264', '-c:a', 'aac', '-y', clipFile]);
const musicFile = path.join(mediaDir, 'music.wav');
const sfxFile = path.join(mediaDir, 'FX.wav');
generate(['-f', 'lavfi', '-i', 'sine=f=310:duration=18', '-y', musicFile]);
generate(['-f', 'lavfi', '-i', 'sine=f=590:duration=1', '-y', sfxFile]);
const role = { characterId: character.id, characterEpoch: character.epoch };
const submitAsset = (kind, file, authorization, identity = role) =>
  apiGet(`${base}/assets`, { method: 'POST', body: { ...identity, kind, file, authorization } });
const grant = { mode: 'original', note: '测试程序生成' };
const denied = await submitAsset('clip', clipFile, { mode: 'licensed', note: '缺凭据' });
check('素材授权缺失时返回结构化失败', denied.json?.code === 'VIDEO_ASSET_AUTH_REQUIRED' && !!denied.json?.hint);
const stale = await submitAsset('clip', clipFile, grant, { ...role, characterEpoch: 999 });
check('过期角色页面不能导入素材', stale.json?.code === 'VIDEO_CHARACTER_CHANGED');
const shots = path.join(DSH_HOME, 'shots', 'video');
fs.mkdirSync(shots, { recursive: true });
const watched = path.join(shots, 'watch.mp4');
fs.copyFileSync(clipFile, watched);
check('拒绝直接导入观看缓存', (await submitAsset('clip', watched, grant)).json?.code === 'VIDEO_ASSET_REFERENCE_ONLY');
const clip = (await submitAsset('clip', clipFile, grant)).json;
const music = (await submitAsset('music', musicFile, grant)).json;
const sfx = (await submitAsset('sfx', sfxFile, grant)).json;
check('登记原创视频、配乐、音效并读取真实时长', [clip, music, sfx].every((item) => item?.asset?.authorization?.media?.durationMs > 0), JSON.stringify([clip, music, sfx].map((item) => item?.code)));
const reorderedFirst = (await submitAsset('clip', clipFile, grant)).json;
check('素材授权重录保留内容 ID', reorderedFirst.duplicate && reorderedFirst.asset.id === clip.asset.id);
const demo = structuredClone(plan);
demo.scenes[0].transitionOut = { kind: 'fade_black', durationMs: 500 };
demo.scenes[1] = {
  ...demo.scenes[1],
  visual: { assetId: clip.asset.id, fit: 'contain', motion: 'none', inMs: 1000, outMs: 6000, audio: 'mix' },
  duration: { mode: 'clip' },
};
demo.audioTracks = [
  { kind: 'music', assetId: music.asset.id, startMs: 0, inMs: 500, outMs: 16000, gainDb: -22 },
  { kind: 'sfx', assetId: sfx.asset.id, startMs: 17200, inMs: 0, outMs: 700, gainDb: -12 },
];
const mixed = store.createProject({ characterId: character.id, title: '混剪阶段二' });
const demoPlanFile = path.join(mediaDir, 'mix.json');
fs.writeFileSync(demoPlanFile, JSON.stringify(demo));
const cli = (action, args) => {
  const result = runCli(['video-project', action, mixed.id, ...args, '--json']);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(result.stderr || result.stdout || `CLI exited ${result.status}`); }
};
check('既有 save 命令接受新计划', cli('save', ['--expect-revision', '0', '--plan-file', demoPlanFile]).revision === 1);
const premature = cli('review', ['--revision', '1', '--decision', 'keep']);
check('未出片不能标记满意', premature.code === 'VIDEO_REVIEW_NOT_READY' && !!premature.hint);
let stage2SynthCalls = 0;
const stage2Worker = createVideoWorker({ store, root, synth: (line) => { stage2SynthCalls += 1; return fixtureSynth(line); }, tickMs: 100, log: console.log });
stage2Worker.start();
async function renderMix(revision) {
  const queued = cli('render', ['--revision', String(revision)]);
  const settled = await waitFor(() => {
    const task = store.getTask(queued.jobId);
    return ['succeeded', 'blocked', 'retryable'].includes(task?.state) && task;
  }, 60_000, 200);
  if (settled.state !== 'succeeded') throw new Error(JSON.stringify(settled));
  return cli('preview', ['--revision', String(revision)]);
}
const mixed1 = await renderMix(1);
check('混剪出片，裁切后镜头为 5 秒', mixed1.scenes[1].durationMs === 5000 && mixed1.qa.ok && mixed1.audioTracks.length === 2);
check('旁白试听、旁白稿与关键帧时码可用',
  fs.existsSync(mixed1.files.narration) && mixed1.narration.length === 3
  && mixed1.keyframes.every((frame) => frame.atMs > 0 && fs.existsSync(frame.file)));
check('镜头帧和旁白可经管理 API 播放', (await apiGet(`${base}/projects/${mixed.id}/revisions/1/artifacts/frame-s02`)).res.headers['content-type'] === 'image/png'
  && (await apiGet(`${base}/projects/${mixed.id}/revisions/1/artifacts/narration`)).res.headers['content-type'] === 'audio/wav');
check('审片进入待改并记理由', cli('review', ['--revision', '1', '--decision', 'revise', '--reason', '第二镜头缩短一秒']).editState === 'editing'
  && store.getProject(mixed.id).revisions[0].reviewReason === '第二镜头缩短一秒');
const patchFile = path.join(mediaDir, 'patch.json');
fs.writeFileSync(patchFile, JSON.stringify({ scenes: [{ id: 's02', visual: { outMs: 5000 } }], cover: { headline: '第二版' } }));
check('按段修订生成新版本', cli('revise', ['--expect-revision', '1', '--patch-file', patchFile]).revision === 2);
check('过期审片不能改变新版本状态', cli('review', ['--revision', '1', '--decision', 'keep']).code === 'VIDEO_REVISION_CONFLICT');
const mixed2 = await renderMix(2);
check('缩短镜头不重做旁白 TTS', stage2SynthCalls === demo.scenes[0].lines.length);
check('新版缩短一秒、旧版产物保留', mixed1.totalMs - mixed2.totalMs === 1000 && fs.existsSync(mixed1.files.mp4));
const cmp = cli('compare', ['--from', '1', '--to', '2']);
check('版本对照给出变更、时码和复用', cmp.ok && cmp.coverChanged && cmp.sceneChanges.length === 1 && cmp.sceneChanges[0].sceneId === 's02'
  && cmp.rendered?.reusedScenes.includes('s01') && cmp.rendered?.reusedNarrationScenes.includes('s01')
  && cmp.timings.from.totalMs - cmp.timings.to.totalMs === 1000);
fs.writeFileSync(patchFile, JSON.stringify({ cover: { headline: '只换封面' } }));
check('单独换封面生成独立版本', cli('revise', ['--expect-revision', '2', '--patch-file', patchFile]).revision === 3);
await renderMix(3);
check('换封面复用 MP4 编码', store.getArtifact(mixed.id, 3, 'preview').meta.reusedFinal
  && store.getArtifact(mixed.id, 3, 'mp4').sha256 === store.getArtifact(mixed.id, 2, 'mp4').sha256
  && store.getArtifact(mixed.id, 3, 'cover').sha256 !== store.getArtifact(mixed.id, 2, 'cover').sha256);
check('版本对照可经管理 API 读取', (await apiGet(`${base}/projects/${mixed.id}/compare?from=2&to=3`)).json?.coverChanged);
check('满意后标为已审片', cli('review', ['--revision', '3', '--decision', 'keep', '--reason', '节奏合适']).editState === 'ready');
const revoke = (await apiGet(`${base}/assets/${clip.asset.id}/revoke`, { method: 'POST', body: role })).json;
check('撤销后保留历史预览、阻止新渲染', !!revoke.asset.authorization.revokedAt && fs.existsSync(mixed1.files.mp4));
const revokedTask = cli('render', ['--revision', '3']);
const revokeBlocked = await waitFor(() => {
  const task = store.getTask(revokedTask.jobId);
  return task?.state === 'blocked' && task;
}, 5000, 100);
check('执行器拒绝撤销素材并给提示', revokeBlocked.errorCode === 'VIDEO_ASSET_REVOKED' && !!revokeBlocked.hint);
check('搁置后当前版本状态准确', cli('review', ['--revision', '3', '--decision', 'shelve']).editState === 'shelved');
stage2Worker.stop();
await stage2Worker.drain();
const fenced = store.enqueueTask({ projectId: project.id, revision: 1, kind: 'render' });
const claimed = store.claimNextTask({ owner: 'fixture-stale' });
store.setReviewDecision(project.id, 1, 'shelve');
check('已搁置的任务拒绝迟到的成功写入', claimed?.task.jobId === fenced.jobId && !store.completeTask(fenced.jobId, claimed.fence)
  && store.getTask(fenced.jobId).state === 'cancelled');
const configFile = path.join(DSH_HOME, 'surfcore', 'bili.config.json');
fs.writeFileSync(configFile, JSON.stringify({ video: { enabled: false } }));
check('功能关闭时 CLI 禁止新建、仍可看历史', cli('render', ['--revision', '3']).code === 'VIDEO_DISABLED'
  && cli('preview', ['--revision', '3']).ok);
const wrongScene = structuredClone(demo);
wrongScene.scenes[1].id = '../bad';
check('场景 id 不能写出关键帧目录', !validatePlan(wrongScene).ok);
const { reserveDailyUsage, assertVideoDiskBudget } = await import('../plugins/surfcore/lib/video/budget.js');
const day = new Date('2026-11-14T15:59:59.000Z');
reserveDailyUsage(store.db, 'tts', 5, 6, day);
let budgetError;
try { reserveDailyUsage(store.db, 'tts', 2, 6, day); } catch (error) { budgetError = error; }
check('每日额度事务拒绝超额，上海次日可继续', budgetError?.code === 'VIDEO_DAILY_BUDGET' && !!budgetError.hint);
reserveDailyUsage(store.db, 'tts', 2, 6, new Date('2026-11-14T16:00:00.000Z'));
try { assertVideoDiskBudget(root, 1); } catch (error) { budgetError = error; }
check('磁盘预算有可操作的错误提示', budgetError?.code === 'VIDEO_DISK_BUDGET' && !!budgetError.hint);

// ── 6. 收尾 ────────────────────────────────────────────────────────
store.close();
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
console.log(`产物目录：${root}（DSH_HOME=${DSH_HOME}）`);
if (failed > 0) process.exit(1);
