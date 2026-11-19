// 网页私聊的每轮上下文（和 QQ 唤醒提示词同源的部分原样保留，只换渠道相关段落）。
//
// 原则（2026-11-17 用户要求）：
//   · 人格卡、记忆卡、身份、反 AI 味、收尾规则 —— 和 QQ 用同一套措辞，不另写。
//   · 只替换渠道相关：此刻状态（网页读自己的消息）、发言方式（web_chat_send_message）、
//     收尾（web_chat_close）、没有 QQ 的未读/唤醒/潜水/表情/令牌。
//   · 以后改风格：先改这里，再同步回 QQ（QQ 停掉后这里就是唯一源）。

/** 和 QQ 唤醒提示词里的 antiAiLine 同一句。 */
export const ANTI_AI_LINE = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。';

/** 收尾判断：规则沿用 QQ，只把 qq_close_conversation 换成 web_chat_close。 */
export const CLOSURE_RULES = [
  '【对话收尾判断】先判断这段是否已经自然走到终点，再决定要不要开口。',
  '- 看：我最后一句是不是收尾式的；对方最后一句是提问/请求/有实质内容，还是只是附和/道别；我还有没有想说没说的；话题有没有闭环；有没有还没答的问题；节奏是不是疲了。',
  '- 可以收尾：不要再补一句，调用 web_chat_close（可带 summary / nextOpening）。对方再找你、开新话题仍会照常开始。',
  '- 还可以聊：正常回。不要用收尾逃避提问/求助，也不要每轮都收尾。',
].join('\n');

/** 首回复节奏：和 QQ 的 replyLine 同一句、同一套算法（从最后来信计时，还差多少静默）。 */
export function replyRhythm(messages = [], { now = Date.now(), quietMs } = {}) {
  const lastUser = [...messages].reverse().find((message) => message.author === 'user');
  const elapsed = lastUser?.at ? Math.max(0, now - Number(lastUser.at)) : 0;
  // 和 QQ 的 suggestQuietMsV2 同一套：默认 8000，没说完/15 秒内连发 3 条 → 12000，最小 10000。
  const burst = messages.filter((message) => message.author === 'user' && now - Number(message.at || 0) < 15000).length;
  const suggested = looksLikeUnfinished(lastUser?.text) || burst >= 3 ? 12000 : 8000;
  const quiet = Math.max(10000, Math.min(60000, Number(quietMs) || suggested));
  const remaining = Math.max(0, quiet - elapsed);
  return `【首回复节奏】先处理已有消息，完整的问题及时回答。需要确认对方是否继续补充时，用 web_chat_wait(purpose="reply", quietMs=${quiet})；从最后来信计时，合批和读提示词的耗时也算，目前还差约 ${Math.ceil(remaining / 1000)} 秒静默。已安静够久可直接回，工具也会立即返回并补上思考期间的新消息。只有明确没说完、你确实要等下文时，才用普通 messages 长等待。`;
}

/** 发言方式：网页里唯一的“发出去”的动作。 */
export const TRANSPORT_RULES = [
  '【网页发言】你的普通文字不会显示给主人，只是思考。要说话必须调用 web_chat_send_message：messages 必须是字符串数组（只发一条也写成 ["那句话"]），条与条之间由系统自动停顿；一次最多 8 条，普通对话默认 1 条、最多 2 条短句，不用 Markdown。表情包：web_chat_list_stickers 查编号，web_chat_send_sticker 发一张，文字另发；语音：web_chat_send_voice(text, tone, intensity) 现场说一句，偶尔发；引用某条消息：web_chat_send_message 传 replyTo（用【此刻状态】里的消息 id）；对方没说完用 web_chat_wait 等补完，每次最多 30 秒，整轮最多 2 分钟，收到 stopped 就接住已读内容并收尾；不想接或晚点再找他用 web_chat_dive。要看补发或历史图片，先用 web_chat_image_ticket，再使用 mcp__web-images__web_read_images(ticket)。语音只按实际提供的转写或附言理解。',
].join('\n');

