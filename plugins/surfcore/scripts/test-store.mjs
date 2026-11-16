/** 配置存储回归：脱敏/还原密钥、范围收敛、默认值合并。 */
import assert from 'node:assert/strict';
import {
  MASK, normalizeBiliConfig, normalizeQqConfig, redactForUi, restoreMaskedSecrets,
} from '../lib/store.js';

const sample = {
  dsh: { authToken: 'secret-token' },
  snowluma: { accessToken: 'snow-secret' },
  webSearch: { apiKey: 'search-secret' },
  consoleToken: 'console-secret',
  allow: { private: [12345678, '87654321', 'abc'], groups: [] },
};
const redacted = redactForUi(sample);
assert.equal(redacted.dsh.authToken, MASK);
assert.equal(redacted.snowluma.accessToken, MASK);
assert.equal(redacted.webSearch.apiKey, MASK);
assert.equal(redacted.consoleToken, MASK);

const restored = restoreMaskedSecrets(redacted, sample);
assert.equal(restored.dsh.authToken, 'secret-token');
assert.equal(restored.snowluma.accessToken, 'snow-secret');
assert.equal(restored.webSearch.apiKey, 'search-secret');
assert.equal(restored.consoleToken, 'console-secret');

const normalized = normalizeQqConfig({
  ...sample,
  consolePort: 999999,
  allow: { private: ['12345678', 'abc'], groups: ['767098733'] },
  biliBridge: { memory: { enabled: false, refreshIntervalMs: 1 }, share: { times: ['7:00', '99:99'] } },
});
assert.equal(normalized.consolePort, 65535);
assert.deepEqual(normalized.allow.private, ['12345678']);
assert.equal(normalized.biliBridge.memory.enabled, false);
assert.equal(normalized.biliBridge.memory.refreshIntervalMs, 60000);
assert.deepEqual(normalized.biliBridge.share.times, ['07:00']);
// 分享形式：旧 card:boolean 收敛成 cardMode；card 变成派生值（PITFALLS #24）
assert.equal(normalized.biliBridge.share.cardMode, 'text', '没写 cardMode 时默认文本链接');
assert.equal(normalized.biliBridge.share.card, true);
const cardOff = normalizeQqConfig({ biliBridge: { share: { card: false } } });
assert.equal(cardOff.biliBridge.share.cardMode, 'off');
assert.equal(cardOff.biliBridge.share.card, false);
const cardMini = normalizeQqConfig({ biliBridge: { share: { card: true, cardMode: 'miniapp' } } });
assert.equal(cardMini.biliBridge.share.cardMode, 'miniapp', '显式 cardMode 优先于旧 card');
assert.equal(cardMini.biliBridge.share.card, true);
const cardBad = normalizeQqConfig({ biliBridge: { share: { cardMode: 'weird' } } });
assert.equal(cardBad.biliBridge.share.cardMode, 'text', '非法值回默认，不要静默变 off');

const bili = normalizeBiliConfig({
  night: { windows: [{ start: '6:00', end: '8:00', wakes: 3 }], skipChance: 2, maxVideos: 99 },
  quota: { shareDaily: -1 },
  share: { via: 'nope' },
});
assert.equal(bili.night.windows[0].start, '6:00');
assert.equal(bili.night.skipChance, 0.95);
assert.equal(bili.night.maxVideos, 20);
assert.equal(bili.night.minGapMin, 20);
assert.equal(bili.quota.shareDaily, 0);
assert.equal(bili.share.via, 'dynamic');

// 2026-10-22：四本账额度 / 四类动态改成可编辑，保存时必须收敛
const biliEditable = normalizeBiliConfig({
  limits: { daily: -1, globalMin: 999, mineDaily: 50 },
  dynamics: { gapMin: 1, kinds: { best: { slot: 99 } } },
});
assert.equal(biliEditable.limits.daily, 0);
assert.equal(biliEditable.limits.globalMin, 120);
assert.equal(biliEditable.limits.mineDaily, 50);
assert.equal(biliEditable.dynamics.gapMin, 5);
assert.equal(biliEditable.dynamics.kinds.best.slot, 23);
assert.equal(biliEditable.dynamics.kinds.best.minLen, 50);
assert.equal(biliEditable.dynamics.kinds.anime.slot, 18);
assert.equal(biliEditable.dynamics.enabled, true);

// 2026-10-23：偏好权重（用户要求「每个偏好能拉高/降低」）保存时收敛。
const biliTaste = normalizeBiliConfig({
  preferences: {
    like: ['DeepSeek', 'deepseek ', ' 猫咪 ', '', 'AI'],
    keywords: ['手书', 'deepseek'],
    dislike: [],
    weights: { deepseek: 9, '猫咪': 0, '不存在': 3, '手书': 'abc' },
  },
});
assert.deepEqual(biliTaste.preferences.like, ['DeepSeek', '猫咪', 'AI'], '大小写变体合并、空项丢弃');
assert.deepEqual(biliTaste.preferences.keywords, ['手书'], '和爱看重复的额外关键词去掉');
assert.equal(biliTaste.preferences.weights.DeepSeek, 5, '权重越界收敛到 5');
assert.equal(biliTaste.preferences.weights['猫咪'], 0, '0 是合法的「停用」');
assert.equal(biliTaste.preferences.weights['不存在'], undefined, '不在列表里的权重键要清掉');
assert.equal(biliTaste.preferences.weights['手书'], 1, '非法权重回落到默认 1');

console.log('store tests OK');
