/**
 * 视频项目的 SQLite 持久化与任务队列（阶段一）。
 *
 * 设计要点（对应方案 §3）：
 *   · 每个角色的 `projects.sqlite` 只属于那个角色；数据库文件放在
 *     <DSH_HOME>/surfcore/characters/<id>/bili/video/ 下，换角色=换库。
 *   · 编辑状态与任务状态分开建模：项目/版本走 CAS（预期版本号），
 *     任务走租约 + fencing token，旧 worker 的提交会被拒绝。
 *   · 同一版本同时最多一个同类活跃任务；重复提交返回同一任务（幂等）。
 *   · node:sqlite 不可用（老运行时）时返回能力错误，宿主继续运行，
 *     视频模块只显示原因（方案 §3 的探测约定）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPublishStore, PUBLISH_SCHEMA } from './publish-store.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const GENERATOR_VERSION = 'video-2.0.0';
export const STORE_SCHEMA_VERSION = 1;

export const EDIT_STATES = ['idea', 'editing', 'preview', 'ready', 'shelved'];
export const TASK_STATES = ['queued', 'running', 'succeeded', 'retryable', 'blocked', 'cancelled'];
export const PUBLISH_STATES = [
  'local_draft', 'awaiting_approval', 'authorized', 'uploading', 'uploaded',
  'submitting', 'submitted', 'processing', 'reviewing', 'published',
  'submission_unknown', 'rejected', 'blocked', 'withdrawn', 'superseded',
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  characterId TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  editState TEXT NOT NULL DEFAULT 'idea',
  title TEXT NOT NULL DEFAULT '',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  projectId TEXT NOT NULL,
  revision INTEGER NOT NULL,
  plan TEXT NOT NULL,
  planHash TEXT NOT NULL,
  manifest TEXT NOT NULL DEFAULT '{}',
  reviewDecision TEXT,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (projectId, revision)
);
CREATE TABLE IF NOT EXISTS video_review_notes (
  projectId TEXT NOT NULL,
  revision INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (projectId, revision),
  FOREIGN KEY (projectId, revision) REFERENCES revisions(projectId, revision)
);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projectId TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  relativePath TEXT NOT NULL,
  durationMs INTEGER,
  sizeBytes INTEGER NOT NULL DEFAULT 0,
  generatorVersion TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  createdAt INTEGER NOT NULL,
  UNIQUE (projectId, revision, kind)
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  importer TEXT NOT NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  relativePath TEXT NOT NULL,
  authorization TEXT NOT NULL DEFAULT '{}',
  revocable INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jobId TEXT NOT NULL UNIQUE,
  projectId TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  nextAt INTEGER NOT NULL,
  leaseOwner TEXT,
  leaseUntil INTEGER,
  fence INTEGER NOT NULL DEFAULT 0,
  errorCode TEXT,
  error TEXT,
  hint TEXT,
  progress TEXT NOT NULL DEFAULT '{}',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state, nextAt);

`;

/** 探测 node:sqlite 是否可用（老运行时没有这个模块时给出可读原因）。 */
export function probeSqlite() {
  try {
    // eslint-disable-next-line global-require
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('select 1');
    db.close();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `当前 Node 运行时没有可用的 node:sqlite（需要 Node ≥22.5）：${String(error?.message ?? error)}`,
    };
  }
}

