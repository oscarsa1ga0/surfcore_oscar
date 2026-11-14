import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { accountBili } from '../../tools/lib/state-paths.mjs';
import { assertOutboundIdentitySafe } from '../../tools/lib/outbound-guard.mjs';
import { validatePlanAssets } from './assets.js';
import { sha256Of } from './project-store.js';
import { revisionDirFor } from './paths.js';
import { AI_STATEMENT_ID, BV_RE, publishError, readFishLogin } from './bili-video-adapter.js';

export const ACTIVE_UPLOAD = ['authorized', 'uploading', 'uploaded'];
export const FOLLOW_UP = ['submitting', 'submission_unknown', 'submitted', 'processing', 'reviewing'];
export const PROJECT_ID = /^p_[a-f0-9]{16}$/;
const FIX = '到「视频创作」查看稿件、修订并重新审片';

function fail(code, message, hint = FIX) {
  throw publishError(code, message, hint);
}

export function fishMid(cfg, login = readFishLogin()) {
  const mid = String(cfg.self?.mid || login.mid || '');
  let ownerMid = String(cfg.owner?.mid ?? '');
  if (!ownerMid) {
    try { ownerMid = String(JSON.parse(fs.readFileSync(accountBili('owner-credentials.json'), 'utf8')).mid ?? ''); }
    catch {}
  }
  if (!/^\d+$/.test(mid) || (login.mid && String(login.mid) !== mid) || mid === ownerMid) {
    fail('VIDEO_ACCOUNT_REQUIRED', '需要绑定鱼姬自己的 B 站账号', '在 B 站设置重新核对鱼姬账号和主人账号');
  }
  return mid;
}

function openArtifact(store, root, id, revision, kind, extension, limit) {
  const artifact = store.getArtifact(id, revision, kind);
  const wanted = revisionDirFor(root, id, revision);
  let dir;
  try { dir = fs.realpathSync(wanted); }
  catch { fail('VIDEO_PUBLISH_ARTIFACT', '缺少已渲染的版本'); }
  if (dir !== path.join(fs.realpathSync(root), path.relative(root, wanted))) fail('VIDEO_PUBLISH_ARTIFACT', '版本目录越界');
  if (!artifact || !/^[a-z0-9-]+\.[a-z0-9]+$/i.test(artifact.relativePath)
    || path.extname(artifact.relativePath) !== extension) fail('VIDEO_PUBLISH_ARTIFACT', `缺少有效的 ${kind} 工件`);
  const file = path.join(dir, artifact.relativePath);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch { fail('VIDEO_PUBLISH_ARTIFACT', `工件 ${kind} 文件缺失`); }
  if (!stat.isFile() || !stat.size || stat.size > limit || stat.size !== artifact.sizeBytes) {
    fail('VIDEO_PUBLISH_ARTIFACT', `${kind} 大小有变或超出投稿上限`, '重新渲染此版本');
  }
  return { file, size: stat.size, sha256: artifact.sha256 };
}

export async function checkArtifactHash(artifact, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(artifact.file, { signal })) hash.update(chunk);
  if (hash.digest('hex') !== artifact.sha256) fail('VIDEO_PACKAGE_CHANGED', '工件内容与渲染记录不同', '重新渲染、审片并提交新版');
}

