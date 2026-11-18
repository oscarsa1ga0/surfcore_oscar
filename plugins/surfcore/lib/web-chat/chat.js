const API = '/fish-home/api/';
const element = (id) => document.getElementById(id);
const timeline = element('timeline');
const messages = element('messages');
const composer = element('composer');
const input = element('message');
const send = element('send');
const notice = element('alert');
const rows = new Map();
let attachments = [];
let quoted = null;
let payload = null;
let streamConnection;
let chat;
let cursor = 0;
let connected = false;
let submitted = false;
let lastRequestIds = '';
let userError = '';
let backoff;
const time = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function api(route, data) {
  const response = await fetch(API + route, data === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok || value.ok === false) {
    throw Object.assign(new Error([value.error, value.hint].filter(Boolean).join(' ')), { status: response.status, code: value.code });
  }
  return value;
}
function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function showAlert(text = '', isUser = true) {
  if (isUser) userError = text;
  notice.textContent = userError || text;
  notice.hidden = !notice.textContent;
}
function setConnection(label, online) {
  connected = online;
  element('connection-label').textContent = label;
  element('connection').dataset.online = String(online);
  send.disabled = !online || submitted;
}
function addMessage(message, prepend = false) {
  if (rows.has(message.id)) return;
  const row = make('div', '', 'row ' + message.author);
  const who = { assistant: element('name').textContent, user: '你', notice: '通知' }[message.author];
  row.append(make('div', who + ' · ' + time.format(message.at), 'meta'));
  const bubble = make('div', '', 'bubble');
  if (message.quote?.text) {
    const quote = make('div', '', 'quote-inline');
    quote.append(make('span', '引用 ' + (message.quote.author === 'user' ? '你' : whoOf()) + '：' + message.quote.text));
    bubble.append(quote);
  }
  if (message.text) bubble.append(make('p', message.text));
  for (const attachment of message.attachments || []) {
    if (String(attachment.type || '').startsWith('audio/')) {
      const audio = make('audio');
      audio.controls = true;
      audio.src = API + 'attachment/' + attachment.id;
      bubble.append(audio);
      continue;
    }
    const link = make('button', '', 'image');
    link.type = 'button';
    link.setAttribute('aria-label', '查看图片');
    const image = make('img');
    image.src = API + 'attachment/' + attachment.id;
    image.alt = attachment.type === 'image/gif' ? 'GIF 动图' : '聊天图片';
    image.loading = 'lazy';
    link.append(image);
    link.onclick = () => {
      element('preview').querySelector('img').src = image.src;
      element('preview').showModal();
    };
    bubble.append(link);
  }
  row.append(bubble);
  if (message.note) row.append(make('p', message.note, 'note'));
  const failure = make('div', '', 'failure');
  failure.hidden = true;
  row.append(failure);
  rows.set(message.id, { row, message, failure });
  // 引用：手机上长按、桌面双击/右键，都能选中这一条（对应 QQ 的长按引用）。
  if (message.author === 'user' || message.author === 'assistant') {
    let pressTimer = 0;
    const beginPress = () => {
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => pickQuote(message), 450);
    };
    const endPress = () => clearTimeout(pressTimer);
    row.addEventListener('pointerdown', beginPress);
    row.addEventListener('pointerup', endPress);
    row.addEventListener('pointerleave', endPress);
    row.addEventListener('pointercancel', endPress);
    row.addEventListener('dblclick', (event) => { event.preventDefault(); pickQuote(message); });
    row.addEventListener('contextmenu', (event) => { event.preventDefault(); pickQuote(message); });
  }

  if (prepend) messages.prepend(row);
  else {
    const following = [...rows.values()].filter((entry) => entry.message.seq > message.seq)
      .sort((left, right) => left.message.seq - right.message.seq)[0];
    messages.insertBefore(row, following?.row ?? null);
  }
}
function whoOf() {
  return element('name').textContent || '鱼姬';
}
function pickQuote(message) {
  quoted = { id: message.id, author: message.author, text: String(message.text || '').slice(0, 80) };
  renderQuote();
  input.focus();
}
function renderQuote() {
  const bar = element('quote');
  bar.replaceChildren();
  if (!quoted) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.append(make('span', '引用 ' + (quoted.author === 'user' ? '你' : whoOf()) + '：' + quoted.text, 'quote-text'));
  const cancel = make('button', '×', 'quote-cancel');
  cancel.type = 'button';
  cancel.setAttribute('aria-label', '取消引用');
  cancel.onclick = () => { quoted = null; renderQuote(); };
  bar.append(cancel);
}
function updateTurns(turns) {
  for (const turn of turns) {
    const entry = rows.get(turn.id);
    if (!entry) continue;
    if (entry.failure.dataset.state === turn.state) continue;
    entry.failure.dataset.state = turn.state;
    entry.failure.hidden = turn.state !== 'failed';
    if (turn.state !== 'failed') continue;
    entry.failure.textContent = turn.failure || '发送失败，可重试。';
    const button = make('button', '重新发送');
    button.type = 'button';
    button.onclick = async () => {
      button.disabled = true;
      try {
        const images = await Promise.all(entry.message.attachments.map(async ({ id }) => {
          const response = await fetch(API + 'attachment/' + id);
          if (!response.ok) throw new Error('无法重新读取附件。');
          return fileData(await response.blob());
        }));
        await api('messages', { id: crypto.randomUUID(), chat, text: entry.message.text, images,
          ...(entry.message.quote ? { quoteId: entry.message.quote.id } : {}) });
        button.textContent = '已重新发送';
        showAlert();
      } catch (error) {
        button.disabled = false;
        showAlert(error.message);
      }
    };
    entry.failure.append(button);
  }
}
function updateRequests(requests) {
  const ids = requests.map(({ id }) => id).join(' ');
  if (lastRequestIds === ids) return;
  lastRequestIds = ids;
  const list = element('requests');
  list.replaceChildren();
  for (const request of requests) {
    const card = make('article');
    const respond = async (value) => {
      const buttons = [...card.querySelectorAll('button')];
      for (const button of buttons) button.disabled = true;
      try { await api('answer', { id: request.id, ...value }); showAlert(); }
      catch (error) { showAlert(error.message); for (const button of buttons) button.disabled = false; }
    };
    if (request.kind === 'approval') {
      card.append(make('h2', '工具需要你的确认'), make('p', [request.tool, request.reason].filter(Boolean).join(' · ')));
      for (const [text, allow] of [['批准本次', true], ['拒绝', false]]) {
        const button = make('button', text, allow ? 'primary' : '');
        button.type = 'button';
        button.onclick = () => respond({ allow });
        card.append(button);
      }
    } else {
      card.append(make('h2', '鱼姬想问你'));
      const forms = request.questions.map((question) => {
        const field = make('fieldset');
        field.append(make('legend', question.text || question.title || '问题'));
        if (question.detail) field.append(make('p', question.detail));
        const choices = question.options.map((option) => {
          const choice = make('input');
          choice.type = question.multiple ? 'checkbox' : 'radio';
          choice.name = 'q-' + question.id;
          choice.value = option.label;
          const label = make('label');
          label.append(choice, document.createTextNode(' ' + option.label + (option.description ? ' · ' + option.description : '')));
          field.append(label);
          return choice;
        });
        const custom = make('input');
        custom.type = 'text';
        custom.placeholder = '填写自己的答案';
        custom.setAttribute('aria-label', '填写答案');
        field.append(custom);
        card.append(field);
        return () => ({ id: question.id, selected: choices.filter((choice) => choice.checked).map((choice) => choice.value), custom: custom.value });
      });
      const reply = make('button', '提交回答', 'primary');
      reply.onclick = () => respond({ answers: forms.map((get) => get()) });
      const skip = make('button', '跳过');
      skip.onclick = () => respond({ skip: true });
      card.append(reply, skip);
    }
    list.append(card);
  }
}
function apply(value, initial = false) {
  const nearEnd = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 130;
  if (chat !== value.chat || value.reset || initial) {
    rows.clear();
    messages.replaceChildren();
    if (chat && chat !== value.chat) {
      payload = null;
      attachments = [];
      renderAttachments();
      showAlert('角色已切换。请核对要发送的消息。');
    }
    element('older').hidden = !value.more;
  }
  chat = value.chat;
  cursor = value.cursor;
  element('name').textContent = value.name || '鱼姬';
  for (const message of value.messages) addMessage(message);
  const { run } = value;
  const source = { bili: 'B 站', diary: '日记', qq: 'QQ' }[value.occupied];
  const states = {
    idle: '在线', queued: source ? '等候中 · ' + source + '回合进行中' : '消息已保存，等待本轮',
    starting: '正在启动 DSH 回合', running: '正在输入…',
    tool: ['正在使用工具', run.tool].filter(Boolean).join(' · '), approval: '等你确认',
    recovering: '正在恢复上一轮',
  };
  element('status').textContent = run.read ? '已读' : (states[run.phase] ?? '在线');
  const draft = element('stream');
  draft.hidden = !run.draft && !run.note;
  if (!draft.hidden) {
    const row = make('div', '', 'row assistant');
    if (run.draft) row.append(make('div', run.draft, 'bubble'));
    if (run.note) row.append(make('div', run.note, 'note'));
    draft.replaceChildren(row);
  }
  updateTurns(value.turns);
  updateRequests(run.requests);
  showAlert(value.error, false);
  if (nearEnd || initial || value.reset) requestAnimationFrame(() => { timeline.scrollTop = timeline.scrollHeight; });
}
function renderAttachments() {
  const container = element('attachments');
  container.replaceChildren();
  for (const [index, file] of attachments.entries()) {
    const button = make('button', file.name + ' ×');
    button.type = 'button';
    button.onclick = () => { attachments.splice(index, 1); renderAttachments(); };
    container.append(button);
  }
}
function fileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取图片。'));
    reader.readAsDataURL(file);
  });
}
element('upload').onchange = (event) => {
  const files = [...attachments, ...event.target.files];
  if (files.length > 4 || files.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) {
    showAlert('每条消息最多 4 张图片，附件合计上限为 8 MB。');
  } else {
    attachments = files;
    renderAttachments();
    showAlert();
  }
  event.target.value = '';
};
input.onpaste = (event) => {
  const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
  if (!images.length) return;
  if (!event.clipboardData.getData('text/plain')) event.preventDefault();
  const next = [...attachments, ...images];
  if (next.length > 4 || next.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) showAlert('粘贴后超过 4 张图片或 8 MB。');
  else { attachments = next; renderAttachments(); }
};
element('attach-label').onkeydown = (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  element('upload').click();
};
composer.onsubmit = async (event) => {
  event.preventDefault();
  if (submitted || !chat || !connected) return;
  if (!input.value.trim() && !attachments.length) return;
  submitted = true;
  send.disabled = true;
  input.readOnly = true;
  try {
    const text = input.value.trim();
    const images = await Promise.all(attachments.map(fileData));
    const quoteId = quoted?.id || '';
    if (!payload || payload.chat !== chat || payload.text !== text || payload.quoteId !== quoteId || JSON.stringify(payload.images) !== JSON.stringify(images)) {
      payload = { id: crypto.randomUUID(), chat, text, images, ...(quoteId ? { quoteId } : {}) };
    }
    const result = await api('messages', payload);
    addMessage(result.message);
    timeline.scrollTop = timeline.scrollHeight;
    payload = null;
    attachments = [];
    quoted = null;
    renderAttachments();
    renderQuote();
    input.value = '';
    showAlert();
  } catch (error) {
    showAlert(error.message || '本机服务暂不可用。重连后再点击发送。');
  } finally {
    submitted = false;
    input.readOnly = false;
    send.disabled = !connected;
    input.focus();
  }
};
input.onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
};
element('older').onclick = async () => {
  const button = element('older');
  const anchor = messages.firstElementChild;
  const first = [...rows.values()].find(({ row }) => row === anchor);
  if (!first) return;
  button.disabled = true;
  try {
    const value = await api('state?before=' + first.message.seq);
    if (value.chat !== chat) return;
    const before = timeline.scrollHeight;
    for (const message of [...value.messages].reverse()) addMessage(message, true);
    button.hidden = !value.more;
    timeline.scrollTop += timeline.scrollHeight - before;
  } catch (error) { showAlert(error.message); }
  finally { button.disabled = false; }
};
element('close-preview').onclick = () => element('preview').close();
async function connect() {
  clearTimeout(backoff);
  streamConnection?.close();
  try {
    const initial = await api('state');
    apply(initial, true);
    streamConnection = new EventSource(API + 'events?chat=' + encodeURIComponent(chat) + '&after=' + cursor);
    streamConnection.onmessage = (event) => {
      setConnection('已连接', true);
      apply(JSON.parse(event.data));
    };
    streamConnection.onerror = () => {
      setConnection('正在重连', false);
      element('status').textContent = '正在等待本机服务';
      clearTimeout(backoff);
      backoff = setTimeout(() => { if (!connected) void connect(); }, 6000);
    };
  } catch (error) {
    setConnection(error.status === 401 ? '等待配对' : '正在重连', false);
    element('status').textContent = error.status === 401 ? '请从 SurfCore 设置打开' : '正在等待本机服务';
    showAlert(error.status ? error.message : '本机服务暂不可用，正在重连。', false);
    if (error.status !== 401) backoff = setTimeout(connect, 4000);
  }
}
const pair = new URLSearchParams(location.hash.slice(1)).get('pair');
if (pair) {
  history.replaceState(null, '', '/');
  api('pair', { code: pair }).then(connect).catch((error) => {
    setConnection('等待配对', false);
    element('status').textContent = '请从 SurfCore 设置重新打开';
    showAlert(error.message);
  });
} else void connect();
