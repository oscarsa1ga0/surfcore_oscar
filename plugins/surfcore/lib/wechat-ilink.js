// iLink transport for a self-bound WeChat bot. No DSH or character state here.
// Wire format: https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
import { randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_ORIGIN = 'https://ilinkai.weixin.qq.com';
const CLIENT_VERSION = (3 << 16) + 1;
const BASE_INFO = { channel_version: '3.0.1/surfcore', bot_agent: 'SurfCore' };

export class ILinkError extends Error {
  constructor(code, error, hint) {
    super(error);
    this.code = code;
    this.hint = hint;
  }
}

function wechatOrigin(value = DEFAULT_ORIGIN) {
  const url = new URL(String(value).includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !url.hostname.endsWith('.weixin.qq.com')) {
    throw new ILinkError('wechat.origin', '微信返回了无法信任的接入地址', '重新获取二维码');
  }
  return url.origin;
}

async function request(path, { origin = DEFAULT_ORIGIN, token, body, signal, timeout = 35000 } = {}) {
  const headers = {
    Accept: 'application/json',
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(CLIENT_VERSION),
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers.AuthorizationType = 'ilink_bot_token';
    headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const deadline = AbortSignal.timeout(timeout);
  const response = await fetch(`${wechatOrigin(origin)}/ilink/bot/${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(token ? { ...body, base_info: BASE_INFO } : body) : undefined,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    redirect: 'error',
  });
  if (response.status === 401 || response.status === 403) {
    throw new ILinkError('wechat.auth', '微信连接已失效', '回到微信页重新扫码');
  }
  if (!response.ok) throw new ILinkError('wechat.http', `微信接口返回 HTTP ${response.status}`, '检查网络后重试');
  const data = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ILinkError('wechat.response', '微信接口响应格式异常', '稍后重试');
  }
  if (Number(data.ret) === -14 || Number(data.errcode) === -14) {
    throw new ILinkError('wechat.auth', '微信会话已失效', '回到微信页重新扫码');
  }
  const code = Number(data.ret || data.errcode || 0);
  if (code) throw new ILinkError('wechat.remote', `微信接口拒绝请求（${code}）`, '检查微信连接状态后重试');
  return data;
}

export function createILink() {
  return {
    qr: ({ signal } = {}) => request('get_bot_qrcode?bot_type=3', {
      body: { local_token_list: [] }, signal, timeout: 12000,
    }),
    qrStatus: ({ qr, origin, pin, signal }) => {
      const query = new URLSearchParams({ qrcode: qr });
      if (pin) query.set('verify_code', pin);
      return request(`get_qrcode_status?${query}`, { origin, signal });
    },
    credentials: (data) => {
      const account = {
        token: String(data.bot_token || ''),
        botId: String(data.ilink_bot_id || ''),
        ownerId: String(data.ilink_user_id || ''),
        origin: wechatOrigin(data.baseurl || DEFAULT_ORIGIN),
      };
      if (!account.token || !account.botId || !account.ownerId) {
        throw new ILinkError('wechat.bind', '微信未返回完整的账号绑定信息', '重新扫码绑定本人微信');
      }
      return account;
    },
    notify: ({ account, starting, signal }) => request(starting ? 'msg/notifystart' : 'msg/notifystop', {
      origin: account.origin, token: account.token, body: {}, signal, timeout: 6000,
    }),
    updates: ({ account, cursor, signal }) => request('getupdates', {
      origin: account.origin,
      token: account.token,
      body: { get_updates_buf: cursor },
      signal,
      timeout: 45000,
    }),
    send: ({ account, contextToken, text, signal }) => request('sendmessage', {
      origin: account.origin,
      token: account.token,
      body: { msg: {
        from_user_id: '',
        to_user_id: account.ownerId,
        client_id: `surfcore-${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      } },
      signal,
      timeout: 15000,
    }),
  };
}
