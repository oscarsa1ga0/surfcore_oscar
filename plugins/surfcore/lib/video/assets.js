/**
 * 素材准入与登记（阶段一）。
 *
 * 阶段一范围（方案 §5.1）：只启用
 *   · 程序生成的纯色/几何卡片（source=generated）
 *   · 已登记的鱼姬头像/插画（source=imported, kind=avatar/image）
 * 拒绝：路径穿越、符号链接越界、异常解码尺寸、超量媒体。
 * 素材按内容寻址存放：assets/<sha256>/<name>，同名内容只存一份。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assetDirFor, assetsDir } from './paths.js';
import { shotsRoot } from '../../tools/lib/shots-cache.mjs';
import { resolveFfprobe, LOCAL_MEDIA_FORMATS } from './media.js';
import { sha256Of } from './project-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ASSET_KINDS = ['card', 'avatar', 'image', 'clip', 'music', 'sfx'];
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export function resolvePython() {
  const candidates = [
    process.env.SURFCORE_PYTHON,
    process.env.PYTHON,
    path.join(process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh'), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
    'python3',
    'python',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) return candidate;
    } catch {}
  }
  for (const candidate of candidates) {
    if (candidate === 'python3' || candidate === 'python') {
      try {
        execFileSync(candidate, ['--version'], { stdio: 'pipe' });
        return candidate;
      } catch {}
    }
  }
  return null;
}

function pyFail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function runPy(args, { cwd = process.cwd() } = {}) {
  const python = resolvePython();
  if (!python) throw pyFail('VIDEO_NO_PYTHON', '找不到带 Pillow 的 Python（装 Pillow 或用 SURFCORE_PYTHON 指定）');
  const script = path.join(HERE, 'py', 'caption-render.py');
  let output;
  try {
    output = execFileSync(python, [script, ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
  } catch (error) {
    output = String(error.stdout ?? '');
    if (!output) throw pyFail('VIDEO_PYTHON_FAILED', '图形渲染器执行失败，请检查 Python 和 Pillow');
  }
  try {
    const result = JSON.parse(output.trim().split('\n').pop());
    if (!result.ok) throw pyFail(result.code ?? 'VIDEO_PYTHON_FAILED', result.error ?? '图形渲染器失败');
    return result;
  } catch (error) {
    if (error.code) throw error;
    throw pyFail('VIDEO_PYTHON_FAILED', '图形渲染器未返回有效结果');
  }
}

/** 生成一张卡片素材：Pillow 画 PNG → 内容寻址落盘 → 登记。 */
export function registerGeneratedCard(store, root, { kind = 'color', color = '2b3a55', color2 = '182038', accent = 'ffffff', text = '', importer = 'video-tool' } = {}) {
  if (String(text).length > 200) throw pyFail('VIDEO_ASSET_TEXT_TOO_LONG', '卡片文字最多 200 字');
  const tmp = path.join(assetsDir(root), `.tmp-${process.pid}-${Date.now()}.png`);
  const result = runPy(['card', '--out', tmp, '--kind', kind, '--color', color, '--color2', color2, '--accent', accent, '--text', text]);
  if (!result?.ok) throw pyFail('VIDEO_CARD_FAILED', `生成卡片失败：${result?.error ?? result?.raw ?? '未知'}`);
  const bytes = fs.readFileSync(tmp);
  const sha256 = sha256Of(bytes);
  const existing = store.getAssetBySha(sha256);
  fs.unlinkSync(tmp);
  if (existing) return { asset: existing, duplicate: true };
  const dir = assetDirFor(root, sha256);
  fs.mkdirSync(dir, { recursive: true });
  const name = `card-${kind}-${sha256.slice(0, 8)}.png`;
  fs.writeFileSync(path.join(dir, name), bytes);
  const asset = store.registerAsset({
    sha256,
    kind: 'card',
    source: 'generated',
    importer,
    name,
    ext: '.png',
    bytes: bytes.length,
    relativePath: path.join(String(sha256), name),
    authorization: { usage: 'background', generated: true, cardText: String(text ?? '').slice(0, 200) },
    revocable: true,
  });
  return { asset, duplicate: false };
}

