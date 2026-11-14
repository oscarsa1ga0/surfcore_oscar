import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { Readable } from 'node:stream';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-video-publish-'));
process.env.DSH_HOME = home;
const { openVideoStore, sha256Of } = await import('../plugins/surfcore/lib/video/project-store.js');
const { ensureVideoDirs, requireVideoRoot, revisionDirFor } = await import('../plugins/surfcore/lib/video/paths.js');
const { approvePublication, refreshPublication, requestPublication, safePublish } = await import('../plugins/surfcore/lib/video/publish-state.js');
const { createBiliVideoAdapter, publishError } = await import('../plugins/surfcore/lib/video/bili-video-adapter.js');
const { createVideoPublisher } = await import('../plugins/surfcore/lib/video/publish-worker.js');
const { createVideoApi } = await import('../plugins/surfcore/lib/video/publish-web.js');
const { acquirePublicationLock, reservePublicationSlot } = await import('../plugins/surfcore/tools/lib/publication-slot.mjs');

const account = '518000111';
const other = '518000222';
const bvid = 'BV1Ab0000042';
const login = { mid: account, sessdata: 'fixture-session', bili_jct: 'fixture-csrf', buvid3: 'fixture-buvid' };
const active = { id: 'video-fixture', name: 'fixture', epoch: 7 };
const surfcore = path.join(home, 'surfcore');
const chars = path.join(surfcore, 'characters');
const roleDir = path.join(chars, active.id);
fs.mkdirSync(roleDir, { recursive: true });
fs.writeFileSync(path.join(roleDir, 'character.json'), '{}');
fs.writeFileSync(path.join(chars, 'current.json'), JSON.stringify(active));
const { root } = requireVideoRoot();
ensureVideoDirs(root);

function setup() {
  const store = openVideoStore(root);
  const cfg = { self: { mid: account }, owner: { mid: other },
    dynamics: { gapMin: 0 }, interact: { enabled: true },
    video: { enabled: true, publishMode: 'confirm', publishTid: 21 } };
  const assetFile = path.join(root, 'assets', 'fixture.png');
  fs.writeFileSync(assetFile, 'fixture generated image');
  const asset = store.getAssetBySha('generated-card') ?? store.registerAsset({ sha256: 'generated-card', kind: 'card', source: 'generated',
    name: 'fixture.png', ext: '.png', bytes: 21, relativePath: 'fixture.png' });

  function project(title) {
    const id = store.createProject({ characterId: active.id, title }).id;
    const plan = { title, submission: { description: '鱼姬剪辑的试片。', tags: ['剪辑'] },
      scenes: [{ id: 's1', visual: { assetId: asset.id }, duration: { mode: 'fixed', ms: 15_000 } }] };
    function revision(expected) {
      const { revision } = store.savePlan(id, plan, { expectRevision: expected });
      const dir = revisionDirFor(root, id, revision);
      fs.mkdirSync(dir, { recursive: true });
      for (const [kind, fileName, bytes] of [['mp4', 'final.mp4', Buffer.alloc(220_000, title.length)],
        ['cover', 'cover.png', Buffer.from('mock cover bytes')]]) {
        fs.writeFileSync(path.join(dir, fileName), bytes);
        store.recordArtifact(id, revision, { kind, sha256: sha256Of(bytes), sizeBytes: bytes.length, relativePath: fileName });
      }
      store.recordArtifact(id, revision, { kind: 'qa', meta: { pass: true } });
      store.recordArtifact(id, revision, { kind: 'preview' });
      store.setReviewDecision(id, revision, 'keep');
      return { store, root, projectId: id, revision, cfg, login };
    }
    return { id, ctx: revision(0), revision };
  }

  function expire(row) {
    store.updatePublish(row.attemptId, { nextPollAt: 0 });
  }

  return { cfg, store, project, expire };
}