export function sha256Of(bufferOrText) {
  const input = Buffer.isBuffer(bufferOrText) ? bufferOrText : Buffer.from(String(bufferOrText), 'utf8');
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function now() {
  return Date.now();
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function fail(code, message, hint = '') {
  const error = new Error(message);
  error.code = code;
  if (hint) error.hint = hint;
  return error;
}

/** 把任务行转成对外形状（不泄露租约/fence 内部字段）。 */
function taskView(row) {
  if (!row) return null;
  return {
    jobId: row.jobId,
    projectId: row.projectId,
    revision: Number(row.revision),
    kind: row.kind,
    stage: row.stage,
    state: row.state,
    attempts: Number(row.attempts),
    nextAt: Number(row.nextAt),
    errorCode: row.errorCode ?? null,
    error: row.error ?? null,
    hint: row.hint ?? null,
    progress: parseJson(row.progress, {}),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

/**
 * 打开某个角色视频根目录的存储。
 * @param {string} root  视频根目录（videoRootFor(characterId)）
 */
export function openVideoStore(root) {
  const probe = probeSqlite();
  if (!probe.ok) {
    const error = new Error(probe.error);
    error.code = 'VIDEO_SQLITE_UNAVAILABLE';
    throw error;
  }
  fs.mkdirSync(root, { recursive: true });
  const dbFile = path.join(root, 'projects.sqlite');
  // eslint-disable-next-line global-require
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec(SCHEMA + PUBLISH_SCHEMA);
  db.prepare(
    'INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schemaVersion', String(STORE_SCHEMA_VERSION));

  const reviewNote = db.prepare('SELECT reason FROM video_review_notes WHERE projectId = ? AND revision = ?');
  const saveReviewNote = db.prepare(`INSERT INTO video_review_notes (projectId, revision, reason) VALUES (?, ?, ?)
    ON CONFLICT (projectId, revision) DO UPDATE SET reason = excluded.reason`);
  const updateAssetGrant = db.prepare('UPDATE assets SET name = ?, ext = ?, bytes = ?, relativePath = ?, authorization = ? WHERE id = ?');
  const st = {
    insertProject: db.prepare(
      'INSERT INTO projects(id, characterId, revision, editState, title, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)',
    ),
    getProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
    updateProjectCas: db.prepare(
      'UPDATE projects SET revision = ?, editState = ?, title = ?, updatedAt = ? WHERE id = ? AND revision = ?',
    ),
    touchProject: db.prepare('UPDATE projects SET updatedAt = ? WHERE id = ?'),
    setProjectState: db.prepare('UPDATE projects SET editState = ?, updatedAt = ? WHERE id = ?'),
    listProjects: db.prepare(
      'SELECT * FROM projects ORDER BY updatedAt DESC LIMIT ? OFFSET ?',
    ),
    countProjects: db.prepare('SELECT COUNT(*) AS n FROM projects'),
    insertRevision: db.prepare(
      'INSERT INTO revisions(projectId, revision, plan, planHash, manifest, reviewDecision, createdAt) VALUES (?,?,?,?,?,?,?)',
    ),
    getRevision: db.prepare('SELECT * FROM revisions WHERE projectId = ? AND revision = ?'),
    listRevisions: db.prepare('SELECT * FROM revisions WHERE projectId = ? ORDER BY revision DESC'),
    setReview: db.prepare(
      'UPDATE revisions SET reviewDecision = ? WHERE projectId = ? AND revision = ?',
    ),
    upsertArtifact: db.prepare(
      `INSERT INTO artifacts(projectId, revision, kind, sha256, relativePath, durationMs, sizeBytes, generatorVersion, meta, createdAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(projectId, revision, kind) DO UPDATE SET
         sha256 = excluded.sha256, relativePath = excluded.relativePath,
         durationMs = excluded.durationMs, sizeBytes = excluded.sizeBytes,
         generatorVersion = excluded.generatorVersion, meta = excluded.meta, createdAt = excluded.createdAt`,
    ),
    listArtifacts: db.prepare('SELECT * FROM artifacts WHERE projectId = ? AND revision = ? ORDER BY kind'),
    getArtifact: db.prepare('SELECT * FROM artifacts WHERE projectId = ? AND revision = ? AND kind = ?'),
    insertTask: db.prepare(
      `INSERT INTO tasks(jobId, projectId, revision, kind, stage, state, attempts, nextAt, leaseOwner, leaseUntil, fence, errorCode, error, hint, progress, createdAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ),
    findActiveTask: db.prepare(
      `SELECT * FROM tasks WHERE projectId = ? AND revision = ? AND kind = ? AND state IN ('queued','running','retryable') LIMIT 1`,
    ),
    getTask: db.prepare('SELECT * FROM tasks WHERE jobId = ?'),
    getTaskForProject: db.prepare('SELECT * FROM tasks WHERE projectId = ? AND revision = ? ORDER BY updatedAt DESC'),
    claimTask: db.prepare(
      `UPDATE tasks SET state = 'running', leaseOwner = ?, leaseUntil = ?, attempts = attempts + 1, fence = fence + 1, updatedAt = ?
       WHERE id = ? AND state IN ('queued','retryable') AND nextAt <= ? AND fence = ?`,
    ),
    findClaimable: db.prepare(
      `SELECT * FROM tasks WHERE state IN ('queued','retryable') AND nextAt <= ? ORDER BY nextAt ASC LIMIT 8`,
    ),
    countLeased: db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE state = \'running\' AND leaseOwner = ? AND leaseUntil > ?'),
    heartbeatTask: db.prepare("UPDATE tasks SET leaseUntil = ?, updatedAt = ? WHERE jobId = ? AND fence = ? AND state = 'running'"),
    completeTask: db.prepare(
      `UPDATE tasks SET state = 'succeeded', stage = 'done', errorCode = NULL, error = NULL, hint = NULL, updatedAt = ?
       WHERE jobId = ? AND fence = ? AND state = 'running'`,
    ),
    failTask: db.prepare(
      `UPDATE tasks SET state = ?, stage = ?, errorCode = ?, error = ?, hint = ?, nextAt = ?, updatedAt = ?
       WHERE jobId = ? AND fence = ? AND state = 'running'`,
    ),
    cancelTasks: db.prepare(
      `UPDATE tasks SET state = 'cancelled', updatedAt = ? WHERE projectId = ? AND revision = ? AND state IN ('queued','retryable','running')`,
    ),
    recoverStale: db.prepare(
      `SELECT * FROM tasks WHERE state = 'running' OR (state = 'queued' AND leaseUntil IS NOT NULL AND leaseUntil < ?) ORDER BY updatedAt ASC`,
    ),
    recoverSet: db.prepare(
      `UPDATE tasks SET state = 'retryable', fence = fence + 1, attempts = attempts + 1, nextAt = ?, leaseOwner = NULL, leaseUntil = NULL, updatedAt = ?
       WHERE id = ?`,
    ),
    insertAsset: db.prepare(
      'INSERT INTO assets(id, sha256, kind, source, importer, name, ext, bytes, relativePath, authorization, revocable, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ),
    getAssetById: db.prepare('SELECT * FROM assets WHERE id = ?'),
    getAssetBySha: db.prepare('SELECT * FROM assets WHERE sha256 = ?'),
    listAssets: db.prepare('SELECT * FROM assets ORDER BY createdAt DESC LIMIT ? OFFSET ?'),
    deleteAsset: db.prepare('DELETE FROM assets WHERE id = ?'),

  };

  function withTx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const publication = createPublishStore(db, withTx, () => newId('pub'));

  function taskToView(row) {
    return taskView(row);
  }

  return {
    db,
    dbFile,
    root,
    close() {
      try {
        db.close();
      } catch {}
    },

    // ── 项目 ──────────────────────────────────────────────
    createProject({ characterId, title = '', maxProjects = Infinity }) {
      return withTx(() => {
        const activeCount = db.prepare("SELECT COUNT(*) AS n FROM projects WHERE editState != 'shelved'").get().n;
        if (activeCount >= maxProjects) {
          throw fail('VIDEO_PROJECT_LIMIT', `已有 ${activeCount} 个活动项目`, '搁置暂时不做的项目或提高活动项目上限');
        }
        const id = newId('p');
        const t = now();
        st.insertProject.run(id, String(characterId), 0, 'idea', String(title).slice(0, 120), t, t);
        return { id, revision: 0, editState: 'idea', title: String(title).slice(0, 120) };
      });
    },

    getProject(id) {
      const row = st.getProject.get(id);
      if (!row) return null;
      const revisions = st.listRevisions.all(id).map((r) => ({
        revision: Number(r.revision),
        planHash: r.planHash,
        reviewDecision: r.reviewDecision,
        reviewReason: reviewNote.get(id, r.revision)?.reason ?? '',
        createdAt: Number(r.createdAt),
        artifacts: st.listArtifacts.all(id, r.revision).map(artifactView),
      }));
      const tasks = st.getTaskForProject.all(id, Number(row.revision)).map(taskToView);
      return {
        id: row.id,
        characterId: row.characterId,
        revision: Number(row.revision),
        editState: row.editState,
        title: row.title,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
        revisions,
        tasks,
      };
    },

    listProjects({ limit = 50, offset = 0 } = {}) {
      const total = Number(st.countProjects.get().n);
      const items = st.listProjects.all(limit, offset).map((row) => {
        const tasks = st.getTaskForProject.all(row.id, Number(row.revision)).map(taskToView);
        return {
          id: row.id,
          characterId: row.characterId,
          revision: Number(row.revision),
          editState: row.editState,
          title: row.title,
          createdAt: Number(row.createdAt),
          updatedAt: Number(row.updatedAt),
          tasks,
        };
      });
      return { items, total, limit, offset };
    },

    setProjectState(id, editState) {
      if (!EDIT_STATES.includes(editState)) throw fail('VIDEO_BAD_STATE', `未知编辑状态：${editState}`);
      st.setProjectState.run(editState, now(), id);
      return { ok: true, id, editState };
    },

    /** 保存新版本计划（CAS：预期版本必须等于当前版本）。返回新版本号。 */
    savePlan(id, plan, { expectRevision } = {}) {
      if (typeof plan !== 'object' || plan === null) throw fail('VIDEO_BAD_PLAN', '计划必须是对象');
      const planText = JSON.stringify(plan);
      const planHash = sha256Of(planText);
      const expected = Number(expectRevision);
      if (!Number.isInteger(expected) || expected < 0) {
        throw fail('VIDEO_BAD_REVISION', 'expect-revision 必须是非负整数');
      }
      return withTx(() => {
        const project = st.getProject.get(id);
        if (!project) throw fail('VIDEO_PROJECT_NOT_FOUND', `项目不存在：${id}`);
        if (Number(project.revision) !== expected) {
          const error = fail(
            'VIDEO_REVISION_CONFLICT',
            `版本冲突：项目当前在版本 ${project.revision}，你基于 ${expected} 修改`,
            '用 video-project status 看最新版本，重新修改后再保存',
          );
          throw error;
        }
        const next = expected + 1;
        st.insertRevision.run(id, next, planText, planHash, '{}', null, now());
        st.updateProjectCas.run(next, 'editing', String(plan.title || project.title).slice(0, 120), now(), id, expected);
        return { ok: true, id, revision: next, planHash };
      });
    },

    getPlan(id, revision) {
      const row = st.getRevision.get(id, Number(revision));
      if (!row) return null;
      return { plan: JSON.parse(row.plan), planHash: row.planHash, reviewDecision: row.reviewDecision };
    },

    setReviewDecision(id, revision, decision, reason = '') {
      const state = { keep: 'ready', revise: 'editing', shelve: 'shelved' };
      if (!['keep', 'revise', 'shelve'].includes(decision)) {
        throw fail('VIDEO_BAD_REVIEW', '审片请选择 keep/revise/shelve');
      }
      const rev = Number(revision);
      return withTx(() => {
        const project = st.getProject.get(id);
        if (!project || project.revision !== rev) {
          throw fail('VIDEO_REVISION_CONFLICT', '只能审片当前版本', '刷新项目后再审片');
        }
        const rendered = rev > 0 && st.getArtifact.get(id, rev, 'preview');
        if (decision !== 'shelve' && (!rendered || st.findActiveTask.get(id, rev, 'render'))) {
          throw fail('VIDEO_REVIEW_NOT_READY', '当前版本还没有可审的稳定预览', '等渲染完成后打开预览');
        }
        if (rev > 0) {
          st.setReview.run(decision, id, rev);
          saveReviewNote.run(id, rev, String(reason ?? '').trim().slice(0, 600));
        }
        const cancelled = decision === 'shelve' ? st.cancelTasks.run(now(), id, rev).changes : 0;
        st.setProjectState.run(state[decision], now(), id);
        return { ok: true, id, revision: rev, reviewDecision: decision, editState: state[decision], cancelled };
      });
    },

    markPreview(id, revision) {
      db.prepare(`UPDATE projects SET editState = 'preview', updatedAt = ?
        WHERE id = ? AND revision = ? AND editState IN ('idea', 'editing') AND NOT EXISTS (
          SELECT 1 FROM revisions WHERE projectId = ? AND revision = ? AND reviewDecision IS NOT NULL
        )`).run(now(), id, revision, id, revision);
    },

    // ── 工件 ──────────────────────────────────────────────
    recordArtifact(id, revision, artifact) {
      const kind = String(artifact.kind ?? '');
      if (!kind) throw fail('VIDEO_BAD_ARTIFACT', '工件缺少 kind');
      st.upsertArtifact.run(
        id,
        Number(revision),
        kind,
        String(artifact.sha256 ?? ''),
        String(artifact.relativePath ?? ''),
        artifact.durationMs == null ? null : Number(artifact.durationMs),
        Number(artifact.sizeBytes ?? 0),
        String(artifact.generatorVersion ?? GENERATOR_VERSION),
        JSON.stringify(artifact.meta ?? {}),
        now(),
      );
      return { ok: true, kind };
    },

    recordArtifacts(id, revision, artifacts) {
      return withTx(() => {
        for (const artifact of artifacts) this.recordArtifact(id, revision, artifact);
      });
    },

    listArtifacts(id, revision) {
      return st.listArtifacts.all(id, Number(revision)).map(artifactView);
    },

    getArtifact(id, revision, kind) {
      const row = st.getArtifact.get(id, Number(revision), kind);
      return row ? artifactView(row) : null;
    },

    // ── 任务队列 ──────────────────────────────────────────
    enqueueTask({ projectId, revision, kind }) {
      return withTx(() => {
        const project = st.getProject.get(projectId);
        if (!project) throw fail('VIDEO_PROJECT_NOT_FOUND', `项目不存在：${projectId}`);
        const rev = Number(revision);
        if (rev <= 0 || rev > Number(project.revision)) {
          throw fail('VIDEO_BAD_REVISION', `版本 ${rev} 不存在（项目当前 ${project.revision}）`);
        }
        // 幂等：同一版本同类活跃任务直接返回同一个 jobId（重复点击只产生一个任务）。
        const existing = st.findActiveTask.get(projectId, rev, kind);
        if (existing) return { ok: true, jobId: existing.jobId, task: taskToView(existing), duplicate: true };
        const jobId = newId(`j_${kind}`);
        const t = now();
        st.insertTask.run(jobId, projectId, rev, kind, 'queued', 'queued', 0, t, null, null, 0, null, null, null, '{}', t, t);
        const row = st.getTask.get(jobId);
        return { ok: true, jobId, task: taskToView(row), duplicate: false };
      });
    },

    getTask(jobId) {
      return taskToView(st.getTask.get(jobId));
    },

    /** worker 内部用：读原始行（含 fence / leaseUntil）。 */
    getTaskRow(jobId) {
      return st.getTask.get(jobId);
    },

    isTaskRunning(jobId) {
      const row = st.getTask.get(jobId);
      return Boolean(row && row.state === 'running');
    },

    /** 领一个到期任务（事务 + fence 递增）；返回 { task, fence } 或 null。 */
    claimNextTask({ owner, leaseMs = 10 * 60 * 1000, maxConcurrent = 1 }) {
      return withTx(() => {
        const t = now();
        const leased = Number(st.countLeased.get(owner, t).n);
        if (leased >= maxConcurrent) return null;
        for (const row of st.findClaimable.all(t)) {
          const claimed = st.claimTask.run(owner, t + leaseMs, t, row.id, t, Number(row.fence));
          if (claimed.changes === 0) continue; // 被别的 worker 抢了
          const fresh = st.getTask.get(row.jobId);
          return { task: taskToView(fresh), fence: Number(fresh.fence) };
        }
        return null;
      });
    },

    heartbeatTask(jobId, fence, leaseMs = 10 * 60 * 1000) {
      const r = st.heartbeatTask.run(now() + leaseMs, now(), jobId, Number(fence));
      return r.changes > 0;
    },

    completeTask(jobId, fence) {
      const r = st.completeTask.run(now(), jobId, Number(fence));
      return r.changes > 0;
    },

    failTask(jobId, fence, { code = 'VIDEO_TASK_FAILED', error = '', hint = '', retryable = false, stage = '' }) {
      const attempts = taskView(st.getTask.get(jobId))?.attempts ?? 0;
      const backoff = Math.min(30 * 60 * 1000, 10_000 * (2 ** Math.min(attempts, 7)));
      const r = st.failTask.run(
        retryable ? 'retryable' : 'blocked',
        stage || '',
        code,
        String(error).slice(0, 1000),
        String(hint || '').slice(0, 500),
        retryable ? now() + backoff : now(),
        now(),
        jobId,
        Number(fence),
      );
      return r.changes > 0;
    },

    setTaskProgress(jobId, progress) {
      const row = st.getTask.get(jobId);
      if (!row) return;
      db.prepare("UPDATE tasks SET progress = ?, updatedAt = ? WHERE jobId = ? AND state = 'running'")
        .run(JSON.stringify(progress ?? {}), now(), jobId);
    },

    cancelProjectTasks(projectId, revision) {
      const r = st.cancelTasks.run(now(), projectId, Number(revision));
      return { ok: true, cancelled: r.changes };
    },

    /** 重试：把该版本终态任务放回队列；没有可重试的就重新入队（幂等）。 */
    retryTasks(projectId, revision, kind = 'render') {
      return withTx(() => {
        const project = st.getProject.get(projectId);
        if (!project) throw fail('VIDEO_PROJECT_NOT_FOUND', `项目不存在：${projectId}`);
        const rev = Number(revision);
        if (rev <= 0 || rev > Number(project.revision)) {
          throw fail('VIDEO_BAD_REVISION', `版本 ${rev} 不存在（项目当前 ${project.revision}）`);
        }
        const active = st.findActiveTask.get(projectId, rev, kind);
        if (active) return { ok: true, jobId: active.jobId, retried: 0, duplicate: true, task: taskToView(active) };
        const retried = db.prepare(
          `UPDATE tasks SET state = 'queued', nextAt = ?, errorCode = NULL, error = NULL, hint = NULL, updatedAt = ?
           WHERE id = (SELECT id FROM tasks WHERE projectId = ? AND revision = ? AND kind = ?
             AND state IN ('blocked','cancelled') ORDER BY updatedAt DESC, id DESC LIMIT 1)`,
        ).run(now(), now(), projectId, rev, kind);
        if (retried.changes > 0) {
          const row = st.findActiveTask.get(projectId, rev, kind);
          return { ok: true, jobId: row?.jobId ?? null, retried: retried.changes, task: taskToView(row) };
        }
        const jobId = newId(`j_${kind}`);
        const t = now();
        st.insertTask.run(jobId, projectId, rev, kind, 'queued', 'queued', 0, t, null, null, 0, null, null, null, '{}', t, t);
        return { ok: true, jobId, retried: 0, task: taskToView(st.getTask.get(jobId)), duplicate: false };
      });
    },

    /**
     * 启动恢复：所有 running 任务视为被上一个进程打断（单机语义，全机并发=1），
     * 立即转 retryable 供本进程接管；孤儿 queued 保持排队。
     */
    recoverOnStart() {
      const t = now();
      const rows = st.recoverStale.all(t);
      let recovered = 0;
      for (const row of rows) {
        if (row.state === 'running') {
          st.recoverSet.run(t + 1000, t, row.id);
          recovered += 1;
        }
      }
      return { recovered };
    },

    // ── 素材 ──────────────────────────────────────────────
    registerAsset({ id = null, sha256, kind, source, importer, name, ext, bytes, relativePath, authorization = {}, revocable = true }) {
      const assetId = id || newId('a');
      st.insertAsset.run(
        assetId, sha256, kind, source, String(importer || 'unknown'), String(name || '').slice(0, 200),
        String(ext || '').slice(0, 16), Number(bytes), relativePath, JSON.stringify(authorization ?? {}),
        revocable ? 1 : 0, now(),
      );
      return assetView(st.getAssetById.get(assetId));
    },

    registerAuthorizedAsset(record) {
      return withTx(() => {
        const existing = st.getAssetBySha.get(record.sha256);
        if (existing && existing.kind !== record.kind) throw fail('VIDEO_ASSET_KIND_CONFLICT', '同一文件已登记为另一类型');
        if (!existing) return { asset: this.registerAsset(record), duplicate: false };
        updateAssetGrant.run(record.name, record.ext, record.bytes, record.relativePath, JSON.stringify(record.authorization), existing.id);
        return { asset: this.getAsset(existing.id), duplicate: true };
      });
    },

    revokeAsset(id) {
      return withTx(() => {
        const asset = this.getAsset(id);
        if (!asset) throw fail('VIDEO_ASSET_NOT_FOUND', '素材不存在', '刷新素材库');
        if (!asset.revocable) throw fail('VIDEO_ASSET_LOCKED', '该素材不可撤销');
        const grant = { ...asset.authorization, revokedAt: asset.authorization.revokedAt ?? now() };
        updateAssetGrant.run(asset.name, asset.ext, asset.bytes, asset.relativePath, JSON.stringify(grant), id);
        return { ok: true, asset: this.getAsset(id) };
      });
    },

    getAsset(id) {
      const row = st.getAssetById.get(id);
      return row ? assetView(row) : null;
    },

    getAssetBySha(sha256) {
      const row = st.getAssetBySha.get(sha256);
      return row ? assetView(row) : null;
    },

    listAssets({ limit = 100, offset = 0 } = {}) {
      return st.listAssets.all(limit, offset).map(assetView);
    },

    removeAsset(id) {
      const row = st.getAssetById.get(id);
      if (!row) return { ok: false, code: 'VIDEO_ASSET_NOT_FOUND' };
      if (!row.revocable) throw fail('VIDEO_ASSET_LOCKED', '该素材不可撤销（已被版本引用或来源不可撤销）');
      st.deleteAsset.run(id);
      return { ok: true };
    },

    ...publication,
  };
}

function artifactView(row) {
  return {
    kind: row.kind,
    sha256: row.sha256,
    relativePath: row.relativePath,
    durationMs: row.durationMs == null ? null : Number(row.durationMs),
    sizeBytes: Number(row.sizeBytes),
    generatorVersion: row.generatorVersion,
    meta: parseJson(row.meta, {}),
    createdAt: Number(row.createdAt),
  };
}

function assetView(row) {
  return {
    id: row.id,
    sha256: row.sha256,
    kind: row.kind,
    source: row.source,
    importer: row.importer,
    name: row.name,
    ext: row.ext,
    bytes: Number(row.bytes),
    relativePath: row.relativePath,
    authorization: parseJson(row.authorization, {}),
    revocable: Boolean(row.revocable),
    createdAt: Number(row.createdAt),
  };
}
