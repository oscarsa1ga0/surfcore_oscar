/** SurfCore's shared mood model. Event deltas and initial values are informed by Fish Heart (MIT). */
export const DIMENSIONS = Object.freeze({
  attachment: '依恋', curiosity: '好奇', reflection: '反刍', duty: '责任', social: '社交',
  fatigue: '疲惫', intimacy: '亲密', stress: '压力', joy: '喜悦',
});
export const BASELINE = Object.freeze({
  attachment: 45, curiosity: 55, reflection: 50, duty: 50, social: 45,
  fatigue: 20, intimacy: 40, stress: 15, joy: 50,
});
const DECAY = {
  attachment: .01, curiosity: .04, reflection: .03, duty: .03, social: .04,
  fatigue: .05, intimacy: .01, stress: .05, joy: .05,
};
export const EMOTION_SOURCES = Object.freeze({
  'qq-private': 'QQ 私聊', 'qq-group': 'QQ 群聊', bili: 'B 站', diary: '日记',
  pet: '桌宠', video: '视频创作', qzone: 'QQ 空间', native: 'DSH 角色会话',
});
export const MOOD_STAGES = Object.freeze({ calm: '日常', wronged: '委屈', angry: '生气', afraid: '害怕', avoidant: '回避' });

const EFFECTS = {
  chat: ['聊天', { social: 1.8, joy: 1, curiosity: .5, fatigue: .6, intimacy: .1 }],
  atmosphere: ['群聊气氛', { social: .8, fatigue: .3 }],
  share: ['收到分享', { curiosity: 2.5, joy: 1.6, social: .8 }],
  request: ['被请教', { duty: 4, social: 1, fatigue: 1.5 }],
  praise: ['被夸奖', { joy: 7, intimacy: 3.5, stress: -3, attachment: 1.6 }],
  softPraise: ['收到含蓄夸奖', { joy: 4, intimacy: 1.8, stress: -1.5, attachment: .8 }],
  praiseTired: ['连续被夸', { joy: 1.5, intimacy: .5, stress: .5 }],
  praiseBored: ['夸奖重复过多', { joy: -1, stress: 2 }],
  tease: ['一起接梗', { joy: 3, intimacy: 2, stress: -1 }],
  seeking: ['对方想亲近', { attachment: 3, intimacy: 3, joy: 2 }],
  goodnight: ['互道晚安', { attachment: 2, joy: 2 }],
  blameMild: ['受到责怪', { stress: 6, blame: 10, joy: -4, reflection: 2 }],
  blameMid: ['受到明显责怪', { stress: 12, blame: 25, joy: -8, reflection: 3, attachment: -1.5 }],
  blameHard: ['受到重责', { stress: 20, blame: 40, joy: -12, reflection: 5, attachment: -3 }],
  dismissive: ['对话中受到敷衍', { stress: 3, joy: -1, reflection: 1 }],
  fakeComfort: ['被敷衍地安慰', { stress: 4, joy: -3, reflection: 2, blame: 10 }],
  comfort: ['被安慰', { stress: -8, joy: 5, reflection: -5, attachment: 2 }],
  apology: ['收到道歉', { stress: -3, joy: 2, reflection: -3, attachment: 1 }],
  explain: ['对方解释了原因', { stress: -2, joy: 1, reflection: -2 }],
  proactive: ['主动开口', {}],
  quickReply: ['主动开口后收到回应', { attachment: 4, stress: -5, intimacy: 2, joy: 4 }],
  watch: ['了解了新的内容', { curiosity: 3, fatigue: 1 }],
  enjoyed: ['喜欢刚看过的内容', { curiosity: 3, joy: 6 }],
  response: ['收到或读到新的互动', { curiosity: 1.5, social: 2, joy: 1 }],
  reflected: ['写日记后有了新的想法', { reflection: 2 }],
  relieved: ['整理感受后释怀', { reflection: -5, stress: -6, joy: 2 }],
  unsettled: ['回顾后仍有些在意', { reflection: 4, stress: 3 }],
  progress: ['创作有了进展', { duty: 4, joy: 4, fatigue: 1 }],
  setback: ['创作遇到挫折', { duty: 2, stress: 6, fatigue: 2 }],
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const EVENT_RETENTION_MS = 7 * 24 * HOUR;
const clamp = (n) => Math.max(0, Math.min(100, n));
const number = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
export const isEmotionKind = (kind) => Object.hasOwn(EFFECTS, kind);

export function normalizeEmotionSettings(raw = {}) {
  return {
    enabled: raw?.enabled !== false,
    sources: Object.fromEntries(Object.keys(EMOTION_SOURCES).map((key) => [key, raw?.sources?.[key] !== false])),
    nativeWorkspaces: Array.isArray(raw?.nativeWorkspaces)
      ? raw.nativeWorkspaces.filter((item) => typeof item === 'string' && item.length < 1024).slice(0, 20)
      : [],
  };
}

export function createEmotionState(at = Date.now()) {
  return { version: 1, at, drives: { ...BASELINE }, conflicts: {}, awaiting: {}, heat: {}, speakers: {}, recent: [], seen: {} };
}

export function moodStage(blame) {
  if (blame >= 80) return 'avoidant';
  if (blame >= 70) return 'afraid';
  if (blame >= 55) return 'angry';
  if (blame >= 25) return 'wronged';
  return 'calm';
}

export function classifyEmotionText(text, { directed = true, media = false } = {}) {
  if (!directed) return 'atmosphere';
  const t = String(text || '').normalize('NFKC').trim().slice(0, 600);
  if (/^\s*\//.test(t) || !t && !media) return '';
  const directSecondPerson = /你|鱼姬|肥鱼|本鱼/.test(t);
  const inPlay = /哈哈|笑死|开玩笑|逗你|[🤣😂]|\[表情\]/u.test(t);
  const quoted = /(?:他说|她说|别人说|台词|原话|网上说|引用|转述|^\s*[「“"])/.test(t);
  if (!quoted && /(?:行了[，, ]*别闹|都说了别烦|随便你[，, ]*别来)/.test(t)) return 'fakeComfort';
  if (!quoted && /(?:对不起|我道歉|是我说重了|我不该那样说|刚才怪我)/.test(t)) return 'apology';
  if (!quoted && /(?:我刚才是因为|我刚才其实|我刚才说的是|我刚才没说清|我的意思其实|我刚才在忙)/.test(t)) return 'explain';
  if (!quoted && !inPlay && directSecondPerson) {
    if (/(?:你给我闭嘴|你(?:怎么|真的|真是)?(?:这么)?恶心|你真(?:没用|讨人厌)|你给我滚|我受够你了|别再来烦我)/.test(t)) return 'blameHard';
    if (/(?:你又.{0,10}(?:搞砸|惹我|骗人)|你(?:真烦|太烦了)|你(?:能不能|怎么又).{0,12}(?:闭嘴|别烦|瞎说|骗人))/.test(t)) return 'blameMid';
    if (/(?:你刚才.{0,12}(?:说得过分|有点过分|敷衍我)|我不喜欢你这样)/.test(t)) return 'blameMild';
  }
  if (!quoted && !inPlay && /^随便你[。！! ]*$/.test(t)) return 'dismissive';
  if (!quoted && /(?:抱抱我|想你了|想找你陪)/.test(t)) return 'seeking';
  if (!quoted && /(?:抱抱你|抱抱[!！。 ]*$|别难过|我在呢|别委屈)/.test(t)) return 'comfort';
  if (!quoted && /(?:谢谢你|谢谢[!！。 ]*$|你真棒|你真厉害|你做得真好|肥鱼厉害)/.test(t)) return 'praise';
  if (!quoted && /(?:真乖|真贴心|小棉袄)/.test(t)) return 'softPraise';
  if (inPlay) return 'tease';
  if (!quoted && /(?:晚安|先睡啦)/.test(t)) return 'goodnight';
  if (media || /https?:\/\/|你看这个|给你看/.test(t)) return 'share';
  if (!quoted && /帮我|拜托你|你能帮/.test(t)) return 'request';
  return 'chat';
}

function decayedConflict(item, at) {
  const age = Math.max(0, at - item.at);
  if (age >= 48 * HOUR) return null;
  const floor = item.knot && age < 24 * HOUR ? 40 : 0;
  const value = Math.max(floor, item.value - 8 * Math.floor(age / (6 * HOUR)));
  return value > 0 ? { ...item, value } : null;
}

export function projectEmotion(state, at = Date.now()) {
  const elapsed = Math.max(0, at - state.at);
  const ticks = elapsed / (45 * MINUTE);
  const drives = {};
  for (const [key, base] of Object.entries(BASELINE)) {
    drives[key] = clamp(base + (number(state.drives[key], base) - base) * (1 - DECAY[key]) ** ticks);
  }
  const coupling = 1 - Math.exp(-ticks / 4);
  drives.joy = clamp(drives.joy - Math.max(0, drives.stress - 45) * coupling * .32);
  drives.curiosity = clamp(drives.curiosity - Math.max(0, drives.fatigue - 55) * coupling * .28);
  if (drives.attachment > 70 && drives.intimacy < drives.attachment) {
    drives.intimacy += (drives.attachment - drives.intimacy) * coupling * .17;
  }
  if (drives.intimacy > 75 && drives.attachment < drives.intimacy) {
    drives.attachment += (drives.intimacy - drives.attachment) * coupling * .12;
  }
  if (elapsed >= 6 * HOUR) drives.fatigue = Math.min(35, drives.fatigue);
  const activeConflicts = Object.values(state.conflicts).filter(({ value, at: since }) => value >= 55 && state.at - since < 18 * HOUR);
  if (activeConflicts.length) {
    const activeTicks = Math.min(ticks, Math.max(...activeConflicts.map(({ at: since }) => (since + 18 * HOUR - state.at) / (45 * MINUTE))));
    for (const key of ['attachment', 'intimacy']) drives[key] = clamp(drives[key] - activeTicks * .15);
  }
  return drives;
}

function expectationFor(waiting, now) {
  if (!waiting) return 0;
  const hours = Math.max(0, now - waiting.at) / HOUR;
  return hours < 24 ? clamp(10 + hours * 4) : clamp(100 - (hours - 24) * 5);
}

/** Applies one observed event. Only verified dialogue events are allowed to address a conflict. */
export function applyEmotionEvent(state, event) {
  if (Object.hasOwn(state.seen, event.id) || !isEmotionKind(event.kind)) return false;
  const at = Math.max(state.at, event.at);
  const drives = projectEmotion(state, at);
  const partner = event.partner;
  const conflict = partner && Object.hasOwn(state.conflicts, partner)
    ? decayedConflict(state.conflicts[partner], at)
    : null;
  const oldBlame = conflict?.value || 0;
  const heatKind = ['praise', 'softPraise'].includes(event.kind) ? 'praise' : event.kind;
  const heatKey = `${event.source}:${partner || '_'}:${heatKind}`;
  const previous = (state.heat[heatKey] || []).filter((time) => at - time < 10 * MINUTE);
  const heat = 1 / (1 + previous.length / 12);
  state.heat[heatKey] = [...previous.slice(-47), at];
  for (const [key, entries] of Object.entries(state.heat)) {
    if (at - entries.at(-1) >= 10 * MINUTE) delete state.heat[key];
  }

  let kind = event.kind;
  if (heatKind === 'praise' && previous.length >= 2) kind = previous.length < 4 ? 'praiseTired' : 'praiseBored';
  const [reason, delta] = EFFECTS[kind];
  const weight = event.source === 'qq-group' ? (kind === 'atmosphere' ? .25 : (event.owner ? .8 : .55)) : 1;
  const effects = { ...delta };
  if (partner && event.channel) {
    if (event.source === 'qq-group' && event.inbound) {
      state.speakers ??= {};
      state.speakers[event.channel] = { partner, at };
      for (const [key, value] of Object.entries(state.speakers)) {
        if (at - value.at > EVENT_RETENTION_MS) delete state.speakers[key];
      }
    }
    const waiting = state.awaiting[event.channel];
    if (kind === 'proactive') state.awaiting[event.channel] = { at };
    else if (event.inbound && waiting && event.at >= waiting.at) {
      delete state.awaiting[event.channel];
      if (event.at - waiting.at <= 30 * MINUTE && !delta.blame) {
        for (const [key, value] of Object.entries(EFFECTS.quickReply[1])) effects[key] = (effects[key] || 0) + value;
      }
    }
  }

  const changed = {};
  for (const key of Object.keys(DIMENSIONS)) {
    if (!effects[key]) continue;
    const before = drives[key];
    // Positive gains slow near the ceiling; all changes remain bounded.
    const taper = effects[key] > 0 ? 1 - before / 100 : 1;
    drives[key] = clamp(before + effects[key] * weight * heat * taper);
    const actual = Math.round((drives[key] - before) * 10) / 10;
    if (actual) changed[key] = actual;
  }

  if (partner) {
    let blame = oldBlame;
    let repairs = conflict?.repairs || 0;
    if (delta.blame) {
      blame = Math.min(oldBlame < 55 ? 69 : 100, oldBlame + delta.blame * weight * heat);
      repairs = 0;
    } else if (oldBlame > 0) {
      const serious = kind === 'apology' || kind === 'explain';
      if (serious || (kind === 'comfort' && moodStage(oldBlame) !== 'angry')) {
        repairs += 1;
        if (oldBlame >= 70 && repairs < 2) blame = Math.max(70, oldBlame - 12);
        else blame = Math.max(0, oldBlame - (serious ? (repairs >= 2 ? 65 : 54) : 30));
      }
    }
    if (blame !== oldBlame || repairs !== (conflict?.repairs || 0)) {
      if (blame > 0) state.conflicts[partner] = { value: blame, at, repairs, knot: blame > 40, channel: event.channel, source: event.source };
      else delete state.conflicts[partner];
      changed.blame = Math.round((blame - oldBlame) * 10) / 10;
    }
  }

  state.drives = drives;
  state.at = at;
  state.seen[event.id] = at;
  for (const [id, time] of Object.entries(state.seen)) {
    if (at - time > EVENT_RETENTION_MS) delete state.seen[id];
  }
  for (const [id, item] of Object.entries(state.conflicts)) {
    if (!decayedConflict(item, at)) delete state.conflicts[id];
  }
  for (const [id, item] of Object.entries(state.awaiting)) {
    if (!(expectationFor(item, at) > 0)) delete state.awaiting[id];
  }
  if (Object.keys(changed).length || kind === 'proactive') {
    state.recent = [...state.recent.slice(-39), { at, source: event.source, reason, changed }];
  }
  return true;
}

export function emotionSnapshot(state, { source = '', partner = '', channel = '', now = Date.now(), aggregate = false } = {}) {
  const drives = projectEmotion(state, now);
  let conflict = partner && Object.hasOwn(state.conflicts, partner) ? decayedConflict(state.conflicts[partner], now) : null;
  if (conflict?.channel !== channel || !['qq-private', 'qq-group', 'pet'].includes(source)) conflict = null;
  if (source === 'qq-group' && !aggregate && state.speakers?.[channel]?.partner !== partner) conflict = null;
  const blame = conflict?.value || 0;
  const expectation = aggregate
    ? Math.max(0, ...Object.values(state.awaiting).map((value) => expectationFor(value, now)))
    : expectationFor(state.awaiting[channel], now);
  const stage = moodStage(blame);
  const mood = drives.fatigue > 45 ? '有些累' : drives.stress > 38 ? '有些紧绷'
    : drives.joy > 58 ? '心情不错' : drives.joy < 42 ? '有点低落'
      : drives.attachment > 61 && drives.intimacy > 55 ? '有些想亲近人'
        : drives.curiosity > 63 ? '兴致不错' : drives.reflection > 62 ? '容易陷进自己的思绪里'
          : drives.duty > 63 ? '想把手头的事做好'
            : drives.social > 59 ? '有点想找人说话' : '平常';
  return { drives, blame, stage, expectation, mood, knot: Boolean(conflict?.knot) };
}

export function emotionContext(snapshot) {
  if (!snapshot) return '';
  const hints = {
    calm: '', wronged: '和当前对话对象还有点别扭，有合适的机会可以说清楚。',
    angry: '对当前对话对象还有些生气，可以平静地说清楚介意的地方。',
    afraid: '和当前对话对象说话时有些紧张，可以先确认意思。',
    avoidant: '和当前对话对象说话时倾向简短，可以留一点空间。',
  };
  const hint = hints[snapshot.stage] || '';
  const waiting = snapshot.expectation >= 25 ? '你有点挂念上次主动开启的对话。' : '';
  return `【当下心境】${snapshot.mood}。${hint}${waiting}自然流露即可，无需复述心境或推测其来由。`;
}

export function composeCharacterContext(persona, snapshot) {
  return [persona, emotionContext(snapshot)].filter(Boolean).join('\n\n');
}

export function emotionPurposeWeight(candidate, emotion) {
  if (!emotion) return 1;
  const { drives, stage, expectation } = emotion;
  if (candidate.need === 'connect' || candidate.need === 'care') {
    if (stage === 'afraid' || stage === 'avoidant') return .65;
    if (stage === 'angry') return candidate.action === 'confide' ? 1.18 : .85;
    return 1 + (drives.attachment - BASELINE.attachment) / 240 - expectation / 600;
  }
  if (candidate.need === 'share' || candidate.need === 'learn') return 1 + (drives.curiosity - drives.fatigue - 35) / 240;
  return 1;
}