import { buildStickerMatchHint, detectEmotions } from '../../../../src/sticker-semantics.js';
import { looksLikeUnfinished } from '../../../../src/v2-wait.js';
import { matchStickers } from './stickers.js';

const isMessage = (message) => message && (['user', 'assistant'].includes(message.author))
  && (String(message.text ?? '').trim() || message.attachments?.length || message.action);
const messageLabel = (message) => message.text || (message.action === 'sticker' ? '[表情]'
  : message.attachments?.[0]?.type?.startsWith('audio/') ? '[语音]' : '[图片]');

const isQuestion = (text) => /[?？]|吗|呢|怎么|为什么|哪|是不是/.test(String(text ?? ''));
const isClosing = (text) => /^(?:嗯+|好(?:的|吧|啊)?|行(?:吧|啊)?|ok|晚安|拜拜|睡了|去忙|下了)[啦呀喔哦～~。！!\s]*$/i.test(String(text ?? '').trim());
const clip = (text, max) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
};

/** 动态收尾评估：和 QQ 的 closurePromptBlock 同一个形状（对方最后一句/我最后一句/未答提问/疲劳）。 */
export function closureAssessment(messages = [], { now = Date.now(), thoughts = 0 } = {}) {
  const list = messages.filter(isMessage);
  const lastUser = [...list].reverse().find((message) => message.author === 'user');
  const lastSelf = [...list].reverse().find((message) => message.author === 'assistant');
  const label = (message) => {
    if (!message) return '暂无';
    if (isQuestion(message.text)) return '提问/请求';
    if (isClosing(message.text)) return '纯附和/应答';
    return '有实际内容';
  };
  const open = Boolean(lastUser && isQuestion(lastUser.text) && (!lastSelf || Number(lastSelf.at) < Number(lastUser.at)));
  const recent = list.filter((message) => now - Number(message.at || 0) < 10 * 60 * 1000);
  const fatigue = recent.length >= 20 ? '高' : recent.length >= 10 ? '中' : '低';
  const ownIntent = lastSelf && isQuestion(lastSelf.text) ? '高' : isClosing(lastSelf?.text) ? '低' : '中';
  const theirIntent = lastUser && isQuestion(lastUser.text) ? '高' : isClosing(lastUser?.text) ? '低' : '中';
  const closure = open ? '低' : isClosing(lastUser?.text) ? '高' : '中';
  const verdict = closure === '高' && ownIntent !== '高' ? '可以自然收尾' : '继续观察';
  return [
    '【对话收尾判断】先判断这段是否已经自然走到终点，再决定要不要开口。',
    `- 对方最后一句：${label(lastUser)}；我最后一句：${label(lastSelf)}。`,
    `- 我的继续意愿：${ownIntent}（想说没说的 ${Number(thoughts) || 0} 条）；对方的继续意愿：${theirIntent}；话题闭环：${closure}；节奏疲劳：${fatigue}。`,
    `- 未完成：${open ? '有未答的提问/请求' : '没有未答的提问'}。判断：${verdict}。`,
    '如果判断可以收尾：不要再补一句，调用一次 web_chat_close（可带 reason / summary / nextOpening / memorySummary / biliSummary）。其中 biliSummary 只写适合对外说的非敏感近况，省略身份、私聊原句、未公开日记和身份线索；需要保密就不填。如果还要聊就正常回；不要用收尾逃避提问/求助，也不要每轮都收尾。',
  ].join('\n');
}

