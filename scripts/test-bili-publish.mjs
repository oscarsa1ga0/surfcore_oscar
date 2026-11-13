// 自由发布 / 原创专栏 / B站作品记忆同步的离线单测。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { markdownToHtml, htmlToPlain } from '../plugins/surfcore/tools/lib/article.mjs'
import { appendBiliPost, readBiliPosts } from '../plugins/surfcore/tools/lib/bili-posts.mjs'
import { dynamicGapWait, mergeFreeRecord, mergeArticleRecord } from '../plugins/surfcore/tools/lib/share-dynamic.mjs'
import { createEmptyCard, ingestBiliEntries } from '../src/memory-card.js'
import { createBiliMemory } from '../src/bili-memory.js'

const temps = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-publish-'))
  temps.push(dir)
  return dir
}
after(() => { for (const dir of temps) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} } })

test('Markdown → 专栏 HTML：标题/段落/列表/引用/链接/图片', () => {
  const md = [
    '# 标题',
    '',
    '第一段，**加粗**，[链接](https://www.bilibili.com/)。',
    '',
    '- 一',
    '- 二',
    '',
    '> 引用',
    '',
    '![图](https://i0.hdslb.com/a.png)',
  ].join('\n')
  const html = markdownToHtml(md)
  assert.match(html, /<h1>标题<\/h1>/)
  assert.match(html, /<p>第一段，<strong>加粗<\/strong>，<a href="https:\/\/www\.bilibili\.com\/">链接<\/a>。<\/p>/)
  assert.match(html, /<ul>\s*<li>一<\/li>\s*<li>二<\/li>\s*<\/ul>/)
  assert.match(html, /<blockquote>引用<\/blockquote>/)
  assert.match(html, /<figure class="img-box"/)
  const plain = htmlToPlain(html)
  assert.match(plain, /标题/)
  assert.match(plain, /第一段/)
  assert.match(plain, /\[图片\]/)
})

test('B站作品 JSONL：追加/读取/去重不依赖 bili-memory 刷新', () => {
  const dir = tempDir()
  const file = path.join(dir, 'bili-posts.jsonl')
  appendBiliPost(file, { id: 'article:1', type: 'article', title: '专栏一', text: '正文', url: 'https://www.bilibili.com/read/cv1', at: '2026-11-12T12:00:00+08:00', date: '2026-11-12' })
  appendBiliPost(file, { id: 'dynamic:2', type: 'dynamic', title: '自由动态', text: '今天想发点东西', url: 'https://t.bilibili.com/2', at: '2026-11-12T13:00:00+08:00', date: '2026-11-12' })
  appendBiliPost(file, { id: 'video:3', type: 'video', bvid: 'BV1xx411c7mD', title: '原创视频', text: '简介', summary: '发布时写好的详细概括', cover: 'https://i0.hdslb.com/cover.jpg', url: 'https://www.bilibili.com/video/BV1xx411c7mD', at: '2026-11-12T14:00:00+08:00', date: '2026-11-12' })
  const posts = readBiliPosts(file)
  assert.equal(posts.length, 3)
  assert.equal(posts[0].type, 'article')
  assert.equal(posts[1].url, 'https://t.bilibili.com/2')
  assert.equal(posts[2].type, 'video')
  assert.equal(posts[2].bvid, 'BV1xx411c7mD')
  assert.equal(posts[2].summary, '发布时写好的详细概括')
  assert.equal(posts[2].cover, 'https://i0.hdslb.com/cover.jpg')
})

test('自由动态/专栏共用 30 分钟间隔状态', () => {
  const now = Date.parse('2026-11-12T12:00:00+08:00')
  const state = mergeFreeRecord({}, { at: '2026-11-12T11:45:00+08:00', dynId: '1', date: '2026-11-12' })
  assert.equal(dynamicGapWait(state, 30, now).ok, false)
  assert.equal(dynamicGapWait(state, 30, now).waitMin, 15)
  const state2 = mergeArticleRecord(state, { at: '2026-11-12T12:00:00+08:00', aid: '373885', title: '测试' })
  assert.equal(dynamicGapWait(state2, 30, now + 31 * 60_000).ok, true)
})

test('原创专栏入库：记忆卡能读出“我写了一篇专栏”', () => {
  const card = createEmptyCard(Date.parse('2026-11-12T12:00:00+08:00'))
  const result = ingestBiliEntries(card, [{
    id: 'article:373885', type: 'article', title: '我的第一篇专栏',
    text: '今天写了一点关于猫的事。', url: 'https://www.bilibili.com/read/cv373885',
    date: '2026-11-12', at: '2026-11-12T12:00:00+08:00',
  }], {}, Date.parse('2026-11-12T12:00:00+08:00'))
  assert.equal(result.added, 1)
  const record = card.records.find((r) => r.sourceId === 'article:373885')
  assert.ok(record)
  assert.match(record.text, /在 B 站写了一篇专栏/)
  assert.match(record.text, /猫/)
  assert.ok(record.tags.includes('article'))
})

test('B站记忆 brief：关注/取关/点赞/投币都进最近活动', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'quota.json'), JSON.stringify({ log: [
    { at: '2026-11-13T10:00:00+08:00', type: 'follow', target: 'mid:353782040', note: 'oscarsaigao' },
    { at: '2026-11-13T10:01:00+08:00', type: 'unfollow', target: 'mid:999999', note: '某人' },
    { at: '2026-11-13T10:02:00+08:00', type: 'like-video', target: 'BV:BV1xx411c7mD', note: '测试视频' },
    { at: '2026-11-13T10:03:00+08:00', type: 'coin', target: 'BV:BV1xx411c7mD', note: '测试视频：真的很好', amount: 2 },
  ] }))
  const memory = createBiliMemory({ stateDir: dir, biliDir: dir, log: () => {} })
  const stats = await memory.refresh({ force: true })
  assert.equal(stats.ok, true, `记忆生成失败：${stats.error ?? ''}`)
  const brief = fs.readFileSync(path.join(dir, 'bili-memory-brief.md'), 'utf8')
  assert.match(brief, /【关注】/)
  assert.match(brief, /【取关】/)
  assert.match(brief, /【点赞】/)
  assert.match(brief, /【投币】/)
  assert.match(brief, /真的很好/)
  assert.match(brief, /2 枚/)
})

test('记忆卡：关注/点赞/投币成为独立记忆', () => {
  const now = Date.parse('2026-11-13T12:00:00+08:00')
  const card = createEmptyCard(now)
  const result = ingestBiliEntries(card, [
    { id: 'activity:follow:1', type: 'follow', title: 'oscarsaigao', text: '', date: '2026-11-13', at: '2026-11-13T10:00:00+08:00' },
    { id: 'activity:like:1', type: 'like', title: '测试视频', text: '', date: '2026-11-13', at: '2026-11-13T10:02:00+08:00' },
    { id: 'activity:coin:1', type: 'coin', title: '测试视频', text: '真的很好', amount: 2, date: '2026-11-13', at: '2026-11-13T10:03:00+08:00' },
  ], {}, now)
  assert.equal(result.added, 3)
  const follow = card.records.find((r) => r.source === 'bili-follow')
  const like = card.records.find((r) => r.source === 'bili-like')
  const coin = card.records.find((r) => r.source === 'bili-coin')
  assert.ok(follow && like && coin)
  assert.match(follow.text, /关注了/)
  assert.match(like.text, /点了赞/)
  assert.match(coin.text, /投了 2 枚硬币/)
})