test('CLI and management API enforce draft, approval and version/role binding', async () => {
  const { cfg, store, project } = setup();
  try {
    const { ctx, revision, id } = project('草稿和审批');
    cfg.video.publishMode = 'draft';
    fs.writeFileSync(path.join(surfcore, 'bili.config.json'), JSON.stringify(cfg));
    const cli = (args) => spawnSync(process.execPath, ['plugins/surfcore/tools/bili.mjs', 'video-upload', ...args, '--json'],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    const command = cli([id, '--revision', '1', '--dry']);
    assert.equal(command.status, 0, command.stderr);
    assert.equal(JSON.parse(command.stdout).mode, 'draft');
    assert.equal(store.listPublishes(id).length, 0);
    const draft = await requestPublication(ctx, 'go');
    assert.equal(draft.publish.state, 'local_draft');
    cfg.video.publishMode = 'confirm';
    const created = await requestPublication(ctx, 'go');
    assert.equal(created.publish.attemptId, draft.publish.attemptId);
    assert.equal(created.publish.state, 'awaiting_approval');
    const api = createVideoApi({ storeFactory: () => ({ store, root, character: active }), getPublishConfig: () => cfg });
    const post = async (body) => {
      const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' });
      const res = { setHeader() {}, end(data) { this.json = JSON.parse(data); } };
      const url = new URL(`http://localhost/dsh-surfcore/api/bili/video/projects/${id}/approve`);
      await api.handle(req, res, url);
      return res;
    };
    const body = { revision: 1, attemptId: created.publish.attemptId, packageHash: created.packageHash,
      characterId: active.id, characterEpoch: active.epoch };
    const stale = await post({ ...body, characterEpoch: 6 });
    assert.equal(stale.json.code, 'VIDEO_CHARACTER_CHANGED');
    assert.ok(stale.json.hint);
    const approved = await post(body);
    assert.equal(approved.json.publish?.state, 'authorized');
    assert.equal((await requestPublication(ctx, 'go')).publish.attemptId, body.attemptId);
    assert.equal('remoteSession' in approved.json.publish, false);
    revision(1);
    const wrong = await post(body);
    assert.equal(wrong.json.code, 'VIDEO_BAD_REVISION');
    const first = store.getPublish(body.attemptId);
    store.updatePublish(first.attemptId, { state: 'superseded', nextPollAt: null });
  } finally { store.close(); }
});

test('UPOS part resumes after restart, lost final response only reconciles, then records once', async () => {
  const { cfg, store, project, expire } = setup();
  const { ctx } = project('续传及恢复');
  let state;
  let submitted = 0;
  const parts = [];
  const routes = [];
  let losePart = true;
  let matchOnServer = false;
  let publiclyVisible = false;
  let declaration = false;
  let notices = 0;
  const json = (data) => Response.json(data);
  const memberOK = (data) => json({ code: 0, data });
  const archive = () => ({ aid: 70001, bvid, state: -1, tid: 21, copyright: 1,
    title: '续传及恢复', ...(declaration ? { creation_statement: { id: 1 } } : {}) });
  const videos = [{ cid: 60001, filename: 'fixture-upload' }];

  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    routes.push(u.pathname);
    if (u.hostname.endsWith('.bilivideo.com')) {
      assert.equal(init.headers.cookie, undefined);
      assert.equal(init.redirect, 'error');
    }
    if (u.pathname.endsWith('/nav')) return memberOK({ isLogin: true, mid: Number(account) });
    if (u.pathname.endsWith('/type2/list')) return memberOK({ type_list: [{ id: 21 }] });
    if (u.pathname === '/preupload') return json({
      OK: 1, auth: 'upload-secret', endpoint: '//upos-sz-upcdnbda2.bilivideo.com',
      upos_uri: 'upos://bucket/fixture-upload.mp4', biz_id: 60001, chunk_size: 65536,
    });
    if (u.searchParams.has('uploads')) return json({ OK: 1, upload_id: 'fixture-upload-id' });
    if (init.method === 'PUT') {
      const index = Number(u.searchParams.get('partNumber'));
      parts.push(index);
      if (index === 2 && losePart) { losePart = false; throw new Error('lost network'); }
      return new Response(null, { headers: { etag: `"etag${index}"` } });
    }
    if (u.searchParams.has('uploadId')) {
      assert.deepEqual(JSON.parse(init.body).parts.map((part) => part.partNumber), [1, 2, 3, 4]);
      return json({ OK: 1 });
    }
    if (u.pathname.endsWith('/cover/up')) return memberOK({ url: 'https://i0.hdslb.com/bfs/archive/cover.png' });
    if (u.pathname.endsWith('/add/v3')) {
      submitted++;
      const posted = JSON.parse(init.body);
      assert.deepEqual(posted.creation_statement, { id: 1 });
      assert.equal(posted.videos[0].filename, 'fixture-upload');
      throw new Error('server accepted, response lost');
    }
    if (u.pathname.endsWith('/archives')) return memberOK({ arc_audits: matchOnServer ? [{ Archive: archive(), Videos: videos }] : [] });
    if (u.pathname === '/x/web/archive/view') return memberOK({ archive: archive(), videos });
    if (u.pathname === '/x/web-interface/view') return publiclyVisible
      ? memberOK({ state: 0, aid: 70001, bvid, owner: { mid: Number(account) }, pubdate: 1794644000 })
      : json({ code: -404 });
    throw new Error(`unexpected ${u.pathname}`);
  };
  const publisher = () => createVideoPublisher({ store, root, getConfig: () => cfg, getLogin: () => login,
    makeAdapter: (args) => createBiliVideoAdapter({ ...args, fetchImpl }), notify: async () => { notices++; } });
  try {
    const request = await requestPublication(ctx, 'go');
    const { attemptId } = request.publish;
    const current = () => store.getPublish(attemptId);
    const ledger = path.join(root, '..', 'bili-posts.jsonl');
    await approvePublication(ctx, { attemptId, packageHash: request.packageHash });

    await publisher().tick();
    state = current();
    assert.equal(state.state, 'uploading', JSON.stringify(safePublish(state)));
    assert.deepEqual(state.partAcks.map((part) => part.partNumber), [1]);
    assert.equal(JSON.stringify(safePublish(state)).includes('upload-secret'), false);
    expire(state);
    await publisher().tick();
    state = current();
    assert.equal(state.state, 'submission_unknown', JSON.stringify(safePublish(state)));
    assert.deepEqual(parts, [1, 2, 2, 3, 4]);
    assert.equal(routes.filter((route) => route === '/preupload').length, 1);
    assert.equal(submitted, 1);

    refreshPublication(ctx, attemptId);
    await publisher().tick();
    assert.equal(current().state, 'submission_unknown');
    assert.equal(submitted, 1);
    assert.equal(fs.existsSync(ledger), false);

    matchOnServer = true;
    refreshPublication(ctx, attemptId);
    await publisher().tick();
    assert.equal(current().state, 'reviewing');
    assert.equal(submitted, 1);
    assert.equal(fs.existsSync(ledger), false);

    publiclyVisible = true;
    refreshPublication(ctx, attemptId);
    await publisher().tick();
    assert.equal(current().state, 'published');
    assert.equal(current().aiVerified, false);
    assert.equal(store.hasVerifiedVideoCategory(account, 21), false);
    assert.equal(notices, 1);
    const post = JSON.parse(fs.readFileSync(ledger, 'utf8').trim());
    assert.equal(post.id, `video:${bvid}`);
    assert.equal(post.type, 'video');
    declaration = true;
    refreshPublication(ctx, attemptId);
    await publisher().tick();
    assert.equal(store.hasVerifiedVideoCategory(account, 21), true);
    assert.equal(notices, 1);
    assert.equal(fs.readFileSync(ledger, 'utf8').trim().split('\n').length, 1);
    const { ingestBiliEntries, createEmptyCard } = await import('../src/memory-card.js');
    const { recordsFromBiliEntries } = await import('../src/vector-memory.js');
    const memory = createEmptyCard();
    assert.equal(ingestBiliEntries(memory, [post]).added, 1);
    assert.match(JSON.stringify(memory), /我发的视频/u);
    assert.match(recordsFromBiliEntries([post])[0].title, /我发的视频/u);
    assert.equal(recordsFromBiliEntries([post])[0].isSelf, true);
  } finally { store.close(); }
});

