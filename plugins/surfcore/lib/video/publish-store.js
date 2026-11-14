// Durable publication queue. Reuses the original stage-two tables and adds metadata tables.
export const PUBLISH_SCHEMA = `
CREATE TABLE IF NOT EXISTS publishes (
  attemptId TEXT PRIMARY KEY,
  accountMid TEXT NOT NULL,
  projectId TEXT NOT NULL,
  revision INTEGER NOT NULL,
  packageHash TEXT NOT NULL,
  approvalRef TEXT,
  remoteSession TEXT,
  partAcks TEXT NOT NULL DEFAULT '[]',
  archiveId TEXT,
  bvid TEXT,
  state TEXT NOT NULL DEFAULT 'local_draft',
  nextPollAt INTEGER,
  errorCode TEXT,
  error TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS video_publish_meta (
  attemptId TEXT PRIMARY KEY, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS video_publish_verified_categories (
  accountMid TEXT NOT NULL, tid INTEGER NOT NULL, PRIMARY KEY(accountMid, tid)
);
CREATE INDEX IF NOT EXISTS idx_video_publish_due ON publishes(state, nextPollAt);
CREATE TABLE IF NOT EXISTS side_effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publishId TEXT NOT NULL,
  eventKind TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  nextAt INTEGER,
  UNIQUE (publishId, eventKind)
);
`;

const now = Date.now;

function parseJson(value, fallback) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

