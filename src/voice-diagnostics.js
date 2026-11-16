// 语音诊断：把「语音发不出去」拆成可判定的阶段与错误码。
//
// 为什么单独一个模块：桥接里 TTS 失败以前只抛一句人话，导致用户和模型都分不清
// 「上游挂了」「配置不全」「限流」——全部被转述成“TTS 没起来”。
// 这里只做纯函数，便于单测；真正的日志/重试在 bridge.js 里。

/** TTS/语音链路的错误分类。返回 { code, stage, hint }。 */
export function classifyVoiceError(message) {
  const text = String(message ?? '');
  const has = (re) => re.test(text);

  if (has(/频率超限|发送频率|rate.?limit/i)) {
    return {
      code: 'voice.rate-limited', stage: 'send',
      hint: '这是发送限流，不是 TTS 故障：等一会儿再发，或调大 socialV2.voice.maxPerMinute / maxPerHour',
    };
  }
  if (has(/没有配\s*\[voice\.characters\]|没有配映射|音色.*没配置|映射/i)) {
    return {
      code: 'voice.config-mapping', stage: 'config',
      hint: '音色名和语音包里的 [voice.characters] 对不上：到「语音」页确认当前角色名（不是音色 id）',
    };
  }
  if (has(/没起来|无法连接|ECONNREFUSED|连接被拒|fetch failed|WinError 10061/i)) {
    return {
      code: 'voice.service-down', stage: 'service',
      hint: '本地语音服务没在监听：到「语音」页点对应语音包的「启动」，或检查端口是否被占用',
    };
  }
  if (has(/401|403|鉴权|AppKey|Access.?Key|resource|余额|quota|欠费|未授权/i)) {
    return {
      code: 'voice.upstream-auth', stage: 'upstream',
      hint: '云端鉴权失败：检查 AppID / Access Key / resource id（seed-icl-2.0）是否有效、是否欠费',
    };
  }
  if (has(/TTS 服务返回\s*5\d\d|没有引擎能满足/i)) {
    return {
      code: 'voice.engine-failed', stage: 'engine',
      hint: '语音服务内部合成失败：看 voice-errors.log 里的 detail（引擎/上游），必要时重启语音包',
    };
  }

  if (has(/云端合成失败|网络\s*\？|timeout|TimeoutError|ETIMEDOUT|ENOTFOUND|5\d\d/i)) {
    return {
      code: 'voice.upstream-network', stage: 'upstream',
      hint: 'BreezeBlue 上游网络/服务异常：稍后重试；持续失败看 API Key 与额度',
    };
  }
  return {
    code: 'voice.unknown', stage: 'unknown',
    hint: '未分类的语音错误：把 voice-errors.log 最后一条发给开发者',
  };
}

/**
 * 云端失败时是否值得换一条路重试。
 * 只在“另一条路的地址不同、且本次失败属于可重试类别”时返回该 route，否则返回 ''。
 * 限流/配置错误换路也没用，不重试。
 */
export function pickFallbackRoute(primary, endpoints, errorCode) {
  const retryable = new Set(['voice.upstream-network', 'voice.upstream-auth', 'voice.service-down', 'voice.engine-failed']);
  if (!retryable.has(String(errorCode))) return '';
  const other = primary === 'cloud' ? 'local' : 'cloud';
  const a = String(endpoints?.[primary] ?? '').trim();
  const b = String(endpoints?.[other] ?? '').trim();
  if (!b || a === b) return '';
  return other;
}
