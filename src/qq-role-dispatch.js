import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { isLoopbackBaseUrl } from './dsh-port.js';
import { deepWellFormed } from './safe-text.js';
import { QQ_DISPATCH_ROUTE, dispatchError, roleRef } from '../plugins/surfcore/lib/role-dispatch.js';

export function usesLocalDispatch(root, dshHome, env) {
  if (env.SURFCORE_ROLE_DISPATCH === '1') return true;
  try {
    return fs.realpathSync(path.join(dshHome, 'plugins', 'surfcore'))
      === fs.realpathSync(path.join(root, 'plugins', 'surfcore'));
  } catch {
    return false;
  }
}

/** Hold only a task reference in SurfCore until the bridge is ready to build the prompt. */
export function createQqRoleDispatch({ api, getBaseUrl, getToken, getCharacter, expectedCharacter = getCharacter(), enabled, log = () => {} }) {
  async function call(payload, timeoutMs = 8000) {
    const base = getBaseUrl();
    if (!isLoopbackBaseUrl(base)) throw dispatchError('ROLE_DISPATCH_REMOTE', '串行调度需要连接本机 DSH');
    const token = getToken();
    if (!token) throw dispatchError('ROLE_DISPATCH_UNAVAILABLE', '桥接调度鉴权尚未就绪');
    let response;
    try {
      response = await api.doFetch(new URL(QQ_DISPATCH_ROUTE, base), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': token },
        body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw dispatchError('ROLE_DISPATCH_UNAVAILABLE', '暂时无法连接 SurfCore 调度器');
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      throw dispatchError(body?.code || 'ROLE_DISPATCH_UNAVAILABLE', body?.error || 'SurfCore 调度器暂不可用', body?.hint);
    }
    return body;
  }

  return async function withQqDispatch({ id, priority, stillCurrent = () => true }, run) {
    if (!enabled) return run((prompt) => api.sessions.prompt(prompt));
    const role = roleRef(expectedCharacter);
    const request = { id, role };
    let committed = false;
    const assertCurrent = () => {
      const current = roleRef(getCharacter());
      if (!stillCurrent() || current.characterId !== role.characterId || current.epoch !== role.epoch) {
        throw dispatchError('ROLE_DISPATCH_ROLE_CHANGED', 'QQ 会话或角色已经切换，本次投递已失效');
      }
    };
    const base = getBaseUrl();
    if (!isLoopbackBaseUrl(base)) throw dispatchError('ROLE_DISPATCH_REMOTE', '串行调度需要连接本机 DSH');
    try {
      let reported = false;
      for (;;) {
        assertCurrent();
        let reply;
        try {
          reply = await call({ ...request, action: 'reserve', priority });
        } catch (error) {
          if (error?.code !== 'ROLE_DISPATCH_UNAVAILABLE' && error?.code !== 'ROLE_DISPATCH_FULL') throw error;
          if (!reported) log(`[role-dispatch] QQ 等待调度服务：${error.code}`);
          reported = true;
        }
        if (reply?.state === 'granted') break;
        if (reply?.state === 'in-flight') throw dispatchError('ROLE_DISPATCH_UNCERTAIN', 'QQ 回合已提交，等待 DSH 核对');
        await wait(reply ? 400 : 1500);
      }
      assertCurrent();
      return await run(async (prompt) => {
        assertCurrent();
        try {
          const response = await call({ ...request, action: 'submit', prompt: deepWellFormed(prompt) }, 120_000);
          committed = true;
          return response.result;
        } catch (error) {
          if (error?.code !== 'ROLE_DISPATCH_UNAVAILABLE' && error?.code !== 'ROLE_DISPATCH_FAILED') throw error;
          const receipt = await call({ ...request, action: 'receipt' }).catch(() => null);
          if (receipt?.state === 'received') {
            committed = true;
            return receipt.result;
          }
          throw dispatchError('ROLE_DISPATCH_UNCERTAIN', 'QQ 投递回执丢失，等待 DSH 对账');
        }
      });
    } finally {
      if (!committed) void call({ ...request, action: 'release' }).catch(() => {});
    }
  };
}