/** 此刻状态：和 QQ 的 statusLine 同一格式（未读/最近一条/上次发言）。 */
export function webStatusLine({ messages = [], now = Date.now() } = {}) {
  const list = messages.filter(isMessage);
  const lastUser = [...list].reverse().find((message) => message.author === 'user');
  const lastSelf = [...list].reverse().find((message) => message.author === 'assistant');
  const bits = [];
  const unanswered = list.filter((message) => message.author === 'user'
    && (!lastSelf || Number(message.at || 0) > Number(lastSelf.at || 0))).length;
  bits.push(`未读 ${unanswered} 条`);
  if (lastUser) {
    const minutes = Math.max(0, Math.round((now - Number(lastUser.at || 0)) / 60000));
    bits.push(`最近一条来自 私聊：${clip(messageLabel(lastUser), 40)}${lastUser.id ? `（id=${lastUser.id}）` : ''}${minutes > 0 ? `（${minutes} 分钟前）` : ''}`);
  }
  if (lastSelf?.at) {
    const minutes = Math.max(0, Math.round((now - Number(lastSelf.at || 0)) / 60000));
    bits.push(minutes <= 0 ? '你刚说过话' : `你上次发言 ${minutes} 分钟前`);
  }
  return `【此刻状态】${bits.join('；')}`;
}

/** 表情匹配：和 QQ 同一个 rankStickers + buildStickerMatchHint，只把发送工具名换成网页版。 */
export function stickerHint(messages = [], entries) {
  const last = [...messages].reverse().find((message) => message && message.author === 'user'
    && String(message.text || '').trim().length >= 4);
  if (!last) return '';
  let hits = [];
  try { hits = matchStickers(String(last.text), { entries }); } catch { return ''; }
  if (!hits.length) return '';
  const moods = detectEmotions(String(last.text)).slice(0, 2).map((hit) => hit.label);
  return buildStickerMatchHint(hits, { moods, max: hits.length })
    .replaceAll('qq_send_sticker stickerId=', 'web_chat_send_sticker sticker=');
}

/**
 * 组装网页私聊的每轮上下文。
 * @param {object} input
 * @param {string} input.owner 主人称呼
 * @param {string} input.name 角色名
 * @param {string} [input.persona] 人格卡正文
 * @param {string} [input.memory] 记忆卡（web 可见范围）
 * @param {string} [input.status] 此刻状态（webStatusLine）
 * @param {string} [input.diary] 日记提示
 * @param {string} [input.recall] 向量召回
 */
export function buildWebPrompt({ owner = '主人', name = '鱼姬', persona = '', memory = '', briefing = '', status = '', diary = '', recall = '', messages = [], biliBrief = '', biliRecall = '', biliDiary = '', lightMemory = '', closureRecord = '', voice = '', stickerBlock = '', stickerEntries, thoughts = 0, now = new Date() } = {}) {
  const sticker = stickerHint(messages, stickerEntries);
  const assessment = messages.length ? closureAssessment(messages, { thoughts }) : '';
  return [
    `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（Asia/Shanghai）`,
    `【当前角色】${name}\n${persona}\n（完整角色卡 / 场景语气 / 推荐值 / 可用工具：由系统提供）`,
    `【你的身份】你在网页里的昵称是「${name}」。消息里出现「@${name}」、有人叫「${name}」、或引用你的消息，指的都是你 —— 不要当成别人。`,
    '【当前会话】网页私聊｜web',
    [
      '【来源判断】',
      '- 来源看载体，不要靠感觉：网页里的聊天只属于网页；合并转发/引用里的内容属于原平台，不是在这里发生的。',
      '- 不要把网页里的话说成「我在 QQ/群里说过」，也不要把 QQ/B站 的内容说成刚才在这里发生的。拿不准就问一句。',
      '- 【只用于自己】这些信息只用来自我识别：不要说出主人或别人的 QQ 号、B站 UID、账号关系。',
    ].join('\n'),
    [biliBrief, biliRecall].filter(Boolean).join('\n'),
    memory,
    briefing,
    biliDiary,
    diary,
    voice,
    ANTI_AI_LINE,
    assessment,
    closureRecord,
    stickerBlock,
    sticker,
    replyRhythm(messages, { now }),
    status,
    lightMemory,
    TRANSPORT_RULES,
    recall,
    '网页私聊只有对话类工具（日记、安全联网、发图、发言/收尾），没有本地命令和文件读写；B站、QQ 空间这类操作做不了，别编结果。',
  ].filter(Boolean).join('\n\n');
}