export function preparePackage({ store, root, projectId, revision, cfg, login, requireReady = true, allowUnbound = false }) {
  const project = PROJECT_ID.test(projectId) && store.getProject(projectId);
  if (!project || !Number.isInteger(revision) || revision <= 0 || (requireReady && project.revision !== revision)) {
    fail('VIDEO_BAD_REVISION', '找不到所选投稿版本');
  }
  const record = store.getPlan(projectId, revision);
  if (!record || (requireReady && (project.editState !== 'ready' || record.reviewDecision !== 'keep'))) {
    fail('VIDEO_PUBLISH_REVIEW', '先审片并标为保留', '用 video-project preview 审片，再调用 review --decision keep');
  }
  if (requireReady && project.tasks.some((task) => ['queued', 'running', 'retryable'].includes(task.state))) {
    fail('VIDEO_PUBLISH_RENDERING', '此版本还有渲染任务，请等出片后再投稿');
  }
  const plan = record.plan;
  const sources = validatePlanAssets(store, root, plan);
  const submission = plan.submission ?? {};
  const tid = Number(submission.tid ?? cfg.video?.publishTid);
  const copyright = submission.copyright === 'repost' ? 2 : 1;
  const source = String(submission.source ?? '').trim();
  const title = String(plan.title ?? '').trim();
  const assets = [...sources.values()].map(({ asset }) => asset);
  const credits = [...new Set(assets.map((asset) => asset.authorization?.credit).filter(Boolean))];
  const description = [String(submission.description ?? '').trim(), ...(credits.length ? [`素材署名：${credits.join('、')}`] : [])].join('\n');
  const tags = Array.isArray(submission.tags) ? [...new Set(submission.tags)] : [];
  if (!title || [...title].length > 80 || !description.trim() || [...description].length > 2000
    || (submission.tags != null && !Array.isArray(submission.tags)) || tags.length > 10 || tags.some((tag) => typeof tag !== 'string' || !tag.trim() || [...tag].length > 20 || /[,，\r\n]/u.test(tag))) {
    fail('VIDEO_BILI_METADATA', '标题最多 80 字，简介最多 2000 字，标签最多 10 个且每个最多 20 字');
  }
  if (!Number.isInteger(tid) || tid <= 0 || tid > 100_000) {
    fail('VIDEO_BILI_CATEGORY', '未选择 B 站投稿分区', '在设置填写创作中心的分区 ID，或在计划 submission.tid 指定');
  }
  if (copyright === 2 && (!/^https:\/\/\S+$/u.test(source) || source.length > 250)) {
    fail('VIDEO_BILI_SOURCE', '转载稿件需要填写来源链接');
  }
  if (submission.copyright != null && !['original', 'repost'].includes(submission.copyright)) {
    fail('VIDEO_BILI_SOURCE', 'copyright 仅支持 original 或 repost');
  }
  for (const asset of assets) {
    const grant = asset.authorization ?? {};
    if (asset.source !== 'generated' && !grant.publishAllowed) {
      fail('VIDEO_ASSET_PUBLIC_GRANT', `素材 ${asset.id} 缺少对外使用授权`, '在素材库核对画面和声音后登记可公开使用，或换成可发布素材');
    }
  }
  try {
    assertOutboundIdentitySafe([title, description, ...tags, source, plan.cover?.headline,
      ...plan.scenes.flatMap((scene) => [scene.titleCard, ...(scene.lines ?? []).flatMap((line) => [line.speech, line.caption])]),
      ...assets.map((asset) => asset.authorization?.cardText),
    ].filter(Boolean).join('\n'), { surface: 'B站视频投稿' });
  } catch {
    fail('VIDEO_PRIVATE_CONTENT', '稿件包含需保密的身份或账号信息', '检查标题、简介、旁白、字幕、封面文字及素材署名');
  }
  const mp4 = openArtifact(store, root, projectId, revision, 'mp4', '.mp4', (cfg.video?.maxOutputMB || 100) * 1024 ** 2);
  const cover = openArtifact(store, root, projectId, revision, 'cover', '.png', 8 * 1024 ** 2);
  if (!store.getArtifact(projectId, revision, 'qa')?.meta?.pass) fail('VIDEO_PUBLISH_QA', '先渲染并通过技术质检');
  const accountMid = allowUnbound && !String(cfg.self?.mid || (login ?? readFishLogin()).mid || '') ? '' : fishMid(cfg, login);
  const metadata = { title, description, tags, tid, copyright, source, aiStatement: AI_STATEMENT_ID };
  const grants = assets.map((asset) => [asset.sha256, asset.authorization?.mode, asset.authorization?.grantedAt]);
  const packageHash = sha256Of(JSON.stringify([projectId, revision, accountMid, record.planHash, mp4.sha256, cover.sha256, metadata, grants]));
  return { projectId, revision, accountMid, packageHash, metadata, mp4, cover };
}

export function modeFor(cfg) {
  return ['confirm', 'auto'].includes(cfg.video?.publishMode) ? cfg.video.publishMode : 'draft';
}

export function safePublish(row) {
  if (!row) return null;
  const { remoteSession, partAcks, approvalRef, reconcileBvid, mp4Hash, ...rest } = row;
  return { ...rest, uploadedParts: partAcks.length, totalParts: remoteSession?.totalParts ?? null };
}