/** 图像探针：符号链接越界 / 超量 / 解码异常 / 尺寸异常 全部拒绝。 */
export function probeImageFile(srcPath, { maxBytes = 20 * 1024 * 1024, maxSide = 7680, minSide = 16 } = {}) {
  if (typeof srcPath !== 'string' || !srcPath.trim()) throw pyFail('VIDEO_ASSET_BAD_PATH', '素材路径为空');
  const abs = path.resolve(srcPath);
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    throw pyFail('VIDEO_ASSET_MISSING', `素材文件不存在：${abs}`);
  }
  // 拒绝“文件本身是符号链接”：防越界引用；macOS /var→/private/var 这类系统级
  // 规范化差异不影响（内容始终按字节复制进素材库，路径只在登记时读一次）。
  if (stat.isSymbolicLink()) throw pyFail('VIDEO_ASSET_SYMLINK', '拒绝符号链接素材：请传真实文件路径（防越界）');
  if (!stat.isFile()) throw pyFail('VIDEO_ASSET_NOT_FILE', '素材路径不是普通文件');
  if (stat.size > maxBytes) {
    throw pyFail('VIDEO_ASSET_TOO_BIG', `素材超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB（实际 ${stat.size} 字节）`);
  }
  const ext = path.extname(abs).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) throw pyFail('VIDEO_ASSET_BAD_TYPE', `图片入口只收（${[...IMAGE_EXTS].join(' ')}），收到 ${ext || '(无扩展名)'}`);
  const python = resolvePython();
  if (!python) throw pyFail('VIDEO_NO_PYTHON', '找不到带 Pillow 的 Python，无法校验图片');
  const probe = execFileSync(python, ['-c', [
    'import json,sys',
    'from PIL import Image',
    'try:',
    '  im=Image.open(sys.argv[1]); im.load()',
    '  w,h=im.size',
    '  ok=' + `${minSide} <= w <= ${maxSide} and ${minSide} <= h <= ${maxSide}`,
    '  print(json.dumps({"ok":ok,"w":w,"h":h,"format":im.format}))',
    'except Exception as e:',
    '  print(json.dumps({"ok":False,"error":str(e)[:200]}))',
  ].join('\n'), abs], { encoding: 'utf8' });
  let info;
  try {
    info = JSON.parse(probe.trim().split('\n').pop());
  } catch {
    throw pyFail('VIDEO_ASSET_DECODE', '图片解码探测失败');
  }
  if (!info.ok) throw pyFail('VIDEO_ASSET_DECODE', `图片无法解码：${info.error ?? '未知错误'}`);
  return { path: abs, ext, bytes: stat.size, width: info.w, height: info.h, format: info.format };
}

/** 登记一张图片素材（头像/插画）：复制内容进素材库，按 sha256 去重。 */
export function registerImageAsset(store, root, srcPath, { kind = 'avatar', name = '', importer = 'video-tool', authorization = {} } = {}) {
  if (!['avatar', 'image'].includes(kind)) throw pyFail('VIDEO_ASSET_BAD_KIND', '图片类型只允许 avatar/image');
  assertSourceAllowed(srcPath);
  const probe = probeImageFile(srcPath);
  const bytes = fs.readFileSync(probe.path);
  const sha256 = sha256Of(bytes);
  const existing = store.getAssetBySha(sha256);
  if (existing) return { asset: existing, duplicate: true };
  const dir = assetDirFor(root, sha256);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = (name || path.basename(probe.path, probe.ext)).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 80);
  const finalName = `${safeName || 'image'}${probe.ext}`;
  fs.writeFileSync(path.join(dir, finalName), bytes);
  const asset = store.registerAsset({
    sha256,
    kind,
    source: 'imported',
    importer,
    name: finalName,
    ext: probe.ext,
    bytes: probe.bytes,
    relativePath: path.join(String(sha256), finalName),
    authorization: {
      usage: kind === 'avatar' ? 'avatar' : 'image',
      claimedBy: String(importer),
      note: String(authorization?.note ?? ''),
      ...(authorization ?? {}),
    },
    revocable: true,
  });
  return { asset, duplicate: false };
}