test('automatic mode depends on per-category validation and changed settings pause writing', async () => {
  const { cfg, store, project } = setup();
  let remoteCalls = 0;
  try {
    cfg.video.publishMode = 'auto';
    cfg.video.publishTid = 22;
    const { ctx } = project('需要首次验证');
    const first = await requestPublication(ctx, 'go');
    assert.equal(first.publish.state, 'awaiting_approval');
    store.updatePublish(first.publish.attemptId, { state: 'superseded', nextPollAt: null });
    store.verifyVideoCategory(account, 22);
    const fresh = project('验证后自主排队').ctx;
    const request = await requestPublication(fresh, 'go');
    assert.equal(request.publish.state, 'authorized');
    cfg.video.publishMode = 'draft';
    const worker = createVideoPublisher({ store, root, getConfig: () => cfg, getLogin: () => login,
      makeAdapter: () => { remoteCalls++; throw publishError('MOCK', 'unexpected', 'unexpected'); } });
    await worker.tick();
    assert.equal(store.getPublish(request.publish.attemptId).state, 'blocked');
    assert.equal(remoteCalls, 0);
  } finally { store.close(); }
});

test('publication lock and cooldown are shared per account', () => {
  const release = acquirePublicationLock(other);
  const local = path.join(root, '..', 'fixture-dynamic.json');
  try { assert.throws(() => reservePublicationSlot(other, local, 30), { code: 'VIDEO_PUBLISH_BUSY' }); }
  finally { release(); }
  const slot = reservePublicationSlot(other, local, 30);
  try { slot.record(); } finally { slot.release(); }
  assert.throws(() => reservePublicationSlot(other, local, 30), { code: 'VIDEO_PUBLISH_COOLDOWN' });
});

