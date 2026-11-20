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
let audioFile = null;
let audioPreview = '';
let selectedSticker = null;
let stickerCatalog = [];
let recorder = null;
let recordingTimer;
let recordingGeneration = 0;
let pendingPoke = null;
let unread = 0;
let pendingAcceptance;
let transcriptionEnabled = false;
let historyRequest = 0;
let nextSearchPage = null;
let quoted = null;
let payload = null;
let streamConnection;
let chat;
const room = createRoomPanel({ api, element, make, getChat: () => chat });
let cursor = 0;
let connected = false;
let submitted = false;
let lastRequestIds = '';
let userError = '';
let backoff;
const time = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function api(route, data) {
  const signal = AbortSignal.timeout(data?.audio || data?.images?.length ? 30_000 : 15_000);
  let response;
  try {
    response = await fetch(API + route, data === undefined ? { signal } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal,
    });
  } catch (error) {
    if (!signal.aborted) throw error;
    throw new Error(data === undefined ? '本机服务暂未返回。' : '本机服务暂未返回。若消息已经出现就无需重发，否则请重试。');
  }
  const value = await response.json().catch(() => {
    if (signal.aborted) throw new Error(data === undefined ? '本机服务暂未完整返回。' : '本机服务暂未返回完整回执。请核对气泡后重试。');
    return {};
  });
  if (!response.ok || value.ok !== true) {
    throw Object.assign(new Error([value.error, value.hint].filter(Boolean).join(' ') || '本机服务未返回有效结果。请稍后再试。'), { status: response.status, code: value.code, hint: value.hint });
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
  send.disabled = !online || submitted || Boolean(recorder);
}
function addMessage(message, prepend = false, destination = null) {
  if (!destination && rows.has(message.id)) return;
  const row = make('div', '', 'row ' + message.author);
  row.dataset.seq = String(message.seq);
  row.dataset.action = message.action ?? '';
  const body = make('div', '', 'body');
  if (message.author === 'assistant') {
    const avatar = make('img', '', 'avatar');
    avatar.src = API + 'avatar';
    avatar.alt = '';
    avatar.loading = 'lazy';
    avatar.onerror = () => avatar.remove();
    row.append(avatar);
  }
  row.append(body);
  const who = { assistant: whoOf(), user: '你', notice: '通知' }[message.author];
  const meta = make('div', who + ' · ' + time.format(message.at), 'meta');
  if (message.author !== 'notice') {
    const quoteButton = make('button', '引用', 'quote-message');
    quoteButton.type = 'button';
    quoteButton.onclick = () => pickQuote(message);
    meta.append(quoteButton);
  }
  body.append(meta);
  const bubble = make('div', '', 'bubble');
  if (message.quote) {
    const quote = make('button', '', 'quote-inline');
    quote.type = 'button';
    quote.append(make('span', '引用 ' + (message.quote.author === 'user' ? '你' : whoOf()) + '：' + (message.quote.text || '[附件]')));
    quote.onclick = () => void jumpToMessage(message.quote.id);
    bubble.append(quote);
  }
  if (message.text) bubble.append(make('p', message.text));
  for (const attachment of message.attachments || []) {
    if (String(attachment.type || '').startsWith('audio/')) {
      const audio = make('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.addEventListener('error', () => showAlert('语音无法播放。可以刷新后再试。'));
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
  body.append(bubble);
  if (message.note) body.append(make('p', message.note, 'note'));
  const failure = make('div', '', 'failure');
  failure.hidden = true;
  body.append(failure);
  if (destination) {
    destination.append(row);
    return row;
  }
  rows.set(message.id, { row, message, failure });
  if (prepend) messages.prepend(row);
  else {
    const last = messages.lastElementChild;
    const next = last && Number(last.dataset.seq) > message.seq
      ? [...messages.children].find((entry) => Number(entry.dataset.seq) > message.seq)
      : null;
    messages.insertBefore(row, next ?? null);
  }
  return true;
}
function whoOf() {
  return element('name').textContent || '鱼姬';
}
function pickQuote(message) {
  const type = message.attachments?.[0]?.type ?? '';
  const preview = message.action === 'sticker' ? '[表情]' : type === 'image/gif' ? '[GIF]'
    : type.startsWith('audio/') ? '[语音]' : type.startsWith('image/') ? '[图片]' : '[消息]';
  quoted = { id: message.id, author: message.author, text: String(message.text || preview).slice(0, 80) };
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
    const status = JSON.stringify([turn.state, turn.failure, turn.retryable, turn.note]);
    if (entry.failure.dataset.state === status) continue;
    entry.failure.dataset.state = status;
    entry.failure.hidden = turn.state !== 'failed' && !turn.note;
    entry.failure.classList.toggle('failure', turn.state === 'failed');
    entry.failure.classList.toggle('note', turn.state !== 'failed');
    entry.failure.textContent = [turn.failure || (turn.state === 'failed' ? '这轮处理失败，请到 DSH 查看。' : ''), turn.note].filter(Boolean).join(' ');
    if (turn.state !== 'failed' || !turn.retryable) continue;
    const button = make('button', '重试');
    button.type = 'button';
    button.onclick = async () => {
      button.disabled = true;
      const sentChat = chat;
      try {
        const result = await api('retry', { id: entry.message.id, chat: sentChat });
        if (chat === sentChat) addMessage(result.message);
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
const nearLatest = () => timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 130;

function updateUnread() {
  const button = element('jump-latest');
  button.hidden = !unread && nearLatest();
  button.textContent = unread ? unread + ' 条新消息' : '回到最新';
  document.title = unread && document.hidden ? '(' + unread + ') 鱼姬之家' : '鱼姬之家';
}

function scrollToLatest() {
  timeline.scrollTop = timeline.scrollHeight;
  if (!document.hidden) unread = 0;
  updateUnread();
}

element('jump-latest').onclick = scrollToLatest;
timeline.addEventListener('scroll', () => {
  if (!document.hidden && nearLatest()) unread = 0;
  updateUnread();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && nearLatest()) unread = 0;
  updateUnread();
});

function apply(value, initial = false) {
  const nearEnd = nearLatest();
  const roleChanged = chat !== value.chat;
  if (chat !== value.chat || value.reset) {
    const switched = Boolean(chat && chat !== value.chat);
    rows.clear();
    messages.replaceChildren();
    unread = 0;
    if (switched) {
      pendingAcceptance?.reject(new Error('角色已切换。'));
      historyRequest++;
      nextSearchPage = null;
      for (const id of ['history-search', 'history-context']) if (element(id).open) element(id).close();
      payload = null;
      pendingPoke = null;
      attachments = [];
      selectedSticker = null;
      quoted = null;
      renderQuote();
      cancelRecording();
      setAudio(null);
      if (element('sticker-picker').open) element('sticker-picker').close();
      showAlert('角色已切换。请核对输入框里的文字。');
    }
    element('older').hidden = !value.more;
  }
  chat = value.chat;
  room.update(value, roleChanged);
  if (typeof value.transcriptionEnabled === 'boolean' && transcriptionEnabled !== value.transcriptionEnabled) {
    transcriptionEnabled = value.transcriptionEnabled;
    if (audioFile) renderAttachments();
  }
  cursor = value.cursor;
  element('name').textContent = value.name || '鱼姬';
  for (const message of value.messages) {
    if (pendingAcceptance?.id === message.id && pendingAcceptance.chat === chat && message.author === 'user') {
      pendingAcceptance.resolve({ message });
    }
    if (addMessage(message) && !initial && !value.reset && message.author !== 'user' && (!nearEnd || document.hidden)) unread++;
  }
  const { run } = value;
  const source = { bili: 'B 站', diary: '日记', pet: '桌宠' }[value.occupied];
  const states = {
    idle: run.read ? '已读' : '在线',
    queued: source ? '等候中 · ' + source + '回合进行中' : '消息已保存，等待本轮',
    starting: '正在接收消息', running: '正在输入…',
    tool: run.tool === 'web_chat_wait' ? '等你接着说…' : '正在处理消息', approval: '等你确认',
    recovering: '正在核对上一轮',
  };
  element('status').textContent = states[run.phase] ?? '在线';
  const runNote = [run.recovery?.error, run.recovery?.hint, run.note].filter(Boolean).join(' ');
  element('run-note').textContent = runNote;
  element('run-note').hidden = !runNote;
  updateTurns(value.turns);
  updateRequests(run.requests);
  showAlert(value.error, false);
  if (nearEnd || initial || value.reset) requestAnimationFrame(scrollToLatest);
  else updateUnread();
}

function renderAttachments() {
  const container = element('attachments');
  container.replaceChildren();
  const removeButton = (label, action) => {
    const button = make('button', label + ' ×');
    button.type = 'button';
    button.disabled = submitted;
    button.onclick = action;
    container.append(button);
  };
  for (const [index, file] of attachments.entries()) {
    removeButton(file.name, () => { attachments.splice(index, 1); renderAttachments(); });
  }
  if (selectedSticker) removeButton('表情 #' + selectedSticker.no, () => { selectedSticker = null; renderAttachments(); });
  if (audioFile) {
    const audio = make('audio');
    audio.controls = true;
    audio.src = audioPreview;
    audio.preload = 'metadata';
    const hint = make('span', transcriptionEnabled ? '' : '语音转写尚未配置，可以附上一句文字。', 'note');
    audio.addEventListener('loadedmetadata', () => {
      if (transcriptionEnabled && audio.duration > 90) hint.textContent = '语音超过 90 秒。鱼姬只会收到前 90 秒的转写。';
    });
    container.append(audio, hint);
    removeButton('移除语音', () => setAudio(null));
  }
  input.placeholder = audioFile ? '可附一句文字，方便她理解语音…' : '给鱼姬发消息…';
  const recordButton = element('record');
  const recordLabel = recorder ? '结束录音' : '录音';
  recordButton.setAttribute('aria-label', recordLabel);
  recordButton.title = recordLabel;
  recordButton.setAttribute('aria-pressed', String(Boolean(recorder)));
  send.disabled = !connected || submitted || Boolean(recorder);
}

function setAudio(file) {
  if (audioPreview) URL.revokeObjectURL(audioPreview);
  audioFile = file;
  audioPreview = file ? URL.createObjectURL(file) : '';
  renderAttachments();
}
function fileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取图片。'));
    reader.readAsDataURL(file);
  });
}
function attachImages(files) {
  if (submitted || recorder) return;
  if (audioFile || selectedSticker) { showAlert('请先发送或移除当前语音或表情。'); return; }
  const next = [...attachments, ...files];
  if (next.length > 4 || next.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) {
    showAlert('每条消息最多 4 张图片，附件合计最多 8 MB。');
    return;
  }
  attachments = next;
  renderAttachments();
  showAlert();
}

element('attach-image').onclick = () => element('upload').click();
element('upload').onchange = (event) => {
  attachImages(event.target.files);
  event.target.value = '';
};
input.onpaste = (event) => {
  const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
  if (!images.length) return;
  if (!event.clipboardData.getData('text/plain')) event.preventDefault();
  attachImages(images);
};

function canAddVoice() {
  if (submitted) return false;
  if (attachments.length || selectedSticker) { showAlert('请先发送或移除当前图片或表情。'); return false; }
  return true;
}

element('attach-audio').onclick = () => { if (!recorder && canAddVoice()) element('audio-upload').click(); };
element('audio-upload').onchange = (event) => {
  const file = event.target.files[0];
  if (file && !recorder && canAddVoice()) {
    if (file.size > 8 * 1024 * 1024) showAlert('这份音频超过 8 MB，请选一段较短的音频。');
    else { setAudio(file); showAlert(); }
  }
  event.target.value = '';
};

function cancelRecording() {
  recordingGeneration++;
  clearTimeout(recordingTimer);
  if (!recorder) return;
  const current = recorder;
  recorder = null;
  if (current.state !== 'inactive') current.stop();
  for (const track of current.stream.getTracks()) track.stop();
}

element('record').onclick = async () => {
  if (recorder) { if (recorder.state !== 'inactive') recorder.stop(); return; }
  if (!canAddVoice() || !chat) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showAlert('此浏览器无法使用麦克风录音。可以选择音频文件。');
    return;
  }
  const generation = ++recordingGeneration;
  const recordingChat = chat;
  const button = element('record');
  button.disabled = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== recordingGeneration || chat !== recordingChat || !canAddVoice()) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const current = new MediaRecorder(stream);
    const chunks = [];
    current.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    current.onerror = () => {
      if (recorder !== current) return;
      cancelRecording();
      renderAttachments();
      showAlert('录音中断了。请检查麦克风，或改用音频文件。');
    };
    current.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      if (recorder !== current) return;
      clearTimeout(recordingTimer);
      recorder = null;
      const clip = new Blob(chunks, { type: current.mimeType });
      if (clip.size && clip.size <= 8 * 1024 * 1024) setAudio(clip);
      else { renderAttachments(); showAlert('录音为空或超过 8 MB，请重新录制。'); }
    };
    current.start();
    recorder = current;
    recordingTimer = setTimeout(() => { if (current.state !== 'inactive') current.stop(); }, 60_000);
    renderAttachments();
    showAlert();
  } catch {
    for (const track of stream?.getTracks() ?? []) track.stop();
    showAlert('没有录到声音。请检查麦克风权限，或选择音频文件。');
  } finally {
    button.disabled = false;
  }
};
window.addEventListener('pagehide', cancelRecording);

