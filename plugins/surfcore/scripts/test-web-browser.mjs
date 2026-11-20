import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Node {
  dataset = {};
  children = [];
  value = '';
  scrollHeight = 1000;
  clientHeight = 300;
  scrollTop = 0;
  classList = { toggle() {}, add() {}, remove() {} };
  showModal() { this.open = true; }
  close() { this.open = false; }
  scrollIntoView() { this.scrolledHere = true; }
  get childElementCount() { return this.children.length; }
  setAttribute() {}
  addEventListener() {}
  focus() {}
  append(...children) { this.children.push(...children); }
  prepend(child) { this.children.unshift(child); }
  replaceChildren(...children) { this.children = children; }
  get firstElementChild() { return this.children[0]; }
  get lastElementChild() { return this.children.at(-1); }
  insertBefore(node, next) {
    if (!next) this.children.push(node);
    else this.children.splice(this.children.indexOf(next), 0, node);
  }
}

const nodes = new Map();
const inputs = [];
let holdPost = false;
let roomError = false;
const reads = [];
let uuid = 0;
const fixtureMessage = (id, seq, text) => ({ id, seq, text, author: 'user', at: Date.now(), attachments: [] });
const document = {
  getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, new Node());
    return nodes.get(id);
  },
  createElement() { return new Node(); },
  querySelectorAll(selector) { return selector === '[data-open-room]' ? [this.getElementById('test-open-room')] : []; },
  addEventListener() {},
};
const scope = vm.createContext({
  document, window: { addEventListener() {} }, URLSearchParams, location: { hash: '' },
  requestAnimationFrame: (callback) => callback(), clearTimeout, setTimeout: () => 0, AbortSignal,
  EventSource: class { close() {} },
  crypto: { randomUUID: () => 'fixture-' + (++uuid) },
  async fetch(url, options) {
    if (url.endsWith('/state')) return new Promise(() => {});
    if (url.includes('/room?')) {
      if (roomError) return { ok: false, status: 503, json: async () => ({ ok: false, error: '近况读不到。', hint: '点「刷新」重试。' }) };
      return { ok: true, json: async () => ({
        ok: true, chat: 'fish', name: '鱼姬', activity: 'bili', mood: { label: '兴致不错', metrics: { curiosity: 84 } },
        diary: { reviewedDay: '2026-11-19', shares: [{ date: '2026-11-19', excerpt: '只给你看的分享' }] },
        watches: [{ bvid: 'BV1xx411c7mD', at: new Date().toISOString(), title: '海底漫游' }],
      }) };
    }
    if (url.includes('state?')) {
      reads.push(url);
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (url.includes('/search?')) {
      assert.match(url, /q=old/);
      return { ok: true, json: async () => ({ ok: true, chat: 'fish', messages: [fixtureMessage('older-result', 4, 'old scene')], more: false }) };
    }
    if (url.includes('/around?')) {
      assert.match(url, /id=older-result/);
      return { ok: true, json: async () => ({ ok: true, chat: 'fish', target: 'older-result', messages: [fixtureMessage('older-result', 4, 'old scene')] }) };
    }
    const body = JSON.parse(options.body);
    inputs.push(body);
    if (holdPost) { assert.ok(options.signal); return new Promise(() => {}); }
    if (inputs.length === 1) throw new Error('response lost after saving');
    return { ok: true, json: async () => ({ ok: true, message: fixtureMessage(body.id, 51, body.text) }) };
  },
});
vm.runInContext(fs.readFileSync(new URL('../lib/web-chat/room.js', import.meta.url), 'utf8'), scope);
vm.runInContext(fs.readFileSync(new URL('../lib/web-chat/chat.js', import.meta.url), 'utf8'), scope);
scope.initial = {
  chat: 'fish', cursor: 50, more: true, messages: [fixtureMessage('old', 50, 'older chat')],
  turns: [], run: { requests: [], phase: 'idle' },
};
vm.runInContext("apply(initial, true); setConnection('test', true); input.value = 'send once';", scope);
const submit = nodes.get('composer').onsubmit;
await submit({ preventDefault() {} });
await submit({ preventDefault() {} });
assert.equal(inputs.length, 2);
assert.equal(inputs[0].id, inputs[1].id, 'HTTP retry keeps the request ID even when no message was quoted');
assert.equal(nodes.get('message').value, '');

await nodes.get('test-open-room').onclick();
assert.equal(nodes.get('room-panel').open, true);
assert.equal(nodes.get('room-cards').hidden, false);
assert.equal(nodes.get('room-mood').textContent, '兴致不错');
assert.match(nodes.get('room-activity').textContent, /逛 B 站/);
assert.equal(nodes.get('room-diary-shares').children[0].textContent, '只给你看的分享');
assert.equal(nodes.get('room-watches').children[0].children[0].href, 'https://www.bilibili.com/video/BV1xx411c7mD');
roomError = true;
await nodes.get('room-refresh').onclick();
assert.equal(nodes.get('room-cards').hidden, true);
assert.match(nodes.get('room-status').textContent, /近况读不到.*刷新/);
assert.equal(nodes.get('room-refresh').disabled, false);
roomError = false;
await nodes.get('room-refresh').onclick();
assert.equal(nodes.get('room-cards').hidden, false);
nodes.get('room-close').onclick();
assert.equal(nodes.get('room-panel').open, false);

const timeline = nodes.get('timeline');
timeline.scrollTop = 40;
await vm.runInContext('connect()', scope);
assert.equal(timeline.scrollTop, 40, 'reconnection retains the reading position');
assert.equal(nodes.get('messages').children.length, 2, 'reconnection retains older loaded rows');
assert.ok(reads[0].endsWith('before=1'));
scope.changed = {
  ...scope.initial, cursor: 52, messages: [], turns: [{ id: 'old', state: 'failed', retryable: false, failure: '核对旧回合' }],
};
vm.runInContext('apply(changed)', scope);
const oldFailure = vm.runInContext("rows.get('old').failure", scope);
assert.equal(oldFailure.hidden, false);
assert.match(oldFailure.textContent, /核对旧回合/);
assert.equal(oldFailure.children.length, 0);
holdPost = true;
vm.runInContext("input.value = 'acknowledged by SSE';", scope);
const inFlight = submit({ preventDefault() {} });
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
assert.equal(nodes.get('message').readOnly, true);
const { id: ackId } = inputs.at(-1);
scope.acknowledged = { ...scope.changed, messages: [fixtureMessage(ackId, 53, 'acknowledged by SSE')] };
vm.runInContext('apply(acknowledged)', scope);
await inFlight;
assert.equal(nodes.get('message').readOnly, false, 'SSE receipt unlocks an HTTP request that never answered');
assert.equal(nodes.get('message').value, '');
nodes.get('open-history').onclick();
nodes.get('history-query').value = 'old';
await vm.runInContext('searchHistory()', scope);
assert.equal(nodes.get('history-results').children.length, 1);
await vm.runInContext("jumpToMessage('older-result', true)", scope);
assert.equal(nodes.get('history-search').open, false);
assert.equal(nodes.get('history-context').open, true);
assert.equal(nodes.get('history-messages').children[0].scrolledHere, true);
console.log('✓ browser request retry ID, reconnect scroll position and older failure state');
