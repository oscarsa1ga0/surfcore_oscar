import fs from 'node:fs';
import path from 'node:path';
import { accountBili } from '../../tools/lib/state-paths.mjs';

const API = 'https://api.bilibili.com';
const MEMBER = 'https://member.bilibili.com';
const PROFILE = 'ugcfx/bup';
export const BV_RE = /^BV[0-9A-Za-z]{10}$/;
export const AI_STATEMENT_ID = 1;

export function publishError(code, message, hint, extra = {}) {
  return Object.assign(new Error(message), { code, hint, ...extra });
}

export function readFishLogin() {
  try { return JSON.parse(fs.readFileSync(accountBili('credentials.json'), 'utf8')); }
  catch { return {}; }
}

function authError() {
  return publishError('VIDEO_BILI_LOGIN', '鱼姬的 B 站登录凭据无效或已过期', '到 B 站设置重新扫码，用同一账号恢复任务');
}

function remoteError(stage, status) {
  return publishError('VIDEO_BILI_REMOTE', `B 站在「${stage}」返回异常（${status}）`,
    '检查创作中心登录、分区和风控提示，处理后再刷新', { retryable: status === 429 || status >= 500 });
}

function uposUrl(session) {
  let url;
  try { url = new URL(session.endpoint?.startsWith('//') ? `https:${session.endpoint}` : session.endpoint); }
  catch { throw publishError('VIDEO_BILI_UPLOAD_HOST', '上传地址无法解析', '到创作中心检查网络和线路'); }
  if (url.protocol !== 'https:' || !/^upos[-a-z0-9.]*\.bilivideo\.com$/i.test(url.hostname)
    || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash
    || !/^upos:\/\/[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+\.mp4$/.test(session.uri)
    || session.uri.slice(7).split('/').some((segment) => !segment || segment === '..' || segment === '.')) {
    throw publishError('VIDEO_BILI_UPLOAD_HOST', '上传地址不符合 B 站 UPOS 格式', '在创作中心检查，或导出后手动投稿');
  }
  return new URL(`/${session.uri.slice(7)}`, url);
}

function urlWith(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

function accountHeaders(login) {
  const values = [['SESSDATA', login.sessdata], ['bili_jct', login.bili_jct], ['buvid3', login.buvid3]];
  if (!values[0][1] || !values[1][1] || values.some(([, value]) => value && /[\r\n;]/.test(value))) throw authError();
  return {
    'user-agent': 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36',
    origin: MEMBER, referer: `${MEMBER}/platform/upload/video/frame`,
    cookie: values.filter(([, value]) => value).map(([key, value]) => `${key}=${value}`).join('; '),
  };
}

function archiveView(entry) {
  const archive = entry?.Archive ?? entry?.archive ?? entry ?? {};
  const videos = entry?.Videos ?? entry?.videos ?? archive.videos ?? [];
  const reason = archive.reject_reason ?? archive.rejectReason ?? entry?.reject_reason ?? '';
  const rawState = archive.state == null ? null : Number(archive.state);
  const state = rawState === -100 ? 'withdrawn' : reason || [-2, -3].includes(rawState) ? 'rejected'
    : rawState === -30 || rawState === -6 ? 'processing' : 'reviewing';
  return {
    archiveId: /^\d+$/.test(String(archive.aid ?? '')) ? String(archive.aid) : null,
    bvid: BV_RE.test(archive.bvid ?? '') ? archive.bvid : null,
    videos: Array.isArray(videos) ? videos : [],
    state, rawState,
    title: String(archive.title ?? ''),
    tid: Number(archive.tid),
    copyright: Number(archive.copyright),
    aiMarked: Number((archive.creation_statement ?? entry?.creation_statement)?.id) === AI_STATEMENT_ID,
    reason: typeof reason === 'string' ? reason.replace(/https?:\/\/\S+/gu, '[链接]').slice(0, 180) : '',
  };
}

function sameMedia(item, media) {
  if (item.videos.length !== 1) return false;
  const video = item.videos[0];
  const cid = String(video.cid ?? '');
  const filename = String(video.filename ?? '').replace(/\.mp4$/, '');
  return Boolean((media.cid && cid && String(media.cid) === cid) || (media.filename && filename === media.filename))
    && !(media.cid && cid && String(media.cid) !== cid)
    && !(media.filename && filename && media.filename !== filename);
}

export function createBiliVideoAdapter({ login = readFishLogin(), fetchImpl = fetch, signal } = {}) {
  const headers = () => accountHeaders(login);
  async function request(url, stage, init = {}) {
    let response;
    try {
      const timeout = AbortSignal.timeout(45_000);
      response = await fetchImpl(url, {
        ...init, redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch {
      throw publishError('VIDEO_BILI_NETWORK', `「${stage}」未收到 B 站响应`, '检查网络后刷新任务', { retryable: true });
    }
    if (!response.ok) {
      if (init.headers?.['x-upos-auth'] && [401, 403, 404, 410].includes(response.status)) {
        throw publishError('VIDEO_UPOS_EXPIRED', '分片上传会话已失效', '会重新上传同一个成片',
          { retryable: true, resetUpload: true });
      }
      const error = remoteError(stage, response.status);
      await response.body?.cancel().catch(() => {});
      const retry = response.headers.get('retry-after');
      if (retry) error.retryAfterMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now());
      throw error;
    }
    return response;
  }

  async function json(url, stage, init) {
    const response = await request(url, stage, init);
    try { return await response.json(); }
    catch { throw remoteError(stage, '返回格式'); }
  }

  async function member(route, params = {}, init = {}) {
    const result = await json(urlWith(`${MEMBER}${route}`, params), route,
      { ...init, headers: { ...headers(), ...init.headers } });
    if ([-101, -111].includes(result?.code)) throw authError();
    if (result?.code !== 0) throw remoteError(route, Number(result?.code) || '接口格式');
    return result.data;
  }

  async function archives(page = 1) {
    const data = await member('/x/web/archives', { status: 'all', pn: page, ps: 20 });
    const entries = data?.arc_audits ?? data?.list ?? data?.archives;
    return (Array.isArray(entries) ? entries : []).map(archiveView);
  }

  async function creatorDetail(query) {
    try {
      return archiveView(await member('/x/web/archive/view', query));
    } catch (error) {
      if (!query.aid || error.code === 'VIDEO_BILI_LOGIN' || error.retryable) throw error;
      return archiveView(await member('/x/web/archive/videos', { aid: query.aid }));
    }
  }

  return {
    async verifyAccount(expectedMid) {
      const out = await json(`${API}/x/web-interface/nav`, '核对账号', { headers: headers() });
      if (out?.code !== 0 || !out.data?.isLogin) throw authError();
      const mid = String(out.data.mid ?? '');
      if (!mid || mid !== expectedMid || (login.mid && String(login.mid) !== mid)) {
        throw publishError('VIDEO_ACCOUNT_CHANGED', '当前登录账号与投稿绑定的鱼姬账号不一致', '切回原来的鱼姬账号再继续');
      }
    },

    async validateSubmission({ tid }) {
      const data = await member('/x/vupre/web/archive/human/type2/list');
      const find = (value) => Array.isArray(value) ? value.some(find)
        : value && typeof value === 'object'
          && (Number(value.id ?? value.tid) === tid || Object.values(value).some(find));
      if (!find(data?.type_list)) throw publishError('VIDEO_BILI_CATEGORY', 'B 站未返回本稿所选分区', '按创作中心当前可用分区修改稿件后重新确认');
    },

    async beginUpload(size) {
      const pre = await json(urlWith(`${MEMBER}/preupload`, { name: 'final.mp4', size, r: 'upos', profile: PROFILE,
        ssl: 0, version: '2.10.4.0', build: 2140000 }), '预上传', { headers: headers() });
      const session = { endpoint: pre?.endpoint, uri: pre?.upos_uri, auth: pre?.auth, cid: String(pre?.biz_id ?? ''),
        chunkSize: Number(pre?.chunk_size), size };
      if (pre?.OK !== 1 || !session.auth || !/^\d+$/.test(session.cid) || !Number.isInteger(session.chunkSize)
        || session.chunkSize < 64 * 1024 || session.chunkSize > 32 * 1024 ** 2) throw remoteError('预上传', '接口格式');
      const result = await json(urlWith(uposUrl(session), { uploads: '', output: 'json', profile: PROFILE,
        filesize: size, partsize: session.chunkSize, biz_id: session.cid }), '开启分片',
      { method: 'POST', headers: { 'x-upos-auth': session.auth } });
      if (result?.OK !== 1 || !result.upload_id) throw remoteError('开启分片', '接口格式');
      return { ...session, uploadId: result.upload_id };
    },

    async putPart(session, index, bytes) {
      const start = index * session.chunkSize;
      const url = urlWith(uposUrl(session), { uploadId: session.uploadId,
        chunks: Math.ceil(session.size / session.chunkSize), total: session.size, chunk: index,
        size: bytes.length, partNumber: index + 1, start, end: start + bytes.length });
      const result = await request(url, '上传分片', { method: 'PUT', body: bytes,
        headers: { 'x-upos-auth': session.auth, 'content-type': 'application/octet-stream' } });
      if (result.status !== 200) throw remoteError('上传分片', result.status);
      // Some UPOS routes acknowledge each successful PUT with HTTP 200 only.
      const etag = result.headers.get('etag')?.replace(/^"|"$/g, '') || 'etag';
      await result.body?.cancel();
      return { partNumber: index + 1, eTag: etag };
    },

    async completeUpload(session, parts) {
      const name = path.posix.basename(session.uri);
      const result = await json(urlWith(uposUrl(session), { name, uploadId: session.uploadId,
        biz_id: session.cid, output: 'json', profile: PROFILE }), '合并分片',
      { method: 'POST', headers: { 'x-upos-auth': session.auth, 'content-type': 'application/json' },
        body: JSON.stringify({ parts }) });
      if (result?.OK !== 1) throw remoteError('合并分片', '接口格式');
      return { filename: name.replace(/\.mp4$/, ''), cid: session.cid };
    },

    async uploadCover(bytes) {
      const csrf = login.bili_jct;
      const data = await member('/x/vu/web/cover/up', { ts: Date.now() }, { method: 'POST',
        body: new URLSearchParams({ csrf, cover: `data:image/png;base64,${bytes.toString('base64')}` }) });
      if (!/^https:\/\/[a-z0-9.-]+\.hdslb\.com\//i.test(data?.url ?? '')) throw remoteError('上传封面', '封面地址');
      return data.url;
    },

    async submit(metadata, media) {
      const csrf = login.bili_jct;
      const data = await member('/x/vu/web/add/v3', { t: Date.now(), csrf }, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          csrf, title: metadata.title, desc: metadata.description, tid: metadata.tid,
          tag: metadata.tags.join(','), copyright: metadata.copyright, source: metadata.source,
          cover: media.cover, videos: [{ filename: media.filename, title: metadata.title, desc: '', cid: Number(media.cid) }],
          creation_statement: { id: AI_STATEMENT_ID }, dynamic: '', desc_format_id: 9999,
          recreate: -1, subtitle: { open: 0, lan: '' }, web_os: 3,
        }),
      });
      const archiveId = /^\d+$/.test(String(data?.aid ?? '')) ? String(data.aid) : null;
      const bvid = BV_RE.test(data?.bvid ?? '') ? data.bvid : null;
      if (!archiveId && !bvid) throw remoteError('确认投稿回执', '缺稿件编号');
      return { archiveId, bvid };
    },

    async getArchive(receipt, accountMid) {
      const query = receipt.bvid ? { bvid: receipt.bvid } : { aid: receipt.archiveId };
      let creator = null;
      try {
        const detailed = await creatorDetail(receipt.archiveId ? { aid: receipt.archiveId } : query);
        if ((receipt.archiveId && detailed.archiveId === receipt.archiveId) || (receipt.bvid && detailed.bvid === receipt.bvid)) creator = detailed;
      } catch {}
      if (!creator?.aiMarked && !['rejected', 'withdrawn'].includes(creator?.state)) {
        const match = (await archives().catch(() => [])).find((item) => (receipt.archiveId && item.archiveId === receipt.archiveId)
          || (receipt.bvid && item.bvid === receipt.bvid));
        if (match?.aiMarked || !creator || ['rejected', 'withdrawn'].includes(match?.state)) creator = match ?? creator;
      }
      if (creator && ['rejected', 'withdrawn'].includes(creator.state)) return creator;
      const out = await json(urlWith(`${API}/x/web-interface/view`, query), '查询公开视频');
      if (out?.code === 0 && out.data?.state != null && Number(out.data.state) === 0 && String(out.data?.owner?.mid) === accountMid
        && BV_RE.test(out.data?.bvid ?? '') && (!receipt.bvid || out.data.bvid === receipt.bvid)
        && (!receipt.archiveId || String(out.data.aid) === receipt.archiveId)) {
        return { ...creator, state: 'published', bvid: out.data.bvid, archiveId: String(out.data.aid),
          cover: /^https:\/\/[a-z0-9.-]+\.hdslb\.com\//i.test(out.data.pic ?? '') ? out.data.pic : '',
          publishedAt: Number.isFinite(Number(out.data.pubdate)) && Number(out.data.pubdate) > 0 ? new Date(Number(out.data.pubdate) * 1000).toISOString() : null };
      }
      if (out?.code === 0) throw publishError('VIDEO_BILI_ARCHIVE_MISMATCH', '公开稿件身份或状态不一致', '到创作中心核对稿件和账号');
      if (out?.code !== -404 && out?.code !== 62002) throw remoteError('查询公开视频', out?.code ?? '接口格式');
      return creator ?? { state: 'reviewing', rawState: null };
    },

    async reconcile(media, expected, knownBvid = null) {
      if (BV_RE.test(knownBvid ?? '')) {
        let item = await creatorDetail({ bvid: knownBvid }).catch(() => null);
        if (!item?.archiveId) {
          const found = await json(urlWith(`${API}/x/web-interface/view`, { bvid: knownBvid }), '按 BV 核对');
          if (found?.code === 0 && found.data?.aid && found.data.bvid === knownBvid) {
            item = await creatorDetail({ aid: String(found.data.aid) }).catch(() => null);
          }
        }
        if (item && (!item.bvid || item.bvid === knownBvid) && sameMedia(item, media)) return item;
      }
      for (let page = 1; page <= 2; page += 1) {
        const items = await archives(page);
        for (const item of items) {
          if (sameMedia(item, media)) return item;
          if (!item.archiveId || item.title !== expected.title) continue;
          try {
            const detail = await creatorDetail({ aid: item.archiveId });
            if (detail.archiveId === item.archiveId && sameMedia(detail, media)) return detail;
          } catch {}
        }
        if (items.length < 20) break;
      }
      return null;
    },
  };
}