function renderStickers() {
  const query = element('search-stickers').value.trim().toLowerCase().replace(/^#/, '');
  const grid = element('sticker-grid');
  grid.replaceChildren();
  for (const sticker of stickerCatalog) {
    if (query && ![sticker.no, sticker.content, sticker.emotion, ...sticker.keywords].join(' ').toLowerCase().includes(query)) continue;
    const option = make('button');
    option.type = 'button';
    option.title = sticker.content || sticker.emotion || '#' + sticker.no;
    const image = make('img');
    image.src = API + 'sticker/' + encodeURIComponent(sticker.id || String(sticker.no));
    image.loading = 'lazy';
    image.alt = option.title;
    image.onerror = () => image.remove();
    option.append(image, make('span', '#' + sticker.no));
    option.onclick = () => {
      if (submitted || recorder || attachments.length || audioFile) return;
      selectedSticker = sticker;
      renderAttachments();
      element('sticker-picker').close();
      input.focus();
    };
    grid.append(option);
  }
  element('sticker-status').textContent = grid.childElementCount ? '' : '没有符合条件的表情。';
}

element('search-stickers').oninput = renderStickers;
element('close-stickers').onclick = () => element('sticker-picker').close();
element('open-stickers').onclick = async () => {
  if (submitted || recorder || !connected || attachments.length || audioFile) {
    showAlert('连上鱼姬之家并移除当前图片或语音后，再选表情。');
    return;
  }
  const picker = element('sticker-picker');
  if (picker.open) return;
  element('search-stickers').value = '';
  element('sticker-grid').replaceChildren();
  element('sticker-status').textContent = '正在加载…';
  picker.showModal();
  try { stickerCatalog = (await api('stickers')).stickers; renderStickers(); }
  catch (error) { element('sticker-status').textContent = error.message; }
};

async function sendMessage(draft, makePayload, onAccepted) {
  if (submitted || !chat || !connected || recorder) return;
  const sentChat = chat;
  submitted = true;
  input.readOnly = true;
  renderAttachments();
  try {
    const request = await makePayload(sentChat);
    if (chat !== sentChat) return;
    const cached = rows.get(request.id)?.message;
    const accepted = new Promise((resolve, reject) => { pendingAcceptance = { id: request.id, chat: sentChat, resolve, reject }; });
    const result = cached ? { message: cached } : await Promise.race([api('messages', request), accepted]);
    if (chat !== sentChat) return;
    addMessage(result.message);
    onAccepted();
    scrollToLatest();
    showAlert();
  } catch (error) {
    if (chat === sentChat && draft()?.id && rows.has(draft().id)) {
      onAccepted();
      scrollToLatest();
      showAlert();
    } else if (chat === sentChat) showAlert(error.message || '本机服务暂不可用。重连后可点击重试。');
  } finally {
    pendingAcceptance = null;
    submitted = false;
    input.readOnly = false;
    renderAttachments();
    input.focus();
  }
}

composer.onsubmit = (event) => {
  event.preventDefault();
  if (!input.value.trim() && !attachments.length && !audioFile && !selectedSticker) return;
  const text = input.value.trim();
  const quotedId = quoted?.id ?? '';
  const sticker = selectedSticker?.id || (selectedSticker ? String(selectedSticker.no) : '');
  const imagesToSend = [...attachments];
  const audioToSend = audioFile;
  return sendMessage(() => payload, async (sentChat) => {
    const images = await Promise.all(imagesToSend.map(fileData));
    const audio = audioToSend ? await fileData(audioToSend) : '';
    const next = { chat: sentChat, text, images, quoteId: quotedId, sticker, audio };
    if (!payload || JSON.stringify(payload.body) !== JSON.stringify(next)) payload = { id: crypto.randomUUID(), body: next };
    return { id: payload.id, ...next };
  }, () => {
    payload = null;
    attachments = [];
    selectedSticker = null;
    quoted = null;
    input.value = '';
    renderQuote();
    setAudio(null);
  });
};

element('poke').onclick = () => sendMessage(() => pendingPoke, (sentChat) => {
  if (pendingPoke?.chat !== sentChat) pendingPoke = { id: crypto.randomUUID(), chat: sentChat, action: 'poke' };
  return pendingPoke;
}, () => { pendingPoke = null; });
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
    updateTurns(value.turns);
    button.hidden = !value.more;
    timeline.scrollTop += timeline.scrollHeight - before;
  } catch (error) { showAlert(error.message); }
  finally { button.disabled = false; }
};
function jumpHighlight(row) {
  row.classList.add('history-target');
  row.scrollIntoView({ block: 'center' });
  setTimeout(() => row.classList.remove('history-target'), 3200);
}

