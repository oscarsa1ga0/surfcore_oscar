// QQ 空间（Qzone）NapCat 扩展 action 封装 —— 只做「请求 + 参数归一 + 结果整形」，
// 不写状态、不落盘、不做权限判断（权限在 qzone-gate.js / bridge 路由里）。
//
// 网关：NapCat 4.18.42（OneBot v11 HTTP，config.json → snowluma.httpUrl / accessToken）。
// 注意：Qzone action 不属于 OneBot v11 标准，是 NapCat 扩展；换网关前必须先探测（probe()）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export function qzoneGatewayConfig() {
  try {
    const text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    const c = JSON.parse(text);
    return {
      httpUrl: String(c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
      token: String(c.snowluma?.accessToken ?? '')
    };
  } catch {
    return { httpUrl: 'http://127.0.0.1:3000', token: '' };
  }
}

const stripHtml = (raw) => {
  const s = String(raw ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\[em\][^[]*\[\/em\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
};

/**
 * 底层调用。返回 {ok:true,data} 或 {ok:false, code, wording, message, action}。
 * 超时默认 20s（说说上传可能更久，publish 单独给 90s）。
 */
export async function qzoneCall(action, params = {}, { timeoutMs = 20000 } = {}) {
  const { httpUrl, token } = qzoneGatewayConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params ?? {}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    return { ok: false, code: res.status, message: `HTTP ${res.status}`, action, hint: res.status === 426 ? 'httpUrl 可能指向了 WS 端口' : '' };
  }
  if (!body || body.status !== 'ok' || body.retcode !== 0) {
    return {
      ok: false,
      code: body?.retcode ?? -1,
      message: String(body?.wording ?? body?.message ?? '未知错误'),
      action
    };
  }
  return { ok: true, data: body.data, action };
}

const q = (v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v.trim() === '' ? undefined : v.trim();
  return v;
};

export const QZONE_RIGHTS = [1, 4, 16, 64, 128];
export const QZONE_RIGHT_LABELS = { 1: '所有人', 4: '好友', 16: '部分好友', 64: '仅自己', 128: '部分好友不可见' };

/** 把 NapCat msglist 条目整形为统一的公开形状。 */
export function normalizePostItem(raw = {}) {
  return {
    tid: q(raw.tid) ?? q(raw.id) ?? '',
    authorUin: q(raw.uin ?? raw.author_uin ?? raw.user_id) ?? '',
    nickname: stripHtml(raw.nickname ?? raw.nick),
    content: q(raw.content) ?? '',
    html: q(raw.html) ?? '',
    time: Number(raw.time ?? raw.createTime ?? 0) || 0,
    commentNum: Number(raw.comment_num ?? raw.commentNum ?? 0) || 0,
    likeNum: Number(raw.like_num ?? raw.likeNum ?? 0) || 0,
    isPrivate: raw.is_private === true || Number(raw.is_private) === 1,
    images: Array.isArray(raw.images) ? raw.images.slice(0, 9).map(String) : [],
    feedRef: raw.feed_ref && typeof raw.feed_ref === 'object' ? raw.feed_ref : undefined,
    raw: undefined
  };
}

/** 好友动态（get_qzone_feeds）条目整形。 */
export function normalizeFeedItem(raw = {}) {
  return {
    tid: q(raw.tid) ?? q(raw.key) ?? '',
    authorUin: q(raw.uin ?? raw.user_id) ?? '',
    nickname: stripHtml(raw.nickname),
    time: Number(raw.time ?? 0) || 0,
    appid: q(raw.appid) ?? '',
    content: q(raw.content) ?? stripHtml(raw.html),
    images: Array.isArray(raw.images) ? raw.images.slice(0, 9).map(String) : [],
    feedRef: raw.feed_ref && typeof raw.feed_ref === 'object' ? raw.feed_ref : undefined
  };
}

export async function getQzoneMsgList({ targetUin = '', pos = 0, num = 20, format = 'snowluma' } = {}) {
  const params = { format };
  if (q(targetUin)) params.target_uin = String(targetUin);
  params.pos = Number(pos) || 0;
  params.num = Math.min(100, Math.max(1, Number(num) || 20));
  const r = await qzoneCall('get_qzone_msg_list', params);
  if (!r.ok) return r;
  const data = r.data && typeof r.data === 'object' ? r.data : {};
  const list = Array.isArray(data.msglist) ? data.msglist : [];
  return {
    ok: true,
    total: Number(data.total ?? list.length) || 0,
    items: list.map(normalizePostItem),
    nextCursor: q(data.next_cursor) ?? '',
    raw: data
  };
}

export async function getQzoneFeeds({ pageNum = 1, count = 10, cursor = '', format = 'snowluma' } = {}) {
  const params = { format };
  params.page_num = Number(pageNum) || 1;
  params.count = Math.min(50, Math.max(1, Number(count) || 10));
  if (q(cursor)) params.cursor = String(cursor);
  const r = await qzoneCall('get_qzone_feeds', params);
  if (!r.ok) return r;
  const data = r.data && typeof r.data === 'object' ? r.data : {};
  const list = Array.isArray(data.feeds) ? data.feeds : [];
  return {
    ok: true,
    items: list.map(normalizeFeedItem),
    nextCursor: q(data.next_cursor) ?? '',
    raw: data
  };
}

export async function getQzoneMsgDetail({ tid, targetUin = '' } = {}) {
  if (!q(tid)) return { ok: false, code: 400, message: 'tid 不能为空', action: 'get_qzone_msg_detail' };
  const params = { tid: String(tid) };
  if (q(targetUin)) params.target_uin = String(targetUin);
  const r = await qzoneCall('get_qzone_msg_detail', params);
  if (!r.ok) return r;
  const data = r.data && typeof r.data === 'object' ? r.data : {};
  const comments = Array.isArray(data.comments) ? data.comments : [];
  return {
    ok: true,
    tid: q(data.tid) ?? String(tid),
    content: q(data.content) ?? '',
    images: Array.isArray(data.images) ? data.images.slice(0, 9).map(String) : [],
    commentNum: Number(data.comment_num ?? 0) || 0,
    likeNum: Number(data.like_num ?? 0) || 0,
    comments: comments.map((c) => ({
      id: q(c.id ?? c.comment_id) ?? '',
      uin: q(c.uin ?? c.user?.uin ?? c.comment_uin) ?? '',
      nick: q(c.nick ?? c.user?.nick) ?? '',
      content: q(c.content) ?? '',
      time: Number(c.time ?? 0) || 0,
      replyTo: q(c.reply_user?.uin) ?? '',
      raw: c
    })),
    raw: data
  };
}

/** 点赞 / 取消点赞。unlike=true 调 unlike_qzone。feedRef 尽量原样传回（从列表/详情拿）。 */
export async function likeQzone({ tid, targetUin = '', unlike = false, feedRef } = {}) {
  if (!q(tid)) return { ok: false, code: 400, message: 'tid 不能为空', action: unlike ? 'unlike_qzone' : 'like_qzone' };
  const params = { tid: String(tid) };
  if (q(targetUin)) params.target_uin = String(targetUin);
  if (feedRef && typeof feedRef === 'object') params.feed_ref = feedRef;
  return qzoneCall(unlike ? 'unlike_qzone' : 'like_qzone', params);
}

/**
 * 评论 / 回复楼中楼。
 * 顶层评论：{tid, targetUin, content}；
 * 回复：额外传 commentId + commentUin + comment（详情 comments 里的完整父评论对象），
 *       replyUser 是父评论作者（{uin,nick} 形状，能拿就带上）。
 */
export async function commentQzone({ tid, targetUin = '', content, commentId = '', commentUin = '', comment, replyUser } = {}) {
  if (!q(tid)) return { ok: false, code: 400, message: 'tid 不能为空', action: 'comment_qzone' };
  if (!q(content)) return { ok: false, code: 400, message: '评论内容不能为空', action: 'comment_qzone' };
  const params = { tid: String(tid), content: String(content) };
  if (q(targetUin)) params.target_uin = String(targetUin);
  if (q(commentId)) params.comment_id = String(commentId);
  if (q(commentUin)) params.comment_uin = String(commentUin);
  if (comment && typeof comment === 'object') params.comment = comment;
  if (replyUser && typeof replyUser === 'object') params.reply_user = replyUser;
  const r = await qzoneCall('comment_qzone', params);
  if (!r.ok) return r;
  return { ok: true, commentId: q(r.data?.comment_id) ?? '', raw: r.data };
}

/** 发表说说。images 支持 file:// / http(s):// / base64://（NapCat 自动上传）。 */
export async function sendQzoneMsg({ content, images = [], ugcRight = 1, targetUins = [] } = {}) {
  if (!q(content)) return { ok: false, code: 400, message: '说说内容不能为空', action: 'send_qzone_msg' };
  const params = { content: String(content) };
  if (Array.isArray(images) && images.length) params.images = images.slice(0, 9).map(String);
  const right = Number(ugcRight);
  params.ugc_right = QZONE_RIGHTS.includes(right) ? right : 1;
  if (right === 16 || right === 128) {
    params.target_uins = (Array.isArray(targetUins) ? targetUins : []).map(String).filter((x) => /^[1-9]\d*$/.test(x));
  }
  const r = await qzoneCall('send_qzone_msg', params, { timeoutMs: 90000 });
  if (!r.ok) return r;
  return { ok: true, tid: q(r.data?.tid) ?? '', time: Number(r.data?.time ?? 0) || 0, raw: r.data };
}

export async function deleteQzoneMsg({ tid } = {}) {
  if (!q(tid)) return { ok: false, code: 400, message: 'tid 不能为空', action: 'delete_qzone_msg' };
  return qzoneCall('delete_qzone_msg', { tid: String(tid) });
}

export async function setQzoneMsgRight({ tid, ugcRight, targetUins = [] } = {}) {
  if (!q(tid)) return { ok: false, code: 400, message: 'tid 不能为空', action: 'set_qzone_msg_right' };
  const right = Number(ugcRight);
  if (!QZONE_RIGHTS.includes(right)) return { ok: false, code: 400, message: 'ugcRight 必须是 1/4/16/64/128', action: 'set_qzone_msg_right' };
  const params = { tid: String(tid), ugc_right: right };
  if (right === 16 || right === 128) {
    params.target_uins = (Array.isArray(targetUins) ? targetUins : []).map(String).filter((x) => /^[1-9]\d*$/.test(x));
  }
  const r = await qzoneCall('set_qzone_msg_right', params);
  if (!r.ok) return r;
  return { ok: true, ugcRight: Number(r.data?.ugc_right) || right, raw: r.data };
}

/** 探测网关能力（只读）：版本 + 拉一次自己的说说列表。 */
export async function probeQzoneGateway() {
  const version = await qzoneCall('get_version_info', {});
  const selfList = await getQzoneMsgList({ pos: 0, num: 1 });
  return {
    ok: version.ok && selfList.ok,
    appName: String(version.ok ? version.data?.app_name ?? '' : ''),
    appVersion: String(version.ok ? version.data?.app_version ?? '' : ''),
    versionOk: version.ok,
    listOk: selfList.ok,
    error: !version.ok ? version.message : (!selfList.ok ? selfList.message : ''),
    sampleCount: selfList.ok ? selfList.total : 0
  };
}
