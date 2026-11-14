/**
 * 视频创作的管理 API：项目、素材、工件预览、投稿确认和状态刷新。
 *
 * 路径挂在现有管理 API 的 /bili/video 下，由 lib/index.js 的 handleBili 分发进来。
 * 安全约定与现有管理 API 一致（外层 route() 已做回环/同源/鉴权）：
 *   · 读取只按项目 UUID + 版本 + 工件类型取文件，绝不按任意路径读；
 *   · 工件路径来自数据库相对路径，且 realpath 必须落在角色视频根目录内；
 *   · 支持 Range，供设置页 <video>/<audio> 拖动播放。
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerAuthorizedAsset } from './assets.js';
import { assertVideoDiskBudget } from './budget.js';
import { approvePublication, refreshPublication, requestPublication, safePublish } from './publish-state.js';
import { compareVersions } from './review.js';
import { revisionDirFor } from './paths.js';

const PROJECT_ID_RE = /^p_[0-9a-f]{16}$/;
const ARTIFACT_KINDS = new Set(['mp4', 'cover', 'srt', 'preview-grid', 'preview', 'manifest', 'qa', 'narration']);

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function failJson(res, code, error, hint = '', status = 400) {
  json(res, status, { ok: false, code, error, hint: hint || '刷新当前项目或检查视频创作设置后重试' });
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!match) return null;
  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return null;
  const start = hasStart ? Number(match[1]) : null;
  const end = hasEnd ? Number(match[2]) : null;
  if (start != null && !Number.isInteger(start)) return null;
  if (end != null && !Number.isInteger(end)) return null;
  let s;
  let e;
  if (start == null) {
    // 后缀形式 bytes=-N：取最后 N 字节
    s = Math.max(0, size - end);
    e = size - 1;
  } else {
    s = start;
    e = end ?? size - 1;
  }
  if (s < 0 || e >= size || s > e) return null;
  return { start: s, end: e };
}

/** 创建 /bili/video 处理器；storeFactory 每次请求时解析（角色可能刚切换）。 */
export function createVideoApi({ storeFactory, getPublishConfig = () => ({}), log = () => {} }) {
  async function projectList(req, res, url) {
    try {
      const { store, character } = storeFactory();
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      json(res, 200, { ok: true, character: { id: character.id, name: character.name }, ...store.listProjects({ limit, offset }) });
    } catch (error) {
      failJson(res, error.code ?? 'VIDEO_STORE_ERROR', String(error.message ?? error), error.hint, 503);
    }
  }

  async function projectDetail(req, res, url, id) {
    try {
      const { store, character } = storeFactory();
      const project = store.getProject(id);
      if (!project) return failJson(res, 'VIDEO_PROJECT_NOT_FOUND', `项目不存在：${id}`);
      const videosEnabled = videoConfig().enabled === true;
      json(res, 200, {
        ok: true,
        character: { id: character.id, name: character.name, epoch: character.epoch },
        enabled: videosEnabled,
        project,
        artifactsByRevision: Object.fromEntries(
          (project.revisions ?? []).map((r) => [String(r.revision), store.listArtifacts(id, r.revision)]),
        ),
        publishes: store.listPublishes(id).map(safePublish),
      });
    } catch (error) {
      failJson(res, error.code ?? 'VIDEO_STORE_ERROR', String(error.message ?? error), error.hint, 503);
    }
  }

  async function artifact(req, res, url, id, revision, kind) {
    if (!PROJECT_ID_RE.test(id)) return failJson(res, 'VIDEO_BAD_PROJECT', '项目 id 格式非法');
    if (!ARTIFACT_KINDS.has(kind) && !/^frame-[a-zA-Z0-9_-]{1,64}$/.test(kind)) return failJson(res, 'VIDEO_BAD_ARTIFACT', `工件类型只允许 ${[...ARTIFACT_KINDS].join('/')}`);
    const rev = Number(revision);
    if (!Number.isInteger(rev) || rev <= 0) return failJson(res, 'VIDEO_BAD_REVISION', '版本号非法');
    try {
      const { store, root } = storeFactory();
      const artifact = store.getArtifact(id, rev, kind);
      if (!artifact) return failJson(res, 'VIDEO_ARTIFACT_NOT_FOUND', `工件不存在：${kind}`, '先渲染该版本再读取', 404);
      if (artifact.relativePath.split(/[\\/]/).some((part) => part === '..' || part === '')) {
        return failJson(res, 'VIDEO_BAD_PATH', '工件路径非法');
      }
      const full = path.join(revisionDirFor(root, id, rev), artifact.relativePath);
      const real = fs.realpathSync(full);
      const realRoot = `${fs.realpathSync(revisionDirFor(root, id, rev))}${path.sep}`;
      if (!real.startsWith(realRoot)) {
        return failJson(res, 'VIDEO_PATH_ESCAPE', '工件路径越界，拒绝读取');
      }
      const stat = fs.statSync(real);
      const range = parseRange(req.headers.range, stat.size);
      const mime = kind === 'mp4' ? 'video/mp4' : kind === 'narration' ? 'audio/wav'
        : kind === 'srt' ? 'application/x-subrip'
          : kind === 'preview' || kind === 'manifest' || kind === 'qa' ? 'application/json'
            : 'image/png';
      const disposition = (kind === 'srt' || url.searchParams.get('download') === '1')
        ? `attachment; filename="${path.basename(real)}"`
        : 'inline';
      res.statusCode = range ? 206 : 200;
      res.setHeader('content-type', mime);
      res.setHeader('content-length', String(range ? range.end - range.start + 1 : stat.size));
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('content-disposition', disposition);
      if (range) res.setHeader('content-range', `bytes ${range.start}-${range.end}/${stat.size}`);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(real, range ? { start: range.start, end: range.end } : undefined);
      stream.on('error', () => { try { res.destroy(); } catch {} });
      res.on?.('close', () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      if (error.code === 'ENOENT') return failJson(res, 'VIDEO_ARTIFACT_NOT_FOUND', '工件文件缺失', '', 404);
      log(`[video-api] 工件读取失败：${String(error?.message ?? error)}`);
      failJson(res, 'VIDEO_READ_FAILED', String(error.message ?? error), '', 500);
    }
  }

  async function retry(req, res, id) {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const { store } = storeFactory();
      const revision = Number(body.revision ?? 0);
      const kind = String(body.kind ?? 'render');
      if (!videoConfig().enabled) return failJson(res, 'VIDEO_DISABLED', '视频创作处于关闭状态', '请启用后再提交渲染', 409);
      if (kind !== 'render') return failJson(res, 'VIDEO_BAD_TASK_KIND', '本地视频任务仅支持渲染');
      if (!PROJECT_ID_RE.test(id)) return failJson(res, 'VIDEO_BAD_PROJECT', '项目 id 格式非法');
      const result = store.retryTasks(id, revision, kind);
      if (!result.ok) return failJson(res, result.code, result.error, result.hint);
      json(res, 200, { ok: true, ...result });
    } catch (error) {
      failJson(res, error.code ?? 'VIDEO_RETRY_FAILED', String(error.message ?? error), error.hint, 503);
    }
  }

  async function shelve(req, res, id) {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const { store } = storeFactory();
      if (!PROJECT_ID_RE.test(id)) return failJson(res, 'VIDEO_BAD_PROJECT', '项目 id 格式非法');
      const revision = Number(body.revision ?? 0);
      const state = store.setReviewDecision(id, revision, 'shelve', body.reason);
      json(res, 200, { ...state, project: { id, editState: state.editState } });
    } catch (error) {
      failJson(res, error.code ?? 'VIDEO_SHELVE_FAILED', String(error.message ?? error), error.hint, 503);
    }
  }

  async function manageAsset(req, res, assetId = null) {
    try {
      const config = videoConfig();
      if (!config.enabled) return failJson(res, 'VIDEO_DISABLED', '视频创作处于关闭状态', '先保存启用视频创作设置', 409);
      const body = JSON.parse(await readBody(req) || '{}');
      const { store, root, character } = storeFactory();
      if (body.characterId !== character.id || body.characterEpoch !== character.epoch) {
        return failJson(res, 'VIDEO_CHARACTER_CHANGED', '角色已切换或页面已过期', '刷新素材库后再操作', 409);
      }
      if (assetId) return json(res, 200, store.revokeAsset(assetId));
      if (typeof body.file !== 'string' || !path.isAbsolute(body.file)) {
        return failJson(res, 'VIDEO_ASSET_BAD_PATH', '请输入本机素材的绝对路径');
      }
      const result = registerAuthorizedAsset(store, root, body.file, {
        kind: body.kind, name: body.name, authorization: body.authorization,
        checkBudget: (bytes) => assertVideoDiskBudget(root, config.videoDirMaxMB * 1024 * 1024, bytes),
      });
      return json(res, 201, { ok: true, ...result });
    } catch (error) {
      return failJson(res, error.code ?? 'VIDEO_ASSET_FAILED', error.message, error.hint);
    }
  }

  async function readComparison(res, id, url) {
    try {
      if (!PROJECT_ID_RE.test(id)) return failJson(res, 'VIDEO_BAD_PROJECT', '项目 id 格式非法');
      const { store } = storeFactory();
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      if (![from, to].every((rev) => Number.isInteger(rev) && rev > 0)) {
        return failJson(res, 'VIDEO_BAD_REVISION', '请选择两个版本');
      }
      return json(res, 200, { ok: true, ...compareVersions(store, id, from, to) });
    } catch (error) {
      return failJson(res, error.code ?? 'VIDEO_COMPARE_FAILED', error.message, error.hint);
    }
  }

  async function publishAction(req, res, id, action) {
    try {
      if (!PROJECT_ID_RE.test(id)) return failJson(res, 'VIDEO_BAD_PROJECT', '项目 id 格式非法');
      const body = JSON.parse(await readBody(req) || '{}');
      const { store, root, character } = storeFactory();
      if (body.characterId !== character.id || body.characterEpoch !== character.epoch) {
        return failJson(res, 'VIDEO_CHARACTER_CHANGED', '角色已切换或页面已过期', '刷新项目后再操作', 409);
      }
      const ctx = { store, root, projectId: id, revision: Number(body.revision), cfg: getPublishConfig() };
      const result = action === 'approve'
        ? { publish: await approvePublication(ctx, { attemptId: body.attemptId, packageHash: body.packageHash }) }
        : action === 'prepare-publish'
          ? await requestPublication(ctx, ctx.cfg.video?.publishMode === 'draft' ? 'draft' : 'go', { forceApproval: true })
          : refreshPublication(ctx, body.attemptId, body.bvid);
      json(res, 200, { ok: true, ...result });
    } catch (error) {
      failJson(res, error.code ?? 'VIDEO_PUBLISH_REQUEST_FAILED',
        error.code?.startsWith('VIDEO_') ? error.message : '无法处理稿件请求', error.hint, 409);
    }
  }

  return {
    async handle(req, res, url) {
      const pathname = url.pathname;
      const base = '/dsh-surfcore/api/bili/video';
      if (pathname === `${base}/assets`) {
        if (req.method === 'GET') {
          try {
            const { store, character } = storeFactory();
            return json(res, 200, { ok: true, assets: store.listAssets({ limit: 200 }),
              character: { id: character.id, name: character.name, epoch: character.epoch } });
          } catch (error) {
            return failJson(res, error.code ?? 'VIDEO_STORE_ERROR', error.message, error.hint, 503);
          }
        }
        if (req.method === 'POST') return manageAsset(req, res);
      }
      const revokeMatch = /^\/dsh-surfcore\/api\/bili\/video\/assets\/(a_[a-f0-9]{16})\/revoke$/.exec(pathname);
      if (revokeMatch && req.method === 'POST') return manageAsset(req, res, revokeMatch[1]);
      const compareMatch = /^\/dsh-surfcore\/api\/bili\/video\/projects\/([^/]+)\/compare$/.exec(pathname);
      if (compareMatch && req.method === 'GET') return readComparison(res, compareMatch[1], url);
      if (pathname === `${base}/projects` && req.method === 'GET') return projectList(req, res, url);
      const detailMatch = /^\/dsh-surfcore\/api\/bili\/video\/projects\/([^/]+)$/.exec(pathname);
      if (detailMatch && req.method === 'GET') return projectDetail(req, res, url, detailMatch[1]);
      // kind 含数字（mp4），不能只用 [a-z-]
      const artifactMatch = /^\/dsh-surfcore\/api\/bili\/video\/projects\/([^/]+)\/revisions\/(\d+)\/artifacts\/([a-z0-9-]+)$/.exec(pathname);
      if (artifactMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        return artifact(req, res, url, artifactMatch[1], artifactMatch[2], artifactMatch[3]);
      }
      const actionMatch = /^\/dsh-surfcore\/api\/bili\/video\/projects\/([^/]+)\/(retry|shelve|approve|prepare-publish|refresh-publish)$/.exec(pathname);
      if (actionMatch && req.method === 'POST') {
        if (actionMatch[2] === 'retry') return retry(req, res, actionMatch[1]);
        if (actionMatch[2] === 'shelve') return shelve(req, res, actionMatch[1]);
        return publishAction(req, res, actionMatch[1], actionMatch[2]);
      }
      return failJson(res, 'VIDEO_NOT_FOUND', `未知视频接口：${pathname}`, '', 404);
    },
  };
}

// 由 index.js 注入的配置读取（避免循环 import）
let videoConfig = () => ({});
export function setVideoConfigReader(fn) {
  videoConfig = fn;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 16 * 1024) {
        reject(Object.assign(new Error('管理请求过大'), { code: 'VIDEO_REQUEST_TOO_LARGE' }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
