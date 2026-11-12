/**
 * 出站身份闸回归（2026-10-23 用户要求：「只准自己互认，不许泄露主人和别人的信息」）。
 *
 * 为什么必须钉：
 *   · 跨平台互认会把「主人 QQ ⇄ B站 mid」「对齐表里别人的号」放进提示词；
 *     模型一旦在 B站 评论/动态里复述，就是不可撤回的公开泄露。
 *   · 这层是**确定性**的规则（已知 ID 精确匹配 + QQ/群号形态），不是提示词；
 *     但它也只有被真的接进发送路径才有效 —— 所以这里同时断言接线。
 *
 * 运行：node scripts/test-identity-guard.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  findIdentityLeaks, formatIdentityLeakError, maskLeakValue,
} from '../src/identity-guard.js';
import {
  assertOutboundIdentitySafe, collectProtectedIdentities,
} from '../plugins/surfcore/tools/lib/outbound-guard.mjs';

let failures = 0;
function test(name, run) {
  try { run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
}

const IDS = ['3287064288', '37634003', '111222333'];

// ── 纯函数 ─────────────────────────────────────────────────────────────────
test('已知 ID 精确命中', () => {
  const hits = findIdentityLeaks('主人的B站是 37634003 哦', { ids: IDS });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].value, '37634003');
  assert.equal(hits[0].kind, 'known-id');
});

test('「QQ / 群号 + 数字」形态也拦（即使不在名单里）', () => {
  for (const text of ['加我 QQ：123456789', '群号 555666777', 'QQ是 987654321']) {
    assert.ok(findIdentityLeaks(text, { ids: [] }).length > 0, text);
  }
});

test('普通数字不误伤（年份/播放量/楼层）', () => {
  for (const text of ['2026 年了还在看这个', '才 123456 播放', '第 88 楼说得对', 'BV1Lpnr6wE59']) {
    assert.deepEqual(findIdentityLeaks(text, { ids: IDS }), [], text);
  }
});

test('空文本不算泄露', () => {
  assert.deepEqual(findIdentityLeaks('', { ids: IDS }), []);
  assert.deepEqual(findIdentityLeaks(null, { ids: IDS }), []);
  assert.deepEqual(findIdentityLeaks('   ', { ids: IDS }), []);
});

test('错误信息里的号码是打码的（错误本身也可能被贴进日志）', () => {
  const hits = findIdentityLeaks('主人QQ 3287064288', { ids: IDS });
  const message = formatIdentityLeakError(hits, 'B站 评论');
  assert.match(message, /B站 评论/);
  assert.match(message, /328\*\*\*\*288/, message);
  assert.ok(!message.includes('3287064288'), '错误信息里不能出现完整号码');
  assert.match(message, /只用来认自己|不许外传/);
  assert.equal(maskLeakValue('123456789'), '123****789');
  assert.equal(maskLeakValue('abc'), 'abc');
});

// ── 配置收集（临时目录，不碰真实 ~/.dsh）────────────────────────────────────
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-guard-'));
try {
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    admin: { qq: '3287064288', biliMid: '1234567890123456', biliName: '测试用户Ａ' },
  }));
  fs.writeFileSync(path.join(temp, 'bili.config.json'), JSON.stringify({
    owner: { mid: '37634003', name: '测试用户Ａ' },
    self: { mid: '1483638708', name: '小肥鱼' },
  }));
  fs.writeFileSync(path.join(temp, 'alignments.json'), JSON.stringify({
    links: [
      { identities: { qq: { id: '111222333' }, bili: { id: '99887766' } } },
      // 她自己的映射：B站 mid 允许出现在自己的公开内容里，但 QQ 号仍然不许外传
      { identities: { qq: { id: '444555666' }, bili: { id: '1483638708' } } },
    ],
  }));

  test('受保护名单 = 主人 QQ/mid + 对齐表里别人的号；自己的 B站 mid 不拦', () => {
    const ids = collectProtectedIdentities({ surfcoreDir: temp });
    for (const wanted of ['3287064288', '37634003', '1234567890123456', '111222333', '99887766', '444555666']) {
      assert.ok(ids.includes(wanted), `缺少 ${wanted}`);
    }
    assert.ok(!ids.includes('1483638708'), '自己的 B站 mid 不该被拦（那是公开资料）');
  });

  test('assertOutboundIdentitySafe：泄露就抛，干净就放行', () => {
    assert.throws(() => assertOutboundIdentitySafe('看主人的空间 37634003', { surface: 'B站 评论', surfcoreDir: temp }), /B站 评论/);
    assert.throws(() => assertOutboundIdentitySafe('QQ 111222333', { surface: 'B站 私信', surfcoreDir: temp }), /B站 私信/);
    assert.equal(assertOutboundIdentitySafe('这视频真好看，2026 年还能看到', { surfcoreDir: temp }).ok, true);
    assert.equal(assertOutboundIdentitySafe('我的空间 space.bilibili.com/1483638708', { surfcoreDir: temp }).ok, true);
  });

  test('已配置的主人昵称、主页、关系表述和回复目标均受保护', () => {
    for (const text of ['＠ 测试用户a 快来看', '测试用户Ａ发的', 'https://space.bilibili.com/1234567890123456', '我的主人叫某某']) {
      assert.throws(() => assertOutboundIdentitySafe(text, { surfcoreDir: temp }), /暴露主人的身份/);
    }
    assert.throws(() => assertOutboundIdentitySafe('来看', { surfcoreDir: temp, targetMid: '37634003' }), /提及主人/);
    assert.throws(() => assertOutboundIdentitySafe('来看', { surfcoreDir: temp, unverifiedTarget: true }), /无法核验/);
    assert.equal(assertOutboundIdentitySafe('@普通网友 这个猫咪认得主人', { surfcoreDir: temp, targetMid: '99990000' }).ok, true);
    assert.equal(assertOutboundIdentitySafe('测试用户Ａ，晚上好', { surfcoreDir: temp, privateRecipientMid: '37634003' }).ok, true);
    assert.throws(() => assertOutboundIdentitySafe('测试用户Ａ是我主人', { surfcoreDir: temp, privateRecipientMid: '99990000' }), /暴露主人的身份/);
  });

  test('B站命令在实际发送入口拒绝点名、旧分享和公开回复主人', () => {
    const dshHome = path.join(temp, 'dsh');
    const surface = path.join(dshHome, 'surfcore');
    fs.mkdirSync(path.join(surface, 'bili'), { recursive: true });
    for (const file of ['config.json', 'bili.config.json']) fs.copyFileSync(path.join(temp, file), path.join(surface, file));
    fs.writeFileSync(path.join(surface, 'bili', 'credentials.json'), JSON.stringify({
      sessdata: 'fixture-only', bili_jct: 'fixture-only', buvid3: 'fixture-only',
    }));
    const mock = path.join(temp, 'mock-fetch.mjs');
    fs.writeFileSync(mock, `
      globalThis.fetch = async (input, options = {}) => {
        const url = new URL(input);
        if (options.method && options.method !== 'GET') throw new Error('fixture forbids network writes');
        if (url.pathname === '/x/web-interface/nav') return Response.json({ code: 0, data: { isLogin: true, mid: 1483638708, uname: '鱼姬' } });
        if (url.pathname === '/x/relation') return Response.json({ code: 0, data: { attribute: 6 } });
        if (url.pathname === '/x/v2/reply/reply') {
          const root = url.searchParams.get('root');
          const rootMid = { '101': '37634003', '102': '99990000' }[root];
          const row = rootMid ? { rpid_str: root, member: { mid: rootMid }, ctime: Date.now() / 1000 } : null;
          return Response.json({ code: 0, data: { root: row, replies: [] } });
        }
        throw new Error('unmocked GET: ' + url.pathname);
      };
    `);
    const cli = new URL('../plugins/surfcore/tools/bili.mjs', import.meta.url);
    const run = (...args) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '..', 'plugins/surfcore/tools/bili.mjs'), ...args], {
      env: { ...process.env, DSH_HOME: dshHome, SURFCORE_BILI_CONFIG: path.join(surface, 'bili.config.json'), NODE_OPTIONS: `--import=${pathToFileURL(mock)}` },
      encoding: 'utf8', timeout: 10000,
    });
    const video = ['--oid', '55555', '--bvid', 'BV1Lpnr6wE59', '--message', '好看'];
    const cases = [
      { args: ['comment', ...video, '--share', '--auto'], error: /改用 B站私信/ },
      { args: ['comment', ...video, '--root', '101', '--parent', '101'], error: /提及主人/ },
      { args: ['comment', ...video, '--root', '103', '--parent', '103'], error: /无法核验/ },
      { args: ['danmaku', 'send', '--room', '88888', '--msg', '好看', '--reply-mid', '37634003'], error: /提及主人/ },
      { args: ['danmaku', 'send', '--room', '88888', '--msg', '好看', '--reply-dmid', '888'], error: /无法核验/ },
      { args: ['dynamic-image', '--image', 'fixture.png', '--at', '37634003'], error: /提及主人/ },
      { args: ['dynamic', 'post', '--text', '测试用户Ａ快来看'], error: /提及主人/ },
      { args: ['share-dynamic', '--bvid', 'BV1Lpnr6wE59', '--text', '测试用户Ａ快来看'], error: /提及主人/ },
      { args: ['dm', '--to', '99990000', '--msg', '我的主人叫某某'], error: /提及主人/ },
    ];
    for (const { args, error } of cases) {
      const result = run(...args, '--go');
      assert.equal(result.status, 9, `${cli.pathname} ${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, error);
    }
    const publicReply = run('comment', ...video, '--root', '102', '--parent', '102', '--dry');
    assert.equal(publicReply.status, 0, publicReply.stderr);
    assert.match(publicReply.stdout, /\[dry\] 未发送/);
    const privateReply = run('dm', '--msg', '测试用户Ａ，晚上好', '--dry');
    assert.equal(privateReply.status, 0, privateReply.stderr);
    assert.match(privateReply.stdout, /\[dry\]/);
  });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

// ── 接线：改了规则却没接进发送路径 = 白改 ────────────────────────────────────
test('B站 写操作（评论/私信/动态/分享）都接了身份闸', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = {
    'comment.mjs': 'B站 评论',
    'dm.mjs': 'B站 私信',
    'dynamic.mjs': 'B站 动态',
    'share-dynamic.mjs': 'B站 动态',
    'daily.mjs': 'B站 每日动态',
    'dynamic-image.mjs': 'B站 图文动态',
    'edit-dynamic.mjs': 'B站 动态编辑',
    'danmaku.mjs': 'B站 直播弹幕',
  };
  for (const [file, surface] of Object.entries(files)) {
    const source = fs.readFileSync(path.join(root, 'plugins', 'surfcore', 'tools', 'commands', file), 'utf8');
    assert.ok(source.includes("from '../lib/outbound-guard.mjs'"), `${file} 没有引用身份闸`);
    assert.ok(source.includes('assertOutboundIdentitySafe'), `${file} 没有调用身份闸`);
    assert.ok(source.includes(surface), `${file} 没有标明 surface=${surface}`);
  }
});

if (failures) process.exitCode = 1;
console.log(failures ? `\n${failures} 项失败` : '\nidentity guard tests OK');
