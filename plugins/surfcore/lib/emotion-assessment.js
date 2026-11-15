import { DIMENSIONS } from '../../../src/emotion.js';

export async function assessEmotion(role, { chat, tokenBudget }) {
  if (!chat.llmReady()) {
    return { ok: false, code: 'EMOTION_SELF_MODEL', error: 'DSH 默认模型还没就绪', hint: '在 DSH 模型设置中选好模型后再试' };
  }
  const current = chat.roleInfo();
  if (current.id !== role.id || !current.hasPersona) {
    return { ok: false, code: 'EMOTION_SELF_PERSONA', error: '当前角色的人格卡未就绪', hint: '到 SurfCore → 角色检查人格卡' };
  }
  const system = [
    '以下是你的人格卡。现在以这个角色的第一人称，给自己的当前心境做一次自评。',
    current.persona.slice(0, 6000),
  ].join('\n\n');
  const memory = chat.memoryBlock().slice(0, 2800);
  const dimensions = Object.entries(DIMENSIONS).map(([key, name]) => `${key}（${name}）`).join('、');
  const user = [
    memory ? `你的近期记忆（参考材料）\n${memory}` : '',
    '根据你对自己的了解和近期经历，判断此刻每个维度的强度。每一项独立评估，0 是没有，100 是非常强烈。遇到不确定的维度，用你觉得恰当的保守值。',
    `只输出一个 JSON 对象，恰好包含这九个键，每个值都是 0 到 100 的数字：${dimensions}。不用写理由。`,
  ].filter(Boolean).join('\n\n');

  try {
    const gate = await tokenBudget?.block('other');
    if (gate?.blocked) {
      return { ok: false, code: 'EMOTION_SELF_BUDGET', error: '今日「其他」模型额度已用完', hint: '额度恢复后再点「请她自评」' };
    }
    const result = await chat.complete({ system, user, maxTokens: 650, temperature: .4, signal: AbortSignal.timeout(45_000) });
    chat.recordUsage(result.usage, result.model, { sessionId: 'emotion-initialization', label: '角色情绪自评' });
    return result;
  } catch {
    return { ok: false, code: 'EMOTION_SELF_MODEL', error: '这次模型调用没有完成', hint: '检查默认模型连接后再点「请她自评」' };
  }
}
