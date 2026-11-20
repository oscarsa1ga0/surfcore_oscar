function createRoomPanel({ api, element, make, getChat }) {
  const dialog = element('room-panel');
  const status = element('room-status');
  const cards = element('room-cards');
  const refreshButton = element('room-refresh');
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
  const activities = { web: '正在聊天', bili: '正在逛 B 站', diary: '正在整理日记', pet: '正在用桌宠聊天' };
  const metricLabels = { joy: '愉悦', curiosity: '好奇', reflection: '思考', fatigue: '疲惫' };
  let request = 0;

  function heading({ name, activity }) {
    element('room-title').textContent = `${name || '鱼姬'}的小屋`;
    element('room-activity').textContent = activities[activity] || '这会儿空闲';
  }

  function render(data) {
    heading(data);
    element('room-mood').textContent = data.mood?.label || '暂时没有心境记录。';
    element('room-metrics').replaceChildren(...Object.entries(data.mood?.metrics ?? {}).map(([key, value]) => {
      const label = make('label', metricLabels[key]);
      const bar = make('meter');
      bar.min = 0;
      bar.max = 100;
      bar.value = value;
      label.append(bar);
      return label;
    }));
    element('room-diary-date').textContent = data.diary.reviewedDay ? `最近回顾 · ${data.diary.reviewedDay}` : '暂时没有回顾记录。';
    element('room-diary-shares').replaceChildren(...(data.diary.shares.length ? data.diary.shares.map(({ date, excerpt }) => {
      const note = make('blockquote', excerpt);
      note.append(make('footer', `${date} · 已分享摘录`));
      return note;
    }) : [make('p', '还没有分享的摘录。', 'room-empty')]));
    element('room-watches').replaceChildren(...(data.watches.length ? data.watches.map(({ at, unknownDate, bvid, title }) => {
      const row = make('p', '', 'room-watch');
      const link = make('a', title);
      link.href = 'https://www.bilibili.com/video/' + bvid;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      row.append(link);
      if (!unknownDate) row.append(make('small', dateFormat.format(new Date(at))));
      return row;
    }) : [make('p', '还没有观看记录。', 'room-empty')]));
    cards.hidden = false;
  }

  async function refresh() {
    const role = getChat();
    const version = ++request;
    cards.hidden = true;
    element('room-title').textContent = '小屋近况';
    element('room-activity').textContent = '';
    if (!role) {
      status.textContent = '聊天连接后就能查看小屋。若尚未配对，请从 SurfCore 设置打开鱼姬之家。';
      refreshButton.disabled = false;
      return;
    }
    status.textContent = '正在读取近况…';
    refreshButton.disabled = true;
    try {
      const data = await api('room?' + new URLSearchParams({ chat: role }));
      if (version !== request || !dialog.open || getChat() !== role || data.chat !== role) return;
      render(data);
      status.textContent = '';
    } catch (error) {
      if (version === request && dialog.open) status.textContent = error.hint ? error.message : `${error.message} 点「刷新」重试。`;
    } finally {
      if (version === request) refreshButton.disabled = false;
    }
  }

  for (const button of document.querySelectorAll('[data-open-room]')) {
    button.onclick = () => {
      if (!dialog.open) dialog.showModal();
      return refresh();
    };
  }
  refreshButton.onclick = refresh;
  element('room-close').onclick = () => dialog.close();
  return {
    update(value, roleChanged) {
      if (!dialog.open) return;
      if (roleChanged) void refresh();
      else if (!cards.hidden) heading({ name: value.name, activity: value.occupied });
    },
  };
}
