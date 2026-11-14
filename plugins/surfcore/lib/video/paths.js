/**
 * 视频创作模块的路径与角色解析（阶段一）。
 *
 * 一切视频产物都落在**当前角色**的 B站 目录下：
 *   <DSH_HOME>/surfcore/characters/<id>/bili/video/
 *     projects.sqlite                      —— 项目/版本/任务/素材/投稿 的唯一数据库
 *     assets/<sha256>/                     —— 已登记素材（按内容寻址）
 *     projects/<pid>/revisions/<n>/        —— 版本工件（mp4/封面/字幕/旁白/临时目录）
 *
 * 角色未解析时本模块一律报错，绝不把项目写进账号公共目录（方案 §3）。
 * 当前角色解析与工具链共用 tools/lib/state-paths.mjs 的 currentCharacter()，
 * 保持「插件进程里读到的角色」与「CLI 进程里读到的角色」永远是同一个口径。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CHARACTERS_DIR, currentCharacter,
} from '../../tools/lib/state-paths.mjs';

/** 该角色 id 是否合法（与 state-paths 的校验一致）。 */
export function isValidCharacterId(id) {
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(String(id ?? ''));
}

/** 指定角色的视频根目录（不检查角色是否存在）。 */
export function videoRootFor(characterId) {
  return path.join(CHARACTERS_DIR, String(characterId), 'bili', 'video');
}

/**
 * 当前角色的视频根目录；解析不到角色时抛错。
 * @returns {{ root, character: {id, name, epoch} }}
 */
export function requireVideoRoot() {
  const character = currentCharacter();
  if (!character) {
    const error = new Error('当前没有可用角色：视频项目按角色隔离，请先在设置页创建/切换角色');
    error.code = 'VIDEO_NO_CHARACTER';
    error.hint = '设置 → 角色：先有当前角色，再开始视频创作';
    throw error;
  }
  return { root: videoRootFor(character.id), character };
}

export function projectsDbPath(root) {
  return path.join(root, 'projects.sqlite');
}

export function assetsDir(root) {
  return path.join(root, 'assets');
}

export function assetDirFor(root, sha256) {
  return path.join(assetsDir(root), String(sha256));
}

export function projectDirFor(root, projectId) {
  return path.join(root, 'projects', String(projectId));
}

export function revisionDirFor(root, projectId, revision) {
  return path.join(projectDirFor(root, projectId), 'revisions', String(Number(revision)));
}

/** 渲染进行中的临时目录：校验成功后才原子重命名进版本目录（方案 §3）。 */
export function tmpDirFor(root, projectId, revision) {
  return path.join(projectDirFor(root, projectId), 'revisions', String(Number(revision)), '.tmp');
}

export function ensureVideoDirs(root, { projectId = null, revision = null } = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(assetsDir(root), { recursive: true });
  if (projectId) fs.mkdirSync(projectDirFor(root, projectId), { recursive: true });
  if (projectId && revision != null) {
    fs.mkdirSync(revisionDirFor(root, projectId, revision), { recursive: true });
    fs.mkdirSync(tmpDirFor(root, projectId, revision), { recursive: true });
  }
}