async function jumpToMessage(id, fromSearch = false) {
  if (!id || !chat) return;
  const search = element('history-search');
  const context = element('history-context');
  const visible = !fromSearch && !context.open && rows.get(id)?.row;
  if (visible) { jumpHighlight(visible); return; }
  const currentChat = chat;
  const request = ++historyRequest;
  try {
    const value = await api('around?' + new URLSearchParams({ chat: currentChat, id }));
    if (value.chat !== chat || request !== historyRequest) return;
    if (search.open) search.close();
    const container = element('history-messages');
    container.replaceChildren();
    let target;
    for (const message of value.messages) {
      const row = addMessage(message, false, container);
      if (message.id === value.target) target = row;
    }
    if (!context.open) context.showModal();
    if (target) requestAnimationFrame(() => jumpHighlight(target));
  } catch (error) {
    if (request !== historyRequest) return;
    if (search.open) element('history-status').textContent = error.message;
    else showAlert(error.message);
  }
}

async function searchHistory(older = false) {
  const request = ++historyRequest;
  const results = element('history-results');
  const notice = element('history-status');
  const more = element('history-more');
  const position = older ? nextSearchPage : null;
  const options = new URLSearchParams(position?.options ?? {
    chat, q: element('history-query').value.trim(), kind: element('history-kind').value,
  });
  if (position) options.set('before', String(position.before));
  if (!older) {
    nextSearchPage = null;
    results.replaceChildren();
  }
  more.hidden = true;
  if (!options.get('q') && !options.get('kind')) {
    notice.textContent = '输入关键词，或按图片、语音和表情找消息。';
    return;
  }
  notice.textContent = '正在搜索…';
  try {
    const value = await api('search?' + options);
    if (value.chat !== chat || request !== historyRequest) return;
    for (const message of value.messages) {
      const type = message.attachments?.[0]?.type ?? '';
      const preview = message.text || (type.startsWith('audio/') ? '[语音]' :
        message.action === 'sticker' ? '[表情]' : type.startsWith('image/') ? '[图片]' : '[消息]');
      const button = make('button', time.format(message.at) + ' · ' + preview.slice(0, 140));
      button.type = 'button';
      button.onclick = () => void jumpToMessage(message.id, true);
      results.append(button);
    }
    notice.textContent = results.childElementCount ? '' : '没有找到消息。';
    nextSearchPage = value.more ? { options, before: value.messages.at(-1).seq } : null;
    more.hidden = !nextSearchPage;
  } catch (error) {
    if (request !== historyRequest) return;
    notice.textContent = error.message;
    more.hidden = !nextSearchPage;
  }
}

element('open-history').onclick = () => {
  if (!chat) return;
  const dialog = element('history-search');
  if (!dialog.open) dialog.showModal();
  element('history-query').focus();
};
for (const id of ['history-search', 'history-context']) {
  const dialog = element(id);
  dialog.oncancel = () => { historyRequest++; };
  element('close-' + id).onclick = () => { historyRequest++; dialog.close(); };
}
element('history-form').onsubmit = (event) => { event.preventDefault(); void searchHistory(); };
element('history-more').onclick = () => void searchHistory(true);

element('close-preview').onclick = () => element('preview').close();
async function connect() {
  clearTimeout(backoff);
  streamConnection?.close();
  try {
    if (!chat) {
      const initial = await api('state');
      apply(initial, true);
    } else {
      // Distinguish a lost connection from expired browser pairing without resetting the timeline.
      await api('state?before=1');
    }
    streamConnection = new EventSource(API + 'events?chat=' + encodeURIComponent(chat) + '&after=' + cursor);
    streamConnection.onmessage = (event) => {
      setConnection('已连接', true);
      clearTimeout(backoff);
      try { apply(JSON.parse(event.data)); }
      catch { showAlert('聊天更新未能载入。可刷新后重新连接。'); }
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
