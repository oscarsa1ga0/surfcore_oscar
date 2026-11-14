/**
 * 视频创作的管理 API（阶段一：项目浏览 + 工件流式读取；投稿操作是阶段三）。
 *
 * 路径挂在现有管理 API 的 /bili/video 下，由 lib/index.js 的 handleBili 分发进来。
 * 安全约定与现有管理 API 一致（外层 route() 已做回环/同源/鉴权）：
 *   · 读取只按项目 UUID + 版本 + 工件类型取文件，绝不按任意路径读；
 *   · 工件路径来自数据库相对路径，且 realpath 必须落在角色视频根目录内；
 *   · 支持 Range，供设置页 <video>/<audio> 拖动播放。
 */
import fs from 'node:fs';
import path from 'node:path';
import { revisionDirFor } from './paths.js';

const PROJECT_ID_RE = /^p_[0-9a-f]{16}$/;
const ARTIFACT_KINDS = new Set(['mp4', 'cover', 'srt', 'preview-grid', 'preview', 'manifest', 'qa']);

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function failJson(res, code, error, hint = '', status = 400) {
  json(res, status, { ok: false, code, error, hint });
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!match) return null;
  const start = match[1] === '' ? null : Number(match[1]);
  const end = match[2] === '' ? null : Number(match[2]);
  if (start == null && end == null) return null;
  const s = start ?? Math.max(0, size - (end ?? 0));
  const e = end ?? size - 1;
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e >= size || s > e) return null;
  return { start: s, end: e };
}

/** 创建 /bili/video 处理器；storeFactory 每次请求时解析（角色可能刚切换）。 */
export function createVideoApi({ storeFactory, log = () => {} }) {
  async function projectList(req, res, url) {
    try {
      const { store } = storeFactory();
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      json(res, 200, { ok: true, ...store.listProjects({ limit, offset }) });
    } catch (error) {
      failJson(res, error.code ?? 'VIDEO_STORE_ERROR', String(error.message ?? error), error.hint, 503);
    }
  }

  async function projectDetail(req, res, url, id) {
    try {
      const { store, character } = storeFactory();
      const project = store.getProject(id);
      if (!project) return failJson(res, 'VIDEO_PROJECT_NOT_FOUND', `项目不存在：${id}`);
      const videosEnabled = Boolean(videoEnabled());
      json(res, 200, {
        ok: true,
        character: { id: character.id, name: character.name },
        enabled: videosEnabled,
        project,
        artifactsByRevision: Object.fromEntries(
          (project.revisions ?? []).map((r) => [String(r.revision), store.listArtifacts(id, r.revision)]),
        ),
        publishes: (project.revisions ?? []).flatMap((r) => store.listPublishes(id, r.revision)),
      });
    } catch (error) {
      failJson(res, error.code ?? 'VIDEO_STORE_ERROR', String(error.message ?? error), error.hint, 503);
    }
  }

  async function artifact(req, res, url, id, revision, kind) {
    if (!PROJECT_ID_RE.test(id)) return failJson(res, 'VIDEO_BAD_PROJECT', '项目 id 格式非法');
    if (!ARTIFACT_KINDS.has(kind)) return failJson(res, 'VIDEO_BAD_ARTIFACT', `工件类型只允许 ${[...ARTIFACT_KINDS].join('/')}`);
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
      const realRoot = `${fs.realpathSync(root)}${path.sep}`;
      if (!real.startsWith(realRoot)) {
        return failJson(res, 'VIDEO_PATH_ESCAPE', '工件路径越界，拒绝读取');
      }
      const stat = fs.statSync(real);
      const range = parseRange(req.headers.range, stat.size);
      const mime = kind === 'mp4' ? 'video/mp4'
        : kind === 'srt' ? 'application/x-subrip'
          : kind === 'preview' || kind === 'manifest' || kind === 'qa' ? 'application/json'
            : 'image/png';
      const disposition = ['mp4', 'srt'].includes(kind)
        ? `attachment; filename="${path.basename(real)}"`
        : 'inline';
      res.statusCode = range ? 206 : 200;
      res.setHeader('content-type', mime);
      res.setHeader('content-length', range ? range.end - range.start + 1 : stat.size);
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('content-disposition', disposition);
      if (range) res.setHeader('content-range', `bytes ${range.start}-${range.end}/${stat.size}`);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(real, range ? { start: range.start, end: range.end } : undefined);
      stream.on('error', () => { try { res.destroy(); } catch {} });
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
      const cancelled = store.cancelProjectTasks(id, revision);
      const state = store.setProjectState(id, 'shelved');
      json(res, 200, { ok: true, cancelled: cancelled.cancelled, project: { id, editState: state.editState } });
    } catch (error) {
      failJson(res, error.code ?? 'VIDEO_SHELVE_FAILED', String(error.message ?? error), error.hint, 503);
    }
  }

  async function approve(req, res, id) {
    // 阶段三：投稿确认。现在明确返回“未开放”，避免静默假成功。
    failJson(res, 'VIDEO_PHASE3', '投稿确认在阶段三开放（当前阶段只做本地创作与导出）', '先在设置页播放/导出，B 站官方创作中心手动提交', 501);
  }

  return {
    async handle(req, res, url) {
      const pathname = url.pathname;
      const base = '/dsh-surfcore/api/bili/video';
      if (pathname === `${base}/projects` && req.method === 'GET') return projectList(req, res, url);
      const detailMatch = /^\/dsh-surfcore\/api\/bili\/video\/projects\/([^/]+)$/.exec(pathname);
      if (detailMatch && req.method === 'GET') return projectDetail(req, res, url, detailMatch[1]);
      const artifactMatch = /^\/dsh-surfcore\/api\/bili\/video\/projects\/([^/]+)\/revisions\/(\d+)\/artifacts\/([a-z-]+)$/.exec(pathname);
      if (artifactMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        return artifact(req, res, url, artifactMatch[1], artifactMatch[2], artifactMatch[3]);
      }
      if (detailMatch && req.method === 'POST' && pathname.endsWith('/retry')) return retry(req, res, detailMatch[1]);
      if (detailMatch && req.method === 'POST' && pathname.endsWith('/shelve')) return shelve(req, res, detailMatch[1]);
      if (detailMatch && req.method === 'POST' && pathname.endsWith('/approve')) return approve(req, res, detailMatch[1]);
      return failJson(res, 'VIDEO_NOT_FOUND', `未知视频接口：${pathname}`, '', 404);
    },
  };
}

// 由 index.js 注入的配置读取（避免循环 import）
let videoEnabled = () => false;
export function setVideoConfigReader(fn) {
  videoEnabled = fn;
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}