/** 解析计划里的 assetId → 素材库里的绝对文件路径；不存在时给出可读错误。 */
export function resolveAssetFile(store, root, assetId) {
  const asset = store.getAsset(String(assetId ?? ''));
  if (!asset) {
    const error = new Error(`素材不存在：${assetId}`);
    error.code = 'VIDEO_ASSET_NOT_FOUND';
    error.hint = '用 video-project assets 看已登记素材，先登记再引用';
    throw error;
  }
  if (asset.authorization?.revokedAt) {
    throw Object.assign(pyFail('VIDEO_ASSET_REVOKED', `素材授权已撤销：${assetId}`), { hint: '换成已授权素材后重新渲染' });
  }
  const full = path.join(root, 'assets', asset.relativePath);
  if (!fs.existsSync(full)) {
    const error = new Error(`素材文件缺失：${asset.relativePath}`);
    error.code = 'VIDEO_ASSET_FILE_MISSING';
    throw error;
  }
  const real = fs.realpathSync(full);
  if (!inside(fs.realpathSync(assetsDir(root)), real) || !fs.statSync(real).isFile()) {
    throw pyFail('VIDEO_ASSET_BAD_PATH', '素材路径越界或不是普通文件');
  }
  return { asset, file: real };
}

const CLIP_EXTS = new Set(['.mp4', '.mov', '.webm']);
const AUDIO_EXTS = new Set(['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.opus', '.aac']);
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

