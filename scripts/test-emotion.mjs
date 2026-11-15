import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  applyEmotionEvent, BASELINE, classifyEmotionText, composeCharacterContext, createEmotionState,
  DIMENSIONS, emotionPurposeWeight, emotionSnapshot,
} from '../src/emotion.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-emotion-'));
after(() => fs.rmSync(tmp, { force: true, recursive: true }));
process.env.DSH_HOME = tmp;
const { characterPaths, readCurrentCharacter } = await import('../src/character-persona.js');
const { dialogueEmotionScope, enqueueEmotionEvent, emotionPaths } = await import('../src/emotion-events.js');
const { createEmotionService } = await import('../plugins/surfcore/lib/emotion.js');
const { createDiaryToolDefinitions } = await import('../plugins/surfcore/lib/diary-tools.js');
const at = Date.now();
const hour = 3600_000;
const owner = dialogueEmotionScope('qq-private', 'private:123', '123');
const alice = dialogueEmotionScope('qq-group', 'group:111', '456');
const bob = dialogueEmotionScope('qq-group', 'group:111', '789');
const publicBili = { source: 'bili' };

function event(state, kind, scope, id, time = at, more = {}) {
  return applyEmotionEvent(state, { ...scope, id, kind, at: time, ...more });
}

function switchRole(id, epoch) {
  const role = characterPaths(id);
  fs.mkdirSync(role.dir, { recursive: true });
  fs.writeFileSync(role.manifest, '{}');
  const file = path.join(tmp, 'surfcore', 'characters', 'current.json');
  const temp = `${file}.${id}.${epoch}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ id, epoch, name: `${id}-${epoch}` }));
  fs.renameSync(temp, file);
  return readCurrentCharacter();
}

test('九维基线、降噪、重责升级、修复和跨场景心境', () => {
  assert.equal(Object.keys(DIMENSIONS).length, 9);
  assert.equal(classifyEmotionText('你真没用哈哈哈'), 'tease');
  assert.equal(classifyEmotionText('他说“你给我闭嘴”'), 'chat');
  assert.equal(classifyEmotionText('你给我闭嘴', { directed: false }), 'atmosphere');
  assert.equal(classifyEmotionText('你给我闭嘴'), 'blameHard');
  assert.equal(classifyEmotionText('对不起，行了别闹了'), 'fakeComfort');
  assert.equal(classifyEmotionText('/reset'), '');

  const state = createEmotionState(at);
  event(state, 'blameHard', owner, 'a');
  event(state, 'blameHard', owner, 'b');
  assert.equal(emotionSnapshot(state, { ...owner, now: at }).stage, 'angry');
  assert.equal(emotionSnapshot(state, { ...owner, now: at }).blame, 69);
  event(state, 'comfort', owner, 'c');
  assert.equal(emotionSnapshot(state, { ...owner, now: at }).stage, 'angry');
  event(state, 'blameHard', owner, 'd');
  assert.equal(emotionSnapshot(state, { ...owner, now: at }).stage, 'avoidant');
  event(state, 'apology', owner, 'e');
  assert.equal(emotionSnapshot(state, { ...owner, now: at }).stage, 'avoidant');
  event(state, 'explain', owner, 'f');
  assert.equal(emotionSnapshot(state, { ...owner, now: at }).stage, 'calm');
  assert.equal(emotionSnapshot(state, { ...owner, now: at + 168 * hour }).blame, 0);

  event(state, 'praise', owner, 'g');
  event(state, 'praise', owner, 'h');
  event(state, 'praise', owner, 'i');
  assert.equal(state.recent.at(-1).reason, '连续被夸');
  const latest = emotionSnapshot(state, { ...owner, now: at });
  const away = emotionSnapshot(state, { ...publicBili, now: at + 168 * hour });
  assert.ok(Math.abs(away.drives.stress - BASELINE.stress) < Math.abs(latest.drives.stress - BASELINE.stress));
});

test('群聊的冲突按对象隔离，公开平台只读定性状态', () => {
  const state = createEmotionState(at);
  for (let i = 0; i < 4; i++) event(state, 'blameHard', alice, `blame-${i}`, at + i, { inbound: true, owner: true });
  assert.ok(emotionSnapshot(state, { ...alice, now: at + 4 }).blame >= 55);
  event(state, 'apology', bob, 'not-alice', at + 5, { inbound: true });
  assert.equal(emotionSnapshot(state, { ...bob, now: at + 5 }).stage, 'calm');
  assert.equal(emotionSnapshot(state, { ...alice, now: at + 5 }).stage, 'calm');
  const privateContext = composeCharacterContext('角色卡', emotionSnapshot(state, { ...publicBili, now: at + 5 }));
  assert.match(privateContext, /^角色卡\n\n【当下心境】/);
  assert.doesNotMatch(privateContext, /回避|对当前对话对象|456|789/);
  event(state, 'chat', alice, 'alice-again', at + 6, { inbound: true });
  assert.ok(emotionSnapshot(state, { ...alice, now: at + 6 }).blame >= 55);
});

test('期待只跟随成功的主动互动和目标会话，目的权重有界', () => {
  const state = createEmotionState(at);
  event(state, 'proactive', owner, 'sent');
  const waiting = emotionSnapshot(state, { ...owner, now: at + 8 * hour });
  assert.ok(waiting.expectation >= 25);
  assert.equal(emotionSnapshot(state, { ...publicBili, now: at + 8 * hour }).expectation, 0);
  event(state, 'chat', bob, 'other', at + 8 * hour, { inbound: true });
  assert.ok(emotionSnapshot(state, { ...owner, now: at + 8 * hour }).expectation >= 25);
  event(state, 'chat', owner, 'reply', at + 8 * hour + 1, { inbound: true });
  assert.equal(emotionSnapshot(state, { ...owner, now: at + 8 * hour + 1 }).expectation, 0);
  assert.equal(emotionSnapshot(state, { ...owner, now: at + 8 * hour + 1 }).blame, 0);
  assert.ok(emotionPurposeWeight({ need: 'connect' }, waiting) < 1);
});

test('事件由宿主单写，跨重启去重并且拒绝旧角色事件', () => {
  const first = switchRole('first', 1);
  const service = createEmotionService();
  assert.deepEqual(service.status().drives, BASELINE);
  assert.equal(enqueueEmotionEvent({ ...owner, kind: 'praise', key: 'qq-1', inbound: true }, first), true);
  const changed = service.snapshot(publicBili);
  assert.ok(changed.drives.joy > BASELINE.joy);
  assert.equal(fs.readdirSync(emotionPaths(first).inbox).length, 0);
  assert.equal(enqueueEmotionEvent({ ...owner, kind: 'praise', key: 'qq-1', inbound: true }, first), true);
  const restarted = createEmotionService();
  assert.equal(restarted.status().recent.length, 1);
  restarted.bind('qq-role-session', owner, first);
  assert.equal(restarted.binding('qq-role-session').role.epoch, 1);

  const second = switchRole('second', 2);
  assert.equal(enqueueEmotionEvent({ ...owner, kind: 'blameHard', key: 'late' }, first), false);
  assert.equal(restarted.snapshot(owner, first), null);
  assert.deepEqual(restarted.status().drives, BASELINE);
  assert.equal(restarted.configure({ characterId: first.id, epoch: first.epoch }).code, 'EMOTION_ROLE_CHANGED');
  assert.equal(restarted.configure({ characterId: second.id, epoch: second.epoch, settings: { sources: { bili: false } } }).ok, true);
  assert.equal(restarted.record({ ...publicBili, kind: 'enjoyed', key: 'video' }), false);
  assert.equal(restarted.record({ source: 'video', kind: 'progress', key: 'render' }), true);
  assert.ok(restarted.status().drives.duty > BASELINE.duty);
});

test('日记只记录写作引出的变化，原文不进入状态或上下文', async () => {
  const role = switchRole('diary-author', 3);
  const service = createEmotionService();
  const tools = createDiaryToolDefinitions({ recordEmotion: service.record });
  const content = '今天重新想了想，对那件事已经释怀。日记测试独有原文。';
  const write = tools.find((tool) => tool.name === 'diary_write');
  const edit = tools.find((tool) => tool.name === 'diary_edit');
  const result = JSON.parse(await write.execute({ content, afterWriting: 'relieved', characterId: role.id }));
  assert.equal(result.ok, true);
  assert.equal(service.status().recent[0].source, 'diary');
  await edit.execute({ id: result.entry.id, append: content, afterWriting: 'relieved', characterId: role.id });
  assert.equal(service.status().recent.length, 1);
  assert.doesNotMatch(fs.readFileSync(emotionPaths(role).state, 'utf8'), /日记测试独有原文/);
  assert.doesNotMatch(service.context('角色卡', publicBili), /释怀|独有原文/);
});

test('情绪状态损坏可见，提示词继续使用角色卡', () => {
  const role = switchRole('bad-state', 4);
  const service = createEmotionService();
  const { state } = emotionPaths(role);
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, '{not json}');
  const status = service.status();
  assert.equal(status.ok, false);
  assert.equal(status.code, 'EMOTION_STORE');
  assert.ok(status.hint);
  assert.equal(service.context('现有角色卡', owner), '现有角色卡');
  assert.equal(fs.readFileSync(state, 'utf8'), '{not json}');
});