test('account, outbound privacy, public grant and tampered files fail closed', async () => {
  const { cfg, store, project } = setup();
  try {
    const { ctx, revision } = project('隐私与素材');
    await assert.rejects(() => requestPublication({ ...ctx, login: { ...login, mid: other } }, 'go'), { code: 'VIDEO_ACCOUNT_REQUIRED' });
    const card = store.getPlan(ctx.projectId, 1).plan.scenes[0].visual.assetId;
    const opened = store.getAsset(card);
    store.db.prepare("UPDATE assets SET source = 'imported' WHERE id = ?").run(card);
    await assert.rejects(() => requestPublication(ctx, 'dry'), (error) => error.code === 'VIDEO_ASSET_PUBLIC_GRANT' && !!error.hint);
    store.db.prepare('UPDATE assets SET source = ? WHERE id = ?').run(opened.source, card);
    fs.writeFileSync(path.join(surfcore, 'bili.config.json'), JSON.stringify({ ...cfg, owner: { mid: other, name: '秘密昵称' } }));
    const plan = store.getPlan(ctx.projectId, 1).plan;
    plan.submission.description = '主人叫秘密昵称';
    store.db.prepare('UPDATE revisions SET plan = ? WHERE projectId = ? AND revision = 1').run(JSON.stringify(plan), ctx.projectId);
    await assert.rejects(() => requestPublication(ctx, 'dry'), { code: 'VIDEO_PRIVATE_CONTENT' });
    const current = revision(1);
    fs.writeFileSync(path.join(revisionDirFor(root, ctx.projectId, 2), 'final.mp4'), Buffer.alloc(220_000, 255));
    await assert.rejects(() => requestPublication(current, 'go'), { code: 'VIDEO_PACKAGE_CHANGED' });
  } finally { store.close(); }
});

test('known BV reconciliation checks the unique remote media reference', async () => {
  let wrong = true;
  const adapter = createBiliVideoAdapter({ login, fetchImpl: async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/archives')) return Response.json({ code: 0, data: { arc_audits: [] } });
    return Response.json({ code: 0, data: { archive: { aid: 8300, bvid },
      videos: [{ cid: 42, filename: wrong ? 'another-upload' : 'target' }] } });
  } });
  const media = { cid: '42', filename: 'target' };
  assert.equal(await adapter.reconcile(media, { title: '' }, bvid), null);
  wrong = false;
  assert.equal((await adapter.reconcile(media, { title: '' }, bvid)).archiveId, '8300');
});

test('changing only the configured category replaces an unsubmitted package', async () => {
  const { cfg, store, project } = setup();
  try {
    const { ctx } = project('改默认分区');
    const before = await requestPublication(ctx, 'go');
    cfg.video.publishTid = 31;
    const after = await requestPublication(ctx, 'go');
    assert.notEqual(before.publish.attemptId, after.publish.attemptId);
    assert.equal(after.publish.metadata.tid, 31);
    assert.equal(store.getPublish(before.publish.attemptId).state, 'superseded');
  } finally { store.close(); }
});

test('broken downstream memory and notification are tracked separately without reposting', async () => {
  const { cfg, store, project } = setup();
  const { ctx } = project('作品副作用恢复');
  let writes = 0;
  let reports = 0;
  let remote = 0;
  try {
    const request = await requestPublication(ctx, 'go');
    const id = request.publish.attemptId;
    // Simulate a receipt already verified by the public readback.
    store.updatePublish(id, { state: 'published', bvid, nextPollAt: null });
    const worker = createVideoPublisher({ store, root, getConfig: () => cfg, getLogin: () => login,
      makeAdapter: () => { remote++; throw new Error('unexpected network'); },
      async memory() { if (++writes === 1) throw new Error('disk failure'); },
      async notify() { reports++; throw new Error('delivery unknown'); },
    });
    await worker.tick();
    assert.equal(store.getPublish(id).memoryState, 'failed');
    assert.equal(store.getPublish(id).noticeState, 'needs_check');
    store.updatePublish(id, {}, { meta: { nextEffectAt: 0 } });
    await worker.tick();
    assert.equal(store.getPublish(id).memoryState, 'done');
    assert.equal(store.getPublish(id).noticeState, 'needs_check');
    assert.equal(reports, 1);
    assert.equal(remote, 0);
  } finally { store.close(); }
});
