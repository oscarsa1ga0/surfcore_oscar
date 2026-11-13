// 最后一次 QQ 私聊 → B站 上线前摘要的纯逻辑测试。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildQqLastContextSnapshot, composeQqLastContextForBili, summarizeQqConversation } from '../src/qq-last-context.js'

const record = {
  key: 'private:1507154693',
  at: '2026-11-13T16:57:41+08:00',
  summary: '他临走补了句加油，我们都道过拜拜了。我这边去琢磨第一篇要写什么',
  nextOpening: '等我写出第一篇发B站，喊他来看',
}
const purpose = {
  drives: { connect: 0.66, share: 0.82, self: 0.62, learn: 0.4, play: 0.38, care: 0.2, create: 0.1, consume: 0.05, identity: 0.03 },
  goals: [
    { owner: 'self', domain: 'share', intent: '写第一篇B站专栏', confidence: 0.52, status: 'active', nextStep: '先想标题' },
    { owner: 'owner', domain: 'care', intent: '问问主人最近累不累', confidence: 0.4, status: 'active', nextStep: '晚上问' },
    { owner: 'self', domain: 'identity', intent: '想清楚自己是什么', confidence: 0.3, status: 'hypothesis', nextStep: '继续观察' },
  ],
}
const messages = [
  { isSelf: false, plain: '你的存在本身，就是对我最大的意义' },
  { isSelf: true, plain: '那我真去写第一篇了，写完喊你' },
  { isSelf: false, plain: '加油哦' },
]
const activeTopics = [{ text: '这周末 S 赛决赛，说好他喊我一起看' }]
const pendingThoughts = [{ text: '想写第一篇 B站专栏，写我每天怎么忘事' }]
const memorySummary = summarizeQqConversation({ messages, activeTopics, pendingThoughts })

test('快照：drives/goals 各前 5，记忆是一段摘要而不是 3 条记录', () => {
  const snap = buildQqLastContextSnapshot({ record, purpose, memorySummary, now: Date.parse('2026-11-13T17:30:00+08:00') })
  assert.equal(snap.at, '2026-11-13T08:57:41.000Z')
  assert.equal(snap.drivesTop5.length, 5)
  assert.equal(snap.drivesTop5[0].need, 'share')
  assert.equal(snap.drivesTop5[0].value, 82)
  assert.ok(snap.goalsTop5.length <= 5)
  assert.equal(snap.goalsTop5[0].intent, '写第一篇B站专栏')
  assert.match(snap.memorySummary, /写第一篇/)
  assert.equal(snap.summary.includes('第一篇'), true)
})

test('摘要：包含收尾/目的/记忆，封顶 600 字，空快照返回空', () => {
  const snap = buildQqLastContextSnapshot({ record, purpose, memorySummary })
  const text = composeQqLastContextForBili(snap, { maxChars: 600 })
  assert.match(text, /上次在 QQ/)
  assert.match(text, /写第一篇B站专栏/)
  assert.match(text, /当时最想要/)
  assert.match(text, /当时的记忆/)
  assert.match(text, /不是新指令/)
  assert.ok(text.length <= 600)
  assert.equal(composeQqLastContextForBili(null), '')

  const sourceOnly = buildQqLastContextSnapshot({ record, purpose, memorySource: memorySummary })
  assert.match(composeQqLastContextForBili(sourceOnly), /当时的记忆/)
  assert.match(composeQqLastContextForBili(sourceOnly), /写第一篇/)
})
