import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findNodeExe } from '../paths.js';
import { acquirePublicationLock, reservePublicationSlot } from '../../tools/lib/publication-slot.mjs';
import { appendBiliPost } from '../../tools/lib/bili-posts.mjs';
import { BV_RE, createBiliVideoAdapter, publishError, readFishLogin } from './bili-video-adapter.js';
import {
  ACTIVE_UPLOAD, FOLLOW_UP, checkArtifactHash, clearUploadToken, fishMid, modeFor,
  preparePackage, readUploadToken, saveUploadToken,
} from './publish-state.js';

const POLL_INTERVALS = [60_000, 300_000, 900_000, 3_600_000];
const THREE_DAYS = 3 * 86_400_000;
const CHECK_HINT = '到 B 站创作中心核对稿件后，在视频项目里刷新审核';
const NOTIFY_SCRIPT = fileURLToPath(new URL('../../tools/commands/notify.mjs', import.meta.url));
const packageError = (...args) => { throw publishError(...args); };

function notifyOwner(text) {
  return new Promise((resolve, reject) => {
    execFile(findNodeExe(), [NOTIFY_SCRIPT, text, '--title', '鱼姬的 B 站视频'], { timeout: 65_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function recoverDelay(error, attempts) {
  const supplied = Number(error?.retryAfterMs);
  return supplied > 0 ? Math.min(supplied, 86_400_000)
    : Math.min(30 * 60_000, 15_000 * 2 ** Math.min(attempts, 7));
}

async function writeMemory(root, row) {
  const bvid = row.bvid;
  const at = row.publishedAt ?? new Date().toISOString();
  return appendBiliPost(path.join(root, '..', 'bili-posts.jsonl'), {
    id: `video:${bvid}`, type: 'video', bvid,
    title: row.metadata.title, text: row.metadata.description, summary: row.metadata.description,
    cover: row.publicCover ?? '', url: `https://www.bilibili.com/video/${bvid}/`, at,
    date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(at)), source: 'video-project',
  }, { strict: true, once: true });
}

export function createVideoPublisher({
  store, root, getConfig, isCurrent = () => true,
  getLogin = readFishLogin, makeAdapter = createBiliVideoAdapter,
  notify = notifyOwner, memory = writeMemory,
}) {
  function transition(row, patch, meta) {
    return store.updatePublish(row.attemptId, patch, { expected: row.state, meta });
  }

  function authorize(row) {
    const cfg = getConfig();
    if (!isCurrent()) packageError('VIDEO_ROLE_CHANGED', '角色已切换，投稿暂停', '切回原角色后刷新');
    const current = store.getPublish(row.attemptId);
    if (!current || !ACTIVE_UPLOAD.includes(current.state)) packageError('VIDEO_PUBLISH_STOPPED', '稿件已暂停', CHECK_HINT);
    if (modeFor(cfg) === 'draft' || !cfg.video?.enabled || cfg.interact?.enabled === false
      || (current.approvalRef === 'auto' && modeFor(cfg) !== 'auto')) {
      packageError('VIDEO_PUBLISH_MODE', '当前设置暂停 B 站投稿', '恢复对应投稿档，或导出成片手动投稿');
    }
    if (current.approvalRef === 'auto' && !store.hasVerifiedVideoCategory(row.accountMid, row.metadata.tid)) {
      packageError('VIDEO_PUBLISH_UNVERIFIED', '此账号和分区还没有回读确认的投稿记录', '先确认一次投稿并验证 AI 声明和分区');
    }
    const login = getLogin();
    if (fishMid(cfg, login) !== row.accountMid) packageError('VIDEO_ACCOUNT_CHANGED', '稿件所绑定的账号已变化', CHECK_HINT);
    const pack = preparePackage({ store, root, projectId: row.projectId, revision: row.revision, cfg, login });
    if (pack.packageHash !== row.packageHash) packageError('VIDEO_PACKAGE_CHANGED', '原稿件包已变化', '重新提交审片通过的稿件');
    return pack;
  }

  async function upload(row, signal) {
    let retryRow = row;
    try {
      const pack = authorize(row);
      await Promise.all([checkArtifactHash(pack.mp4, signal), checkArtifactHash(pack.cover, signal)]);
      const login = getLogin();
      const adapter = makeAdapter({ login, signal });
      await adapter.verifyAccount(row.accountMid);
      await adapter.validateSubmission(pack.metadata);
      authorize(row);
      signal?.throwIfAborted();

      if (!retryRow.remoteSession?.media) {
        let session = readUploadToken(row.attemptId);
        let parts = retryRow.partAcks;
        if (!session || session.packageHash !== row.packageHash || session.size !== pack.mp4.size
          || Date.now() - (session.startedAt ?? 0) > 86_400_000) {
          session = { ...await adapter.beginUpload(pack.mp4.size), packageHash: row.packageHash, startedAt: Date.now() };
          saveUploadToken(row.attemptId, session);
          parts = [];
        }
        const totalParts = Math.ceil(session.size / session.chunkSize);
        const sessionKey = createHash('sha256').update(String(session.uploadId)).digest('hex');
        if (retryRow.remoteSession?.sessionKey !== sessionKey) parts = [];
        retryRow = transition(retryRow, { state: 'uploading', partAcks: parts, remoteSession: { totalParts, sessionKey } });
        const fd = await fs.promises.open(pack.mp4.file, 'r');
        try {
          for (let index = 0; index < totalParts; index++) {
            if (parts.some((part) => part.partNumber === index + 1)) continue;
            authorize(row);
            signal?.throwIfAborted();
            const start = index * session.chunkSize;
            const bytes = Buffer.alloc(Math.min(session.chunkSize, pack.mp4.size - start));
            const { bytesRead } = await fd.read(bytes, 0, bytes.length, start);
            if (bytesRead !== bytes.length) packageError('VIDEO_PACKAGE_CHANGED', '视频文件在上传过程中被修改', '重新渲染并审片');
            parts = [...parts, await adapter.putPart(session, index, bytes)].sort((a, b) => a.partNumber - b.partNumber);
            retryRow = transition(retryRow, { partAcks: parts });
          }
        } finally { await fd.close(); }
        authorize(row);
        signal?.throwIfAborted();
        const media = await adapter.completeUpload(session, parts);
        retryRow = transition(retryRow, { state: 'uploaded', remoteSession: { totalParts, media } });
        clearUploadToken(row.attemptId);
      }

      if (!retryRow.remoteSession.media.cover) {
        authorize(row);
        signal?.throwIfAborted();
        const bytes = await fs.promises.readFile(pack.cover.file);
        await checkArtifactHash(pack.cover, signal);
        const cover = await adapter.uploadCover(bytes);
        retryRow = transition(retryRow, { remoteSession: { ...retryRow.remoteSession,
          media: { ...retryRow.remoteSession.media, cover } } });
      }
      authorize(row);
      await Promise.all([checkArtifactHash(pack.mp4, signal), checkArtifactHash(pack.cover, signal)]);
      await adapter.verifyAccount(row.accountMid);
      authorize(row);
      const fresh = getConfig();
      if (JSON.stringify(login) !== JSON.stringify(getLogin())) {
        packageError('VIDEO_PACKAGE_CHANGED', '稿件包或账号登录态已变化', '刷新审核状态后再操作');
      }
      signal?.throwIfAborted();
      const slot = reservePublicationSlot(row.accountMid, path.join(root, '..', 'daily-dynamic.json'), Number(fresh.dynamics?.gapMin ?? 30));
      try {
        slot.record();
        // Any crash after this write is treated as a possibly accepted submission.
        retryRow = transition(retryRow, { state: 'submitting', errorCode: null, error: null, nextPollAt: Date.now() + 60_000 },
          { submittedAt: Date.now(), uploadAttempts: 0 });
        if (retryRow.state !== 'submitting') return;
        try {
          const receipt = await adapter.submit(pack.metadata, retryRow.remoteSession.media);
          transition(retryRow, { ...receipt, state: 'submitted', nextPollAt: Date.now() + 60_000 });
        } catch {
          transition(retryRow, { state: 'submission_unknown', nextPollAt: Date.now() + 60_000,
            errorCode: 'VIDEO_SUBMISSION_UNKNOWN', error: '投稿回执未确认，已安排对账' }, { hint: CHECK_HINT });
        }
      } finally { slot.release(); }
    } catch (error) {
      if (signal?.aborted || error.code === 'VIDEO_PUBLISH_STOPPED') return;
      if (retryRow.state === 'submitting') return;
      if (error.resetUpload) {
        clearUploadToken(row.attemptId);
        retryRow = transition(retryRow, { state: 'authorized', remoteSession: null, partAcks: [] });
      }
      const attempts = (row.uploadAttempts ?? 0) + 1;
      const invalid = ['VIDEO_BAD_REVISION', 'VIDEO_PACKAGE_CHANGED', 'VIDEO_PUBLISH_REVIEW'].includes(error.code);
      const retryable = error.retryable && (attempts < 8 || error.code === 'VIDEO_PUBLISH_COOLDOWN');
      const state = invalid ? 'superseded' : retryable ? retryRow.state : 'blocked';
      if (invalid) clearUploadToken(row.attemptId);
      transition(retryRow, { state, nextPollAt: retryable ? Date.now() + recoverDelay(error, attempts) : null,
        errorCode: error.code ?? 'VIDEO_UPLOAD_FAILED', error: error.code ? error.message : '本地上传任务失败' },
      { uploadAttempts: attempts, hint: error.hint ?? CHECK_HINT });
    }
  }

  async function poll(row, signal) {
    try {
      if (!isCurrent() || signal?.aborted) return;
      const login = getLogin();
      if (fishMid(getConfig(), login) !== row.accountMid) packageError('VIDEO_ACCOUNT_CHANGED', '切回鱼姬原来的账号再查询', CHECK_HINT);
      const adapter = makeAdapter({ login, signal });
      await adapter.verifyAccount(row.accountMid);
      if (['submitting', 'submission_unknown'].includes(row.state)) {
        const match = await adapter.reconcile(row.remoteSession?.media ?? {}, row.metadata, row.reconcileBvid);
        if (match?.archiveId || match?.bvid) {
          row = transition(row, { state: 'submitted', archiveId: match.archiveId, bvid: match.bvid, errorCode: null, error: null });
        } else {
          const attempts = (row.reconcileAttempts ?? 0) + 1;
          transition(row, { state: 'submission_unknown', nextPollAt: attempts < 4 ? Date.now() + POLL_INTERVALS[attempts] : null,
            errorCode: 'VIDEO_SUBMISSION_UNKNOWN', error: '创作中心暂未找到唯一媒体 ID 相符的稿件' },
          { hint: CHECK_HINT, reconcileAttempts: attempts });
          return;
        }
      }
      const result = await adapter.getArchive(row, row.accountMid);
      if (result.state === 'published' && !BV_RE.test(result.bvid ?? '')) packageError('VIDEO_BILI_ARCHIVE_MISMATCH', '公开稿件缺少 BV 号', CHECK_HINT);
      const attempts = (row.pollAttempts ?? 0) + 1;
      // 2026-11 实测：服务端会把请求分区归一（1011 人工智能 → 21 日常）。
      // 分区属性以回读的 tid 为准；只要原生 AI 声明、自制属性和分区都对得上即视为已验证。
      const aiVerified = result.aiMarked === true && Number(result.tid) > 0 && result.copyright === row.metadata.copyright;
      const terminal = ['published', 'rejected', 'withdrawn'].includes(result.state);
      transition(row, {
        state: result.state, bvid: result.bvid ?? row.bvid, archiveId: result.archiveId ?? row.archiveId,
        nextPollAt: terminal || Date.now() - (row.submittedAt ?? row.createdAt) > THREE_DAYS ? null
          : Date.now() + POLL_INTERVALS[Math.min(attempts, POLL_INTERVALS.length - 1)],
        errorCode: result.state === 'published' && !aiVerified ? 'VIDEO_BILI_DECLARATION_UNVERIFIED' : null,
        error: result.state === 'published' && !aiVerified ? '公开视频已确认，AI 声明、分区或自制属性仍待回读核对' : null,
      }, { hint: result.state === 'published' && !aiVerified ? CHECK_HINT : null,
        pollAttempts: attempts, rawRemoteState: result.rawState ?? null, remoteReason: result.reason ?? '',
        aiVerified, publicCover: result.cover, publishedAt: result.publishedAt });
      if (result.state === 'published') {
        // 服务端归一的实际分区与请求分区都记一次，自主投稿按同一个分区放行。
        store.verifyVideoCategory(row.accountMid, result.tid || row.metadata.tid, aiVerified);
        if (aiVerified && result.tid && Number(result.tid) !== Number(row.metadata.tid)) {
          store.verifyVideoCategory(row.accountMid, row.metadata.tid, true);
        }
      }
    } catch (error) {
      if (signal?.aborted) return;
      transition(row, { nextPollAt: error.retryable && Date.now() - (row.submittedAt ?? row.createdAt) < THREE_DAYS
          ? Date.now() + recoverDelay(error, row.pollAttempts ?? 0) : null,
        errorCode: error.code ?? 'VIDEO_STATUS_FAILED', error: error.code ? error.message : '稿件查询失败' },
      { pollAttempts: (row.pollAttempts ?? 0) + 1, hint: error.hint ?? CHECK_HINT });
    }
  }

  async function effects(row) {
    if (!isCurrent()) return;
    let memoryState = row.memoryState;
    let noticeState = row.noticeState;
    if (memoryState !== 'done') {
      try { await memory(root, row); memoryState = 'done'; }
      catch { memoryState = 'failed'; }
      transition(row, {}, { memoryState, nextEffectAt: Date.now() + 300_000 });
    }
    if (!noticeState) {
      // Persist before calling a destination that may not support idempotency.
      if (!isCurrent()) return;
      transition(row, {}, { noticeState: 'sending' });
      try {
        await notify(`【视频已公开】《${row.metadata.title}》\nhttps://www.bilibili.com/video/${row.bvid}/`);
        noticeState = 'done';
      } catch { noticeState = 'needs_check'; }
      transition(row, {}, { noticeState });
    } else if (noticeState === 'sending') {
      noticeState = 'needs_check';
      transition(row, {}, { noticeState });
    }
  }

  async function exclusive(row, run) {
    let unlock;
    try { unlock = acquirePublicationLock(row.accountMid, 'video-upload'); }
    catch (error) {
      if (error.code === 'VIDEO_PUBLISH_BUSY') return;
      throw error;
    }
    try {
      const current = store.getPublish(row.attemptId);
      if (current?.state !== row.state || current.updatedAt !== row.updatedAt) return;
      await run(current);
    } finally { unlock(); }
  }

  return {
    async tick(signal) {
      if (!isCurrent() || !getConfig().video?.enabled || signal?.aborted) return;
      const obsolete = store.pendingObsoletePublications();
      if (obsolete) await exclusive(obsolete, (row) => {
        clearUploadToken(row.attemptId);
        transition(row, { nextPollAt: null, partAcks: [], remoteSession: null });
      });
      const follow = store.duePublishes(FOLLOW_UP)[0];
      if (follow) await exclusive(follow, (row) => poll(row, signal));
      if (signal?.aborted) return;
      const repoll = store.duePublishedVideos();
      if (repoll) await exclusive(repoll, (row) => poll(row, signal));
      if (signal?.aborted) return;
      const effect = store.dueVideoEffects();
      if (effect) await exclusive(effect, effects);
      if (signal?.aborted) return;
      const next = store.duePublishes(ACTIVE_UPLOAD)[0];
      if (next) await exclusive(next, (row) => upload(row, signal));
    },
  };
}