export function createPublishStore(db, withTx, nextId) {
  const publishMeta = db.prepare('SELECT data FROM video_publish_meta WHERE attemptId = ?');
  const putPublishMeta = db.prepare(`INSERT INTO video_publish_meta (attemptId,data) VALUES (?,?)
    ON CONFLICT(attemptId) DO UPDATE SET data=excluded.data`);
  const viewPublish = (row) => row ? {
    ...publishView(row), ...parseJson(publishMeta.get(row.attemptId)?.data, {}),
  } : null;
  const st = {
    insertPublish: db.prepare(
      `INSERT INTO publishes(attemptId, accountMid, projectId, revision, packageHash, approvalRef, remoteSession, partAcks, archiveId, bvid, state, nextPollAt, errorCode, error, createdAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ),
    getPublish: db.prepare('SELECT * FROM publishes WHERE attemptId = ?'),
    listPublishes: db.prepare('SELECT * FROM publishes WHERE projectId = ? AND revision = ? ORDER BY createdAt DESC'),
    updatePublish: db.prepare(
      `UPDATE publishes SET state = ?, approvalRef = ?, remoteSession = ?, partAcks = ?, archiveId = ?, bvid = ?, nextPollAt = ?, errorCode = ?, error = ?, updatedAt = ?
       WHERE attemptId = ?`,
    ),
  };

  function updatePublish(id, patch, expected, meta) {
    const row = st.getPublish.get(id);
    if (!row || (expected && row.state !== expected)) return viewPublish(row);
    const fields = { ...row, ...patch };
    st.updatePublish.run(fields.state, fields.approvalRef ?? null,
      typeof fields.remoteSession === 'string' ? fields.remoteSession : JSON.stringify(fields.remoteSession),
      typeof fields.partAcks === 'string' ? fields.partAcks : JSON.stringify(fields.partAcks),
      fields.archiveId, fields.bvid, fields.nextPollAt, fields.errorCode, fields.error, now(), id);
    if (meta) putPublishMeta.run(id, JSON.stringify({ ...parseJson(publishMeta.get(id)?.data, {}), ...meta }));
    return viewPublish(st.getPublish.get(id));
  }

  return {
    requestPublish({ accountMid, projectId, revision, packageHash, metadata, mp4, state, approvalRef }) {
      return withTx(() => {
        const existing = db.prepare('SELECT * FROM publishes WHERE accountMid = ? AND packageHash = ? LIMIT 1')
          .get(accountMid, packageHash);
        const reusable = existing && ['local_draft', 'superseded'].includes(existing.state);
        if (existing && (!reusable || state === 'local_draft')) return viewPublish(existing);
        // The same render may exist in a cover-only or metadata-only revision.
        const previous = db.prepare(`SELECT p.* FROM publishes p JOIN video_publish_meta m USING(attemptId)
          WHERE p.accountMid = ? AND p.projectId = ? AND p.state IN
            ('submitting','submission_unknown','submitted','processing','reviewing','published')
          AND json_extract(m.data, '$.mp4Hash') = ? LIMIT 1`)
          .get(accountMid, projectId, mp4.sha256);
        if (previous) return viewPublish(previous);
        if (state !== 'local_draft') {
          // A live upload must observe that its exact package is superseded before sending more bytes.
          db.prepare(`UPDATE publishes SET state='superseded', nextPollAt=0, updatedAt=?
            WHERE projectId=? AND accountMid=? AND packageHash!=?
            AND state IN ('awaiting_approval','authorized','uploading','uploaded','blocked')`)
            .run(now(), projectId, accountMid, packageHash);
        }
        if (existing) return updatePublish(existing.attemptId, {
          state, approvalRef, nextPollAt: 0, error: null, errorCode: null,
        }, existing.state, { hint: null, uploadAttempts: 0 });
        const id = nextId();
        const t = now();
        st.insertPublish.run(id, accountMid, projectId, revision, packageHash, approvalRef, null, '[]', null, null,
          state, 0, null, null, t, t);
        putPublishMeta.run(id, JSON.stringify({ metadata, mp4Hash: mp4.sha256, sizeBytes: mp4.size }));
        return viewPublish(st.getPublish.get(id));
      });
    },

    getPublish(attemptId) {
      return viewPublish(st.getPublish.get(attemptId));
    },

    listPublishes(projectId, revision) {
      const rows = revision == null
        ? db.prepare('SELECT * FROM publishes WHERE projectId = ? ORDER BY updatedAt DESC').all(projectId)
        : st.listPublishes.all(projectId, Number(revision));
      return rows.map(viewPublish);
    },

    duePublishes(states) {
      const placeholders = states.map(() => '?').join(',');
      return db.prepare(`SELECT * FROM publishes WHERE state IN (${placeholders})
        AND nextPollAt <= ? ORDER BY nextPollAt, createdAt LIMIT 8`).all(...states, now()).map(viewPublish);
    },

    updatePublish(attemptId, patch, { expected, meta } = {}) {
      return withTx(() => updatePublish(attemptId, patch, expected, meta));
    },

    pendingObsoletePublications() {
      return viewPublish(db.prepare("SELECT * FROM publishes WHERE state = 'superseded' AND nextPollAt <= ? ORDER BY updatedAt LIMIT 1").get(now()));
    },

    duePublishedVideos() {
      return viewPublish(db.prepare("SELECT * FROM publishes WHERE state = 'published' AND nextPollAt <= ? ORDER BY nextPollAt LIMIT 1").get(now()));
    },

    dueVideoEffects() {
      return viewPublish(db.prepare(`SELECT p.* FROM publishes p JOIN video_publish_meta m USING(attemptId)
        WHERE p.state = 'published' AND (
          (COALESCE(json_extract(m.data,'$.memoryState'),'') != 'done'
           AND COALESCE(json_extract(m.data,'$.nextEffectAt'),0) <= ?)
          OR COALESCE(json_extract(m.data,'$.noticeState'),'') IN ('','sending')
        ) ORDER BY p.createdAt LIMIT 1`).get(now()));
    },

    hasVerifiedVideoCategory(accountMid, tid) {
      return Boolean(db.prepare('SELECT 1 FROM video_publish_verified_categories WHERE accountMid = ? AND tid = ?').get(accountMid, tid));
    },

    verifyVideoCategory(accountMid, tid, verified = true) {
      if (verified) db.prepare('INSERT OR IGNORE INTO video_publish_verified_categories (accountMid,tid) VALUES (?,?)').run(accountMid, tid);
      else db.prepare('DELETE FROM video_publish_verified_categories WHERE accountMid = ? AND tid = ?').run(accountMid, tid);
    },
  };
}

function publishView(row) {
  return {
    attemptId: row.attemptId,
    accountMid: row.accountMid,
    projectId: row.projectId,
    revision: Number(row.revision),
    packageHash: row.packageHash,
    approvalRef: row.approvalRef,
    remoteSession: parseJson(row.remoteSession, null),
    partAcks: parseJson(row.partAcks, []),
    archiveId: row.archiveId,
    bvid: row.bvid,
    state: row.state,
    nextPollAt: row.nextPollAt == null ? null : Number(row.nextPollAt),
    errorCode: row.errorCode,
    error: row.error,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}