export async function requestPublication(ctx, action, { forceApproval = false } = {}) {
  const { store, cfg } = ctx;
  if (!['dry', 'draft', 'go'].includes(action)) fail('VIDEO_PUBLISH_ACTION', '请选择 --dry、--draft 或 --go');
  const mode = modeFor(cfg);
  const packageContext = { ...ctx, allowUnbound: action !== 'go' || mode === 'draft' };
  const pack = preparePackage(packageContext);
  await Promise.all([checkArtifactHash(pack.mp4), checkArtifactHash(pack.cover)]);
  const detail = { projectId: pack.projectId, revision: pack.revision, accountMid: pack.accountMid,
    metadata: pack.metadata, packageHash: pack.packageHash, mode, sizeBytes: pack.mp4.size };
  if (action === 'dry') return { ok: true, ...detail };
  if (!cfg.video?.enabled) fail('VIDEO_DISABLED', '视频创作已关闭', '在设置启用视频创作并保存');
  if (mode !== 'draft' && action === 'go' && cfg.interact?.enabled === false) {
    fail('VIDEO_INTERACT_DISABLED', '当前禁止 B 站对外互动', '关闭沉默逛或仅保存本地草稿');
  }
  const state = action === 'draft' || mode === 'draft' ? 'local_draft' : 'awaiting_approval';
  const verified = !forceApproval && mode === 'auto' && store.hasVerifiedVideoCategory(pack.accountMid, pack.metadata.tid);
  const current = preparePackage(packageContext);
  if (current.packageHash !== pack.packageHash) fail('VIDEO_PACKAGE_CHANGED', '稿件包已变化');
  const row = store.requestPublish({
    ...pack, state: state === 'awaiting_approval' && verified ? 'authorized' : state,
    approvalRef: state === 'awaiting_approval' && verified ? 'auto' : null,
  });
  return { ok: true, ...detail, publish: safePublish(row), autoVerified: verified };
}

export async function approvePublication(ctx, { attemptId, packageHash }) {
  const { store, cfg } = ctx;
  if (!cfg.video?.enabled || modeFor(cfg) === 'draft' || cfg.interact?.enabled === false) {
    fail('VIDEO_PUBLISH_MODE', '当前设置只允许本地创作', '启用投稿前确认或自主投稿，并允许 B 站互动');
  }
  const row = store.getPublish(attemptId);
  if (!row || row.projectId !== ctx.projectId || row.revision !== ctx.revision || row.packageHash !== packageHash) {
    fail('VIDEO_PACKAGE_CHANGED', '待确认稿件已变化', '刷新并核对版本、分区与稿件包');
  }
  const pack = preparePackage(ctx);
  if (pack.packageHash !== row.packageHash || row.accountMid !== pack.accountMid) fail('VIDEO_PACKAGE_CHANGED', '稿件包已变化');
  await Promise.all([checkArtifactHash(pack.mp4), checkArtifactHash(pack.cover)]);
  if (preparePackage(ctx).packageHash !== row.packageHash) fail('VIDEO_PACKAGE_CHANGED', '稿件包已变化');
  if (row.state !== 'awaiting_approval') return safePublish(row);
  return safePublish(store.updatePublish(row.attemptId, { state: 'authorized', approvalRef: 'confirmed', nextPollAt: 0 },
    { expected: 'awaiting_approval' }));
}

export function readUploadToken(attemptId) {
  const file = tokenFile(attemptId);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || (process.platform !== 'win32' && stat.mode & 0o077)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function tokenFile(attemptId) {
  if (!/^pub_[a-f0-9]{16}$/.test(attemptId)) throw new Error('invalid attempt id');
  return accountBili('video-upload-sessions', `${attemptId}.json`);
}

export function saveUploadToken(attemptId, value) {
  const file = tokenFile(attemptId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function clearUploadToken(attemptId) {
  fs.rmSync(tokenFile(attemptId), { force: true });
}

export function refreshPublication({ store, projectId }, attemptId = null, candidate = null) {
  if (candidate && (!attemptId || !BV_RE.test(candidate))) fail('VIDEO_BILI_BV', '对账 BV 号无效', '粘贴创作中心返回的 BV 号');
  const rows = store.listPublishes(projectId);
  if (attemptId && !rows.some((row) => row.attemptId === attemptId)) fail('VIDEO_PUBLISH_NOT_FOUND', '稿件不存在');
  let refreshed = 0;
  for (const row of rows) {
    if (attemptId && row.attemptId !== attemptId) continue;
    if (candidate && !['submitting', 'submission_unknown'].includes(row.state)) fail('VIDEO_BILI_BV', '只有投递结果待核实的稿件需要提供 BV');
    if (![...FOLLOW_UP, 'published', 'blocked', 'rejected', 'withdrawn'].includes(row.state)) continue;
    let state = row.state;
    if (state === 'blocked' && row.approvalRef && !row.submittedAt) {
      state = row.remoteSession?.media ? 'uploaded' : 'authorized';
    } else if (state === 'blocked') continue;
    if (['withdrawn', 'rejected'].includes(state) && !row.archiveId && !row.bvid) continue;
    // A refresh of an ambiguous submission always performs reconciliation only.
    const next = ['withdrawn', 'rejected'].includes(state) ? 'submitted' : state;
    store.updatePublish(row.attemptId, { state: next, nextPollAt: 0 }, { expected: row.state,
      meta: { ...(state === 'published' && row.memoryState !== 'done' ? { nextEffectAt: 0 } : {}), uploadAttempts: 0, ...(candidate ? { reconcileBvid: candidate } : {}) } });
    refreshed += 1;
  }
  return { refreshed };
}
