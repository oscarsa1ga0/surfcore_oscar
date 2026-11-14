/**
 * 素材准入与登记（阶段一）。
 *
 * 阶段一范围（方案 §5.1）：只启用
 *   · 程序生成的纯色/几何卡片（source=generated）
 *   · 已登记的鱼姬头像/插画（source=imported, kind=avatar/image）
 * 拒绝：路径穿越、符号链接越界、异常解码尺寸、超量媒体。
 * 素材按内容寻址存放：assets/<sha256>/<name>，同名内容只存一份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assetDirFor, assetsDir } from './paths.js';
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
  const output = execFileSync(python, [script, ...args], { cwd, encoding: 'utf8' });
  try {
    return JSON.parse(output.trim().split('\n').pop());
  } catch {
    return { ok: false, raw: output };
  }
}

/** 生成一张卡片素材：Pillow 画 PNG → 内容寻址落盘 → 登记。 */
export function registerGeneratedCard(store, root, { kind = 'color', color = '2b3a55', color2 = '182038', accent = 'ffffff', text = '', importer = 'video-tool' } = {}) {
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
    authorization: { usage: 'background', generated: true },
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
  if (!IMAGE_EXTS.has(ext)) throw pyFail('VIDEO_ASSET_BAD_TYPE', `阶段一只收图片素材（${[...IMAGE_EXTS].join(' ')}），收到 ${ext || '(无扩展名)'}`);
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
  if (!ASSET_KINDS.includes(kind)) throw pyFail('VIDEO_ASSET_BAD_KIND', `素材 kind 只能是 ${ASSET_KINDS.join('/')}`);
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
  const full = path.join(root, 'assets', asset.relativePath);
  if (!fs.existsSync(full)) {
    const error = new Error(`素材文件缺失：${asset.relativePath}`);
    error.code = 'VIDEO_ASSET_FILE_MISSING';
    throw error;
  }
  return { asset, file: full };
}