function inside(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

export function assertSourceAllowed(src) {
  let stat;
  try { stat = fs.lstatSync(src); }
  catch { throw pyFail('VIDEO_ASSET_MISSING', '找不到待导入文件'); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw pyFail('VIDEO_ASSET_BAD_PATH', '请导入普通文件，素材不能是符号链接');
  const real = fs.realpathSync(src);
  const shots = shotsRoot();
  const realShots = fs.existsSync(shots) ? fs.realpathSync(shots) : shots;
  if (inside(realShots, real)) throw pyFail('VIDEO_ASSET_REFERENCE_ONLY', 'B 站观看缓存只能参考，请使用独立的原创或获授权文件');
  return { real, stat };
}

export function validateAssetGrant(input) {
  const mode = input?.mode;
  const note = String(input?.note ?? '').trim();
  const credit = String(input?.credit ?? '').trim();
  const sourceRef = String(input?.sourceRef ?? '').trim();
  if (!['original', 'licensed'].includes(mode) || !note || note.length > 500
    || credit.length > 200 || sourceRef.length > 300 || (mode === 'licensed' && !sourceRef)) {
    throw pyFail('VIDEO_ASSET_AUTH_REQUIRED', '由设置页登记原创或授权说明；获授权素材还需来源或凭据说明');
  }
  const publishAllowed = input.publishAllowed === true;
  return { mode, note, credit, sourceRef, publishAllowed, scope: publishAllowed ? 'bilibili' : 'local-edit', grantedAt: Date.now() };
}

function probeMedia(src, kind) {
  const ffprobe = resolveFfprobe();
  if (!ffprobe) throw pyFail('VIDEO_NO_FFPROBE', '找不到 ffprobe，请检查 FFmpeg 安装');
  let probe;
  try {
    probe = JSON.parse(execFileSync(ffprobe, [
      '-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', LOCAL_MEDIA_FORMATS, '-show_entries',
      'stream=codec_type,codec_name,width,height,duration:stream_disposition=attached_pic:format=duration,format_name',
      '-of', 'json', src,
    ], { encoding: 'utf8', timeout: 12_000, maxBuffer: 128 * 1024 }));
  } catch { throw pyFail('VIDEO_ASSET_DECODE', '无法读取素材的音视频流'); }
  const videoStreams = probe.streams?.filter((stream) => stream.codec_type === 'video') ?? [];
  const video = videoStreams.find((stream) => !stream.disposition?.attached_pic);
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  const formats = String(probe.format?.format_name ?? '').split(',');
  const durationMs = Math.floor(1000 * Number((kind === 'clip' ? video : audio)?.duration ?? probe.format?.duration));
  const audioDurationMs = audio ? Math.floor(1000 * Number(audio.duration ?? probe.format?.duration)) : null;
  if (!(durationMs > 0 && durationMs <= 30 * 60_000) || !formats.some((format) =>
    LOCAL_MEDIA_FORMATS.split(',').includes(format))
    || (kind === 'clip' ? !(video && videoStreams[0] === video && video.width >= 16 && video.height >= 16 && video.width <= 4096 && video.height <= 4096) : !audio || Boolean(video))) {
    throw pyFail('VIDEO_ASSET_DECODE', '素材需为可解码的本地视频/音频，最长 30 分钟，画幅不超过 4096×4096');
  }
  return { durationMs, audioDurationMs, hasAudio: Boolean(audio), width: video?.width, height: video?.height };
}

/** 由已鉴权的管理入口登记。先验证隔离副本，再按内容寻址落盘。 */
export function registerAuthorizedAsset(store, root, src, { kind, name = '', authorization, checkBudget = () => {} } = {}) {
  const grant = validateAssetGrant(authorization);
  const { real, stat } = assertSourceAllowed(src);
  if (stat.size <= 0 || stat.size > MAX_IMPORT_BYTES) throw pyFail('VIDEO_ASSET_TOO_BIG', '单个素材须在 100 MiB 以内');
  checkBudget(stat.size);
  const ext = path.extname(real).toLowerCase();
  const image = ['avatar', 'image'].includes(kind);
  const allowed = image ? IMAGE_EXTS : kind === 'clip' ? CLIP_EXTS : ['music', 'sfx'].includes(kind) ? AUDIO_EXTS : null;
  if (!allowed?.has(ext)) throw pyFail('VIDEO_ASSET_BAD_TYPE', '文件扩展名与所选素材类型不符');
  const tmp = path.join(assetsDir(root), `.import-${crypto.randomUUID()}${ext}`);
  try {
    fs.copyFileSync(real, tmp, fs.constants.COPYFILE_EXCL);
    if (fs.statSync(tmp).size > MAX_IMPORT_BYTES) throw pyFail('VIDEO_ASSET_TOO_BIG', '单个素材须在 100 MiB 以内');
    const media = image ? probeImageFile(tmp) : probeMedia(tmp, kind);
    const metadata = Object.fromEntries(['durationMs', 'audioDurationMs', 'width', 'height', 'hasAudio'].filter((key) => media[key] != null).map((key) => [key, media[key]]));
    const bytes = fs.readFileSync(tmp);
    const sha256 = sha256Of(bytes);
    const existing = store.getAssetBySha(sha256);
    if (existing && existing.kind !== kind) {
      throw pyFail('VIDEO_ASSET_KIND_CONFLICT', `同一文件已登记为 ${existing.kind}`);
    }
    const dir = assetDirFor(root, sha256);
    fs.mkdirSync(dir, { recursive: true });
    const storedName = `media${ext}`;
    const final = path.join(dir, storedName);
    fs.renameSync(tmp, final);
    return store.registerAuthorizedAsset({
      sha256, kind, source: 'imported', importer: 'dsh-settings',
      name: String(name || path.basename(real)).slice(0, 100), ext, bytes: bytes.length,
      relativePath: path.join(sha256, storedName), authorization: { ...grant, media: metadata },
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function validatePlanAssets(store, root, plan) {
  const sources = new Map();
  const load = (assetId) => {
    if (!sources.has(assetId)) sources.set(assetId, resolveAssetFile(store, root, assetId));
    return sources.get(assetId).asset;
  };
  for (const scene of plan.scenes) {
    const visual = scene.visual;
    const asset = load(visual.assetId);
    const media = asset.authorization?.media;
    if (asset.kind === 'clip') {
      if (!asset.authorization?.mode || visual.inMs == null || visual.outMs > media?.durationMs
        || !(media?.durationMs > 0) || (visual.audio === 'mix' && (!media?.hasAudio || visual.outMs > media.audioDurationMs))) {
        throw pyFail('VIDEO_CLIP_RANGE', `镜头 ${scene.id} 需要已授权的视频及有效的取材区间；保留原声时该区间必须有音频`);
      }
    } else if (!['image', 'card', 'avatar'].includes(asset.kind) || visual.inMs != null || visual.audio === 'mix' || scene.duration.mode === 'clip') {
      throw pyFail('VIDEO_ASSET_BAD_KIND', `镜头 ${scene.id} 的素材类型与取材方式不符`);
    }
  }
  for (const track of plan.audioTracks ?? []) {
    const asset = load(track.assetId);
    if (asset.kind !== track.kind || !asset.authorization?.mode || !(track.outMs <= asset.authorization?.media?.durationMs)) {
      throw pyFail('VIDEO_AUDIO_RANGE', '配乐/音效必须引用同类型已授权素材，取材区间不能超出源文件');
    }
  }
  return sources;
}
