// Dump the whole thread under our root comment: who said what, and how it nests.
//
//   node bili.mjs thread <aid> <bvid> <root>
//   node bili.mjs thread <cvid> --type 12 --root <rpid>
//
// type：1 视频（默认）；11 动态/图文；12 专栏/文章；17 转发动态。
const argv = process.argv.slice(2)
const opt = {}
const pos = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2)
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) { opt[k] = argv[i + 1]; i += 1 } else opt[k] = true
  } else pos.push(argv[i])
}
const AID = String(opt.oid || pos[0] || '')
const BVID = String(opt.bvid || pos[1] || '')
const ROOT = String(opt.root || pos[2] || '')
const TYPE = String(opt.type || (BVID ? '1' : '12'))
const REFERER = String(opt.referer || (TYPE === '12'
  ? `https://www.bilibili.com/read/cv${AID}`
  : `https://www.bilibili.com/video/${BVID}/`))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
if (!AID || !ROOT) {
  console.error('用法: node bili.mjs thread <aid> <bvid> <root> | <cvid> --type 12 --root <rpid>')
  process.exit(2)
}
// ⚠️ 楼中楼一页只给 20 条：只读第 1 页会**静默漏报**（超过 20 条时看不见）→ 翻页取全（2026-10-18 修）
async function fetchAll() {
  const all = []
  let root = null
  for (let pn = 1; pn <= 10; pn += 1) {
    const r = await fetch(`https://api.bilibili.com/x/v2/reply/reply?type=${encodeURIComponent(TYPE)}&oid=${AID}&root=${ROOT}&pn=${pn}&ps=20`, {
      headers: { 'user-agent': UA, referer: REFERER, 'accept-language': 'zh-CN,zh;q=0.9' },
    })
    const j = await r.json()
    if (j.code !== 0) return { code: j.code, message: j.message, data: { root, replies: all } }
    const rs = j.data?.replies ?? []
    root = root ?? j.data?.root
    all.push(...rs)
    if (rs.length < 20) break          // 不满一页 = 到底了
  }
  return { code: 0, data: { root, replies: all } }
}
const d = await fetchAll()
if (d.code !== 0) { console.log(`code=${d.code} message=${d.message}`); process.exit(0) }
const root = d.data?.root
if (!root) { console.log('code=0 但没有返回根评论（可能 rpid 不对，或评论区类型不对）'); process.exit(0) }
console.log('=== 线程根（顶层评论） ===')
console.log(`  ${root.member.uname} (mid ${root.member.mid})  rpid=${root.rpid}  rcount=${root.rcount}`)
console.log(`  ${root.content.message}`)
const members = root.content?.members ?? []
if (members.length) console.log(`  @到: ${members.map((m) => `${m.uname}(mid ${m.mid})`).join(', ')}`)
console.log('')
console.log(`=== 楼中楼（${(d.data?.replies ?? []).length} 条） ===`)
for (const c of d.data?.replies ?? []) {
  const isMine = c.member.mid === root.member.mid
  console.log(`  [${isMine ? '小号' : '主号'}] ${c.member.uname}  rpid=${c.rpid}  parent=${c.parent}  ${new Date(c.ctime * 1000).toLocaleTimeString('zh-CN')}`)
  console.log(`       ${c.content.message}`)
  const m2 = c.content?.members ?? []
  if (m2.length) console.log(`       @到: ${m2.map((x) => `${x.uname}(mid ${x.mid})`).join(', ')}`)
}
console.log('')
console.log(`线程链接: ${TYPE === '12' ? REFERER : `https://www.bilibili.com/video/${BVID}/`}#reply${root.rpid}`)
