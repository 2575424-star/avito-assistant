/* Авито Ассистент — интерфейс (без сборки) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = () => $('#view');

const state = { status: null, chatFilter: '', chatQuery: '', chatId: null, chatTimer: null, timers: [], sandbox: [], sandboxItem: { title: '', price: '', id: '' }, runFilter: 'unrated', kbCat: '' };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/api/login')) { showLogin(); throw new Error('Нужна авторизация'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(text, isError = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const today = new Date();
  const opts = { timeZone: 'Europe/Moscow' };
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('ru-RU', { ...opts, hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru-RU', { ...opts, day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('ru-RU', { ...opts, hour: '2-digit', minute: '2-digit' });
};
const fmtDate = (ts) => ts ? new Date(ts * 1000).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : '';
const initials = (n) => (String(n || '?').trim()[0] || '?').toUpperCase();
const dateInput = (d) => d.toISOString().slice(0, 10);

// ---------- auth ----------
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#loginPassword').focus();
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/login', { body: { password: $('#loginPassword').value } });
    $('#login').classList.add('hidden');
    boot();
  } catch (err) { $('#loginError').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => { await api('/api/logout', { body: {} }); location.reload(); });

// ---------- header ----------
async function loadStatus() {
  const s = await api('/api/status');
  state.status = s;
  $('#accName').textContent = s.avitoProfile || 'Кабинет Авито';
  $('#accAvatar').textContent = initials(s.avitoProfile || 'А');
  $('#accSub').textContent = s.avitoUserId ? `ID продавца ${s.avitoUserId}` : 'Авито не подключён — откройте Настройки → Авито';
  $('#aiGlobal').checked = s.aiEnabled;
  $('#aiSince').textContent = s.aiEnabled && s.aiStartedAt ? 'с ' + fmtDate(s.aiStartedAt) : 'выкл';
  $('#modeBadge').classList.toggle('hidden', s.sendEnabled);
  const lp = s.lastPoll || {};
  $('#connState').innerHTML = s.avitoConfigured
    ? (lp.ok === false ? `<span style="color:var(--red)">● Ошибка синхронизации</span>` : `<span style="color:var(--green)">●</span> Синхр.: ${lp.at ? fmtTime(lp.at) : '—'}`)
    : '<span style="color:var(--orange)">●</span> Авито не подключён';
  return s;
}
$('#aiGlobal').addEventListener('change', async (e) => {
  const on = e.target.checked;
  if (on && (!state.status?.avitoConfigured || !state.status?.openaiConfigured)) {
    e.target.checked = false;
    return toast('Сначала подключите Авито и ключ OpenAI в настройках', true);
  }
  await api('/api/ai', { body: { enabled: on } });
  toast(on ? (state.status?.sendEnabled ? 'ИИ включён — бот отвечает на новые сообщения' : 'ИИ включён в тестовом режиме: ответы на новые сообщения сохраняются черновиками, в Авито ничего не уходит') : 'ИИ выключен');
  loadStatus();
});

// ---------- router ----------
const routes = { dashboard: renderDashboard, chats: renderChats, leads: renderLeads, settings: renderSettings, archive: renderArchive, kb: renderKb, review: renderReview };
function route() {
  clearInterval(state.chatTimer);
  state.timers.forEach(clearInterval);
  state.timers = [];
  const parts = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
  const page = routes[parts[0]] ? parts[0] : 'dashboard';
  $$('[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === page));
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (page === 'settings' && parts[1] === 'sandbox' ? 'sandbox' : page)));
  view().className = 'view' + (page === 'chats' ? ' flush' : '');
  routes[page](parts.slice(1)).catch((e) => { view().innerHTML = `<div class="notice">${esc(e.message)}</div>`; });
}
window.addEventListener('hashchange', route);

// ---------- dashboard ----------
async function renderDashboard() {
  const s = state.status || (await loadStatus());
  const to = new Date();
  const from = s.aiStartedAt ? new Date(s.aiStartedAt * 1000) : new Date(Date.now() - 13 * 86400000);
  const d = await api(`/api/dashboard?from=${dateInput(from)}&to=${dateInput(to)}`);
  const tag = (ok, yes, no) => `<span class="badge ${ok ? 'green' : 'orange'}">${ok ? yes : no}</span>`;
  view().innerHTML = `
    <div class="card"><div class="status-strip">
      ${tag(s.avitoConfigured && s.avitoUserId, 'Авито подключён', 'Авито не подключён')}
      ${tag(s.token?.hasToken, 'Токен активен', 'Токен не получен')}
      ${tag(s.openaiConfigured, 'OpenAI: ' + esc(s.model), 'Нет ключа OpenAI')}
      ${tag(s.aiEnabled, 'AI включён', 'AI выключен')}
      <span class="badge">Чатов в базе: <b>&nbsp;${s.stats.chats}</b></span>
      <span class="badge">Ждут ответа: <b>&nbsp;${d.waiting}</b></span>
    </div></div>

    <div class="section-title"><h2>${s.aiStartedAt ? 'С запуска ИИ' : 'За 14 дней'}</h2><span class="muted">${fmtDate(from / 1000)} — ${fmtDate(to / 1000)}</span></div>

    <div class="card row" style="gap:20px">
      <div class="avatar" style="background:var(--orange-soft);color:var(--orange)">☎</div>
      <div><div class="kpi-label">Успешные чаты (оставили телефон)</div><div class="kpi-value orange">${d.leads}</div>
      <div class="muted small">входящие ${d.leadsIn} · прочие ${d.leads - d.leadsIn}</div></div>
    </div>

    <div class="grid c3" style="margin-top:16px">
      <div class="card"><h3><span class="dot" style="background:var(--accent)"></span>ВХОДЯЩИЕ ЧАТЫ</h3><div class="stat-list">
        <div><span>Новых входящих чатов</span><b>${d.incoming}</b></div>
        <div><span>Успешные</span><b>${d.leadsIn}</b></div>
        <div><span>Конверсия</span><b>${d.conversion}%</b></div></div></div>
      <div class="card"><h3><span class="dot" style="background:var(--green)"></span>РАБОТА БОТА</h3><div class="stat-list">
        <div><span>Сообщений отправлено</span><b>${d.botMsgs}</b></div>
        <div><span>Чатов с ответом бота</span><b>${d.botChats}</b></div>
        <div><span>Передано менеджеру</span><b>${d.handoffs}</b></div></div></div>
      <div class="card"><h3><span class="dot" style="background:var(--orange)"></span>КЛИЕНТЫ</h3><div class="stat-list">
        <div><span>Сообщений от клиентов</span><b>${d.clientMsgs}</b></div>
        <div><span>Ждут ответа (24 ч)</span><b>${d.waiting}</b></div>
        <div><span>Всего чатов в базе</span><b>${d.totalChats}</b></div></div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="row"><h3 style="margin:0">ГРАФИК ДИНАМИКИ</h3><span class="spacer"></span>
        <div class="legend"><span class="badge blue">● Входящие чаты</span><span class="badge green">● Успешные</span><span class="badge orange">● Ответы бота</span></div></div>
      ${chartSvg(d.days)}
    </div>`;
}

function chartSvg(days) {
  if (!days.length) return '<div class="muted">Нет данных</div>';
  const W = 900, H = 220, P = 30;
  const max = Math.max(5, ...days.flatMap((d) => [d.incoming, d.leads, d.bot]));
  const x = (i) => P + (days.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (days.length - 1));
  const y = (v) => H - P - (v / max) * (H - 2 * P);
  const line = (key, color) => `<polyline fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" points="${days.map((d, i) => `${x(i)},${y(d[key])}`).join(' ')}"/>` +
    days.map((d, i) => `<circle cx="${x(i)}" cy="${y(d[key])}" r="3.5" fill="${color}"><title>${d.day}: ${d[key]}</title></circle>`).join('');
  const grid = [0, 0.5, 1].map((f) => `<line x1="${P}" x2="${W - P}" y1="${y(max * f)}" y2="${y(max * f)}" stroke="var(--border)"/><text x="4" y="${y(max * f) + 4}" font-size="11" fill="var(--muted)">${Math.round(max * f)}</text>`).join('');
  const step = Math.ceil(days.length / 12);
  const labels = days.map((d, i) => i % step ? '' : `<text x="${x(i)}" y="${H - 8}" font-size="11" text-anchor="middle" fill="var(--muted)">${d.day}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${line('incoming', 'var(--accent)')}${line('leads', 'var(--green)')}${line('bot', 'var(--orange)')}${labels}</svg>`;
}

// ---------- chats ----------
const FILTERS = [['', 'Все'], ['ai_on', 'AI вкл'], ['ai_off', 'AI выкл'], ['contact', 'Контакт'], ['no_contact', 'Без контакта'], ['waiting', 'Без ответа'], ['manager', 'У менеджера']];

async function renderChats(parts) {
  state.chatId = parts[0] ? decodeURIComponent(parts[0]) : null;
  view().innerHTML = `
    <div class="chats-layout ${state.chatId ? 'has-chat' : ''}">
      <div class="chat-list">
        <div class="chat-list-head">
          <input type="search" id="chatSearch" placeholder="Имя, телефон, слово в переписке…" value="${esc(state.chatQuery)}">
          <div class="chips">${FILTERS.map(([k, l]) => `<button class="chip ${state.chatFilter === k ? 'active' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
        </div>
        <div class="chat-count" id="chatCount">Загрузка…</div>
        <div class="chat-items" id="chatItems"></div>
      </div>
      <div class="chat-pane" id="chatPane"><div class="empty">Выберите чат</div></div>
    </div>`;
  let t;
  $('#chatSearch').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.chatQuery = e.target.value; loadChatList(); }, 300); });
  $$('.chip[data-f]').forEach((b) => b.addEventListener('click', () => {
    state.chatFilter = b.dataset.f;
    $$('.chip[data-f]').forEach((x) => x.classList.toggle('active', x === b));
    loadChatList();
  }));
  await loadChatList();
  if (state.chatId) await loadChat(state.chatId);
  state.chatTimer = setInterval(() => { loadChatList(true); if (state.chatId) loadChat(state.chatId, true); }, 10000);
}

async function loadChatList(silent) {
  const d = await api(`/api/chats?filter=${state.chatFilter}&q=${encodeURIComponent(state.chatQuery)}&limit=200`);
  const box = $('#chatItems');
  if (!box) return;
  $('#chatCount').textContent = `${d.total} чатов`;
  if (!d.chats.length) {
    box.innerHTML = `<div class="empty small">${state.status?.avitoConfigured ? 'Чатов пока нет. Нажмите «Синхронизировать» в Настройки → Авито.' : 'Подключите Авито в Настройки → Авито'}</div>`;
    return;
  }
  const scroll = box.scrollTop;
  box.innerHTML = d.chats.map((c) => `
    <div class="chat-item ${c.id === state.chatId ? 'active' : ''}" data-id="${esc(c.id)}">
      <div class="avatar sm">${esc(initials(c.client_name))}</div>
      <div class="body">
        <div class="top"><span class="name">${esc(c.client_name || 'Покупатель')}</span>
          <span class="row" style="gap:6px;flex-wrap:nowrap">${c.needs_reply ? '<span class="badge orange">без ответа</span>' : ''}<span class="small muted">${fmtTime(c.last_at || c.updated)}</span></span></div>
        <div class="item">${esc(c.item_title || 'Личный чат')}</div>
        <div class="small" style="color:${c.status === 'manager' ? 'var(--orange)' : c.ai_enabled ? 'var(--green)' : 'var(--muted)'}">${c.status === 'manager' ? 'У менеджера' : c.ai_enabled ? 'AI активен' : 'AI выключен'}</div>
        <div class="preview">${c.last_direction === 'out' ? '↪ ' : ''}${esc(c.last_text || '')}</div>
        ${c.phone ? `<div class="tags"><span class="badge green">Контакт</span><span class="badge">${esc(c.phone)}</span></div>` : ''}
      </div>
    </div>`).join('');
  if (silent) box.scrollTop = scroll;
  $$('.chat-item', box).forEach((el) => el.addEventListener('click', () => { location.hash = '#/chats/' + encodeURIComponent(el.dataset.id); }));
}

const SOURCE_LABEL = { bot: '🤖 ИИ', quick: '⚡ быстрый ответ', template: '📋 шаблон', manager: '👤 менеджер', client: '', system: '' };

async function loadChat(id, silent) {
  const pane = $('#chatPane');
  if (!pane) return;
  const d = await api('/api/chats/' + encodeURIComponent(id));
  const c = d.chat;
  if ($('.fix-box:not(.hidden)', pane) && silent) return; // не перерисовываем, пока пользователь правит черновик
  // черновики ИИ показываем после сообщения клиента, на которое они отвечали (последний прогон)
  const runsByMsg = {};
  for (const r of d.runs || []) {
    const byModel = (runsByMsg[r.at_message_id] ||= {});
    byModel[r.model || ''] = r; // последний ответ каждой модели
  }
  for (const k of Object.keys(runsByMsg)) runsByMsg[k] = Object.values(runsByMsg[k]);
  const box = $('.messages', pane);
  const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const draft = $('#composerText')?.value || '';
  pane.innerHTML = `
    <div class="chat-head">
      <a href="#/chats" class="btn sm" title="Назад">←</a>
      <div class="avatar sm">${esc(initials(c.client_name))}</div>
      <div style="min-width:0"><b>${esc(c.client_name || 'Покупатель')}</b>
        <div class="small" style="color:var(--accent)">${esc(c.item_title || 'Личный чат')}${c.item_price ? ' · ' + esc(c.item_price) : ''}</div></div>
      <span class="spacer"></span>
      ${c.phone ? `<span class="badge green">${esc(c.phone)}</span>` : ''}
      ${c.status === 'manager' ? '<button class="btn sm" id="resumeBot" title="Вернуть чат боту">Вернуть боту</button>' : ''}
      <button class="btn sm" id="replayChat" title="Прогнать ИИ по всей переписке: что бы он ответил на каждое сообщение клиента. В Авито ничего не отправляется.">🧪 Прогнать ИИ</button>
      <button class="btn sm" id="reviewChat" title="Разбор переписки нейросетью: ошибки продавца, вопросы клиента, как надо было ответить">🔍 Разбор</button>
      <button class="btn sm" id="replyNow" title="${d.sendEnabled ? 'Сгенерировать и отправить ответ ИИ прямо сейчас' : 'Сгенерировать черновик ответа на последнее сообщение (без отправки)'}">🤖 ${d.sendEnabled ? 'Ответить ИИ' : 'Черновик ИИ'}</button>
      <button class="btn sm" id="syncChat" title="Обновить из Авито">⟳</button>
      <a class="btn sm" target="_blank" rel="noopener" href="https://www.avito.ru/profile/messenger/channel/${encodeURIComponent(c.id)}" title="Открыть на Авито">↗</a>
      ${c.item_url ? `<a class="btn sm" target="_blank" rel="noopener" href="${esc(c.item_url)}" title="Объявление">📄</a>` : ''}
      <span class="small muted">AI</span><label class="switch"><input type="checkbox" id="chatAi" ${c.ai_enabled ? 'checked' : ''}><span></span></label>
    </div>
    ${d.review ? reviewBox(d.review) : ''}
    <div class="messages">${d.messages.map((m) => {
      const drafts = (runsByMsg[m.id] || []).map(runBubble).join('');
      if (m.source === 'system') return `<div class="msg system">${esc(m.text)}<div class="meta">Авито · ${fmtTime(m.created)}</div></div>` + drafts;
      return `<div class="msg ${m.direction} ${m.source}">${esc(m.text)}<div class="meta">${SOURCE_LABEL[m.source] || ''} ${fmtTime(m.created)}</div></div>` + drafts;
    }).join('') || '<div class="empty">Сообщений нет</div>'}</div>
    <div class="composer">
      ${d.sendEnabled
        ? `<textarea id="composerText" rows="1" placeholder="Написать сообщение от менеджера (бот в этом чате встанет на паузу)…">${esc(draft)}</textarea>
      <button class="btn primary" id="sendBtn">Отправить</button>`
        : '<div class="muted small">Тестовый режим: отвечать из этого окна нельзя. Пунктирные пузыри — черновики ИИ: оцените их 👍/👎 или исправьте, исправления попадут в базу знаний.</div>'}
    </div>`;
  const msgs = $('.messages', pane);
  if (!silent || atBottom) msgs.scrollTop = msgs.scrollHeight;

  $('#chatAi').addEventListener('change', async (e) => { await api(`/api/chats/${encodeURIComponent(id)}/ai`, { body: { enabled: e.target.checked } }); toast(e.target.checked ? 'AI в чате включён' : 'AI в чате выключен'); loadChatList(true); });
  $('#syncChat').addEventListener('click', async () => { try { await api(`/api/chats/${encodeURIComponent(id)}/sync`, { body: {} }); loadChat(id); } catch (e) { toast(e.message, true); } });
  $('#resumeBot')?.addEventListener('click', async () => { await api(`/api/chats/${encodeURIComponent(id)}/status`, { body: { status: 'active' } }); toast('Чат возвращён боту'); loadChat(id); });
  bindRuns(pane, () => loadChat(id, true));
  const busy = (btn, fn) => btn.addEventListener('click', async () => {
    const txt = btn.textContent; btn.disabled = true; btn.textContent = '…думает';
    try { await fn(); } catch (err) { toast(err.message, true); }
    btn.disabled = false; btn.textContent = txt;
  });
  busy($('#replyNow'), async () => {
    const r = await api(`/api/chats/${encodeURIComponent(id)}/reply-now`, { body: {} });
    if (r.draft !== undefined) toast('Черновик готов — он под последним сообщением клиента');
    else toast(r.sent ? 'Ответ отправлен' : 'Не отправлено: ' + (r.skipped || ''), !r.sent);
    loadChat(id);
  });
  busy($('#replayChat'), async () => {
    const r = await api(`/api/chats/${encodeURIComponent(id)}/replay`, { body: { maxTurns: 8 } });
    toast(`${r.models.length > 1 ? r.models.length + ' модели ответили' : 'ИИ ответил'} на ${r.turns} сообщений клиента (${r.tokens} ток.${r.errors ? ', ошибок ' + r.errors : ''}). Сравните с ответами менеджера.`);
    loadChat(id);
  });
  busy($('#reviewChat'), async () => {
    await api(`/api/chats/${encodeURIComponent(id)}/review`, { body: {} });
    loadChat(id);
  });
  if (!d.sendEnabled) return;
  const send = async () => {
    const text = $('#composerText').value.trim();
    if (!text) return;
    $('#sendBtn').disabled = true;
    try {
      await api(`/api/chats/${encodeURIComponent(id)}/send`, { body: { text } });
      $('#composerText').value = '';
      loadChat(id); loadChatList(true);
    } catch (e) { toast(e.message, true); $('#sendBtn').disabled = false; }
  };
  $('#sendBtn').addEventListener('click', send);
  $('#composerText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });
}

// ---------- leads ----------
async function renderLeads() {
  const s = state.status || (await loadStatus());
  const to = dateInput(new Date());
  const from = dateInput(s.aiStartedAt ? new Date(s.aiStartedAt * 1000) : new Date(Date.now() - 30 * 86400000));
  view().innerHTML = `
    <div class="row" style="margin-bottom:16px">
      <b id="leadCount" style="font-size:18px">—</b><span class="muted">успешных чатов</span>
      <input type="date" id="lFrom" value="${from}" style="width:auto"> — <input type="date" id="lTo" value="${to}" style="width:auto">
      <a class="btn" id="exportBtn">⬇ Экспорт CSV</a>
    </div>
    <div class="table-wrap"><table class="table"><thead><tr><th>Имя</th><th>Объявление</th><th>Тип</th><th>Дата контакта</th><th>Контакт</th><th></th></tr></thead><tbody id="leadRows"></tbody></table></div>`;
  const load = async () => {
    const q = `from=${$('#lFrom').value}&to=${$('#lTo').value}`;
    $('#exportBtn').href = '/api/leads.csv?' + q;
    const d = await api('/api/leads?' + q);
    $('#leadCount').textContent = d.leads.length;
    $('#leadRows').innerHTML = d.leads.map((l) => `<tr>
      <td><b>${esc(l.client_name || 'Покупатель')}</b></td>
      <td class="muted">${esc(l.item_title || 'Личный чат')}</td>
      <td><span class="badge ${l.lead_channel === 'Входящий' ? 'green' : 'blue'}">${esc(l.lead_channel || '—')}</span></td>
      <td>${fmtTime(l.lead_at)}</td>
      <td><a href="tel:${esc(l.phone)}">${esc(l.phone)}</a></td>
      <td style="white-space:nowrap"><a href="#/chats/${encodeURIComponent(l.id)}">В чат →</a> &nbsp; <a target="_blank" rel="noopener" class="muted" href="https://www.avito.ru/profile/messenger/channel/${encodeURIComponent(l.id)}">Авито ↗</a></td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">Пока нет чатов с оставленным телефоном</td></tr>';
  };
  $('#lFrom').addEventListener('change', load);
  $('#lTo').addEventListener('change', load);
  await load();
}

// ---------- settings ----------
const SUBTABS = [['agent', 'Агент'], ['templates', 'Шаблоны'], ['sandbox', 'Тест агента'], ['avito', 'Авито'], ['notify', 'Уведомления'], ['log', 'Журнал']];

async function renderSettings(parts) {
  const sub = SUBTABS.some(([k]) => k === parts[0]) ? parts[0] : 'agent';
  const head = `<div class="subtabs">${SUBTABS.map(([k, l]) => `<a href="#/settings/${k}" class="${k === sub ? 'active' : ''}">${l}</a>`).join('')}</div>`;
  view().innerHTML = head + '<div id="sub"></div>';
  const box = $('#sub');
  const s = await api('/api/settings');
  ({ agent: settingsAgent, templates: settingsTemplates, sandbox: settingsSandbox, avito: settingsAvito, notify: settingsNotify, log: settingsLog })[sub](box, s);
}

function bindSave(box, keys, btnSel = '.save') {
  $(btnSel, box).addEventListener('click', async () => {
    const body = {};
    for (const k of keys) {
      const el = box.querySelector(`[name="${k}"]`);
      if (!el) continue;
      body[k] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
    }
    try { await api('/api/settings', { body }); toast('Сохранено'); loadStatus(); } catch (e) { toast(e.message, true); }
  });
}

const tog = (name, s, title, help) => `<div class="toggle-row"><label class="switch"><input type="checkbox" name="${name}" ${s[name] === '1' ? 'checked' : ''}><span></span></label><div><b>${title}</b><div class="muted small">${help}</div></div></div>`;

function settingsAgent(box, s) {
  box.innerHTML = `
    <div class="card"><h3>Режим работы</h3>
      <div class="toggle-row"><label class="switch"><input type="checkbox" id="sendEnabled" ${s.send_enabled === '1' ? 'checked' : ''}><span></span></label>
        <div><b>Боевой режим: отправлять ответы в Авито</b><div class="muted small">Выключено — тестовый режим: ИИ пишет черновики (видны в чатах и в «Проверке ответов»), в Авито ничего не отправляется и чаты не отмечаются прочитанными. Включайте, только когда ответы устраивают и прежний бот в кабинете отключён.</div></div></div>
    </div>
    <div class="card"><h3>Основное</h3><div class="form">
      <div class="grid c2">
        <label>Имя AI-консультанта<input type="text" name="assistant_name" value="${esc(s.assistant_name)}"></label>
        <label>Модель OpenAI<input type="text" name="openai_model" value="${esc(s.openai_model)}" placeholder="gpt-4o-mini"></label>
        <label>Задержка перед ответом, сек<input type="number" name="reply_delay_sec" value="${esc(s.reply_delay_sec)}" min="0"><span class="field-help">Ждём, пока клиент допишет несколько сообщений подряд</span></label>
        <label>Лимит ответов бота в одном чате<input type="number" name="max_bot_replies" value="${esc(s.max_bot_replies)}" min="1"></label>
        <label>Креативность (temperature)<input type="number" step="0.1" min="0" max="1.5" name="temperature" value="${esc(s.temperature)}"></label>
        <label>Отвечать на сообщения не старше, мин<input type="number" name="only_new_messages_min" value="${esc(s.only_new_messages_min)}" min="1"></label>
        <label>Модель для разбора переписок<input type="text" name="analysis_model" value="${esc(s.analysis_model)}" placeholder="как у агента"><span class="field-help">Для отчётов можно взять модель посильнее агента</span></label>
        <label>База знаний в промпте, символов<input type="number" name="kb_budget_chars" value="${esc(s.kb_budget_chars)}" min="1000" step="1000"><span class="field-help">Больше — агент знает больше, но ответ дороже</span></label>
      </div>
    </div></div>

    <div class="card"><h3>Правила ответа (промпт)</h3><div class="form">
      <label>Как агент должен отвечать<textarea name="rules" rows="12">${esc(s.rules)}</textarea>
      <span class="field-help">Цель, тон, что можно и нельзя говорить. Проверяйте изменения во вкладке «Тест агента».</span></label>
      <label>Информация о компании<textarea name="company_info" rows="7" placeholder="Название, адрес, часы работы, условия трейд-ина и кредита, что есть в наличии…">${esc(s.company_info)}</textarea></label>
    </div></div>

    <div class="card"><h3>Поведение</h3>
      ${tog('answer_personal', s, 'Отвечать в личных чатах', 'Переписка, начатая не с объявления. Карточки товара у агента нет — отвечает по информации о компании.')}
      ${tog('pause_on_manager', s, 'Пауза, когда пишет менеджер', 'Если менеджер ответил в чате вручную (здесь или на Авито), бот в этом чате замолкает.')}
      ${tog('quick_reply_enabled', s, 'Быстрый ответ', 'Уходит через 2–3 секунды после первого сообщения покупателя, до ответа ИИ. Один раз на чат.')}
      <label style="margin-top:6px">Текст быстрого ответа<textarea name="quick_reply_text" rows="3" maxlength="500" placeholder="Здравствуйте! Сейчас посмотрю информацию и отвечу.">${esc(s.quick_reply_text)}</textarea></label>
    </div>
    <div class="row" style="margin-top:16px"><button class="btn primary save">Сохранить</button></div>`;
  bindSave(box, ['assistant_name', 'openai_model', 'reply_delay_sec', 'max_bot_replies', 'temperature', 'only_new_messages_min', 'analysis_model', 'kb_budget_chars', 'rules', 'company_info', 'answer_personal', 'pause_on_manager', 'quick_reply_enabled', 'quick_reply_text']);
  $('#sendEnabled').addEventListener('change', async (e) => {
    const on = e.target.checked;
    if (on && !confirm('Включить боевой режим? Бот начнёт отправлять ответы покупателям в Авито от имени кабинета.')) { e.target.checked = false; return; }
    await api('/api/settings', { body: { send_enabled: on ? '1' : '0' } });
    toast(on ? 'Боевой режим: ответы уходят в Авито' : 'Тестовый режим: в Авито ничего не отправляется');
    loadStatus();
  });
}

async function settingsTemplates(box) {
  const d = await api('/api/templates');
  box.innerHTML = `
    <div class="notice info" style="margin-bottom:16px">Шаблоны — готовые ответы на системные сообщения Авито (например, «Пользователь создал чат, но пока ничего не написал»). ИИ на такие сообщения не отвечает: срабатывает только шаблон, один раз на чат.</div>
    <div class="card"><h3 id="tplTitle">Новый шаблон</h3><div class="form">
      <input type="hidden" id="tplId">
      <div class="grid c2">
        <label>flow_id системного сообщения<input type="text" id="tplFlow" placeholder="напр. two_way_chats"></label>
        <label>…или фраза в тексте<input type="text" id="tplMatch" placeholder="напр. создал чат"></label>
      </div>
      <label>Текст ответа<textarea id="tplReply" rows="3" maxlength="1000"></textarea></label>
      <div class="row"><button class="btn primary" id="tplSave">Сохранить шаблон</button><button class="btn" id="tplReset">Очистить</button></div>
    </div></div>

    <div class="card"><h3>Шаблоны</h3>
      <div class="table-wrap" style="box-shadow:none"><table class="table"><thead><tr><th>Срабатывает на</th><th>Ответ</th><th>Использован</th><th></th></tr></thead><tbody>
      ${d.templates.map((t) => `<tr><td><code>${esc(t.flow_id || '')}</code> ${t.match_text ? '«' + esc(t.match_text) + '»' : ''}</td><td>${esc(t.reply)}</td><td>${t.hits}</td>
        <td style="white-space:nowrap"><button class="btn sm" data-edit="${t.id}">Изменить</button> <button class="btn sm danger" data-del="${t.id}">Удалить</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Шаблонов пока нет</td></tr>'}
      </tbody></table></div></div>

    <div class="card"><h3>Системные сообщения, которые уже встречались</h3>
      <div class="table-wrap" style="box-shadow:none"><table class="table"><thead><tr><th>flow_id</th><th>Пример</th><th>Раз</th><th></th></tr></thead><tbody>
      ${d.seen.map((x) => `<tr><td><code>${esc(x.flow_id)}</code></td><td class="muted small">${esc(x.sample)}</td><td>${x.hits}</td><td><button class="btn sm" data-use="${esc(x.flow_id)}">+ Шаблон</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Появятся после синхронизации чатов</td></tr>'}
      </tbody></table></div></div>`;
  const reset = () => { $('#tplId').value = ''; $('#tplFlow').value = ''; $('#tplMatch').value = ''; $('#tplReply').value = ''; $('#tplTitle').textContent = 'Новый шаблон'; };
  $('#tplReset').addEventListener('click', reset);
  $('#tplSave').addEventListener('click', async () => {
    try {
      await api('/api/templates', { body: { id: $('#tplId').value || undefined, flow_id: $('#tplFlow').value.trim(), match_text: $('#tplMatch').value.trim(), reply: $('#tplReply').value } });
      toast('Шаблон сохранён'); settingsTemplates(box);
    } catch (e) { toast(e.message, true); }
  });
  $$('[data-edit]', box).forEach((b) => b.addEventListener('click', () => {
    const t = d.templates.find((x) => x.id === Number(b.dataset.edit));
    $('#tplId').value = t.id; $('#tplFlow').value = t.flow_id || ''; $('#tplMatch').value = t.match_text || ''; $('#tplReply').value = t.reply; $('#tplTitle').textContent = 'Шаблон #' + t.id;
    box.scrollIntoView({ behavior: 'smooth' });
  }));
  $$('[data-del]', box).forEach((b) => b.addEventListener('click', async () => { await api('/api/templates/' + b.dataset.del, { method: 'DELETE' }); settingsTemplates(box); }));
  $$('[data-use]', box).forEach((b) => b.addEventListener('click', () => { reset(); $('#tplFlow').value = b.dataset.use; $('#tplReply').focus(); box.scrollIntoView({ behavior: 'smooth' }); }));
}

async function settingsSandbox(box) {
  const cars = (await api('/api/items').catch(() => ({ items: [] }))).items.filter((x) => x.avito_id);
  const render = () => {
    box.innerHTML = `
      <div class="sandbox">
        <div class="card">
          <div class="row" style="margin-bottom:12px"><h3 style="margin:0">Диалог с агентом</h3><span class="spacer"></span><button class="btn sm" id="sbClear">Начать заново</button></div>
          <div class="messages" id="sbMsgs">${state.sandbox.map((m) => m.alt ? `<div class="draft"><div class="draft-head">вариант · ${esc(m.note)}</div><div class="draft-text">${esc(m.text)}</div></div>` : `<div class="msg ${m.direction} ${m.direction === 'out' ? 'bot' : ''}">${esc(m.text)}${m.note ? `<div class="meta">${esc(m.note)}</div>` : ''}</div>`).join('') || '<div class="empty">Напишите сообщение от лица покупателя — агент ответит по текущим правилам. В Авито ничего не отправляется.</div>'}</div>
          <div class="composer" style="padding:12px 0 0;background:none;border:0">
            <textarea id="sbText" rows="1" placeholder="Сообщение покупателя…"></textarea>
            <button class="btn primary" id="sbSend">Отправить</button>
          </div>
        </div>
        <div class="card">
          <h3>Объявление для теста</h3>
          <div class="form">
            ${cars.length ? `<label>Автомобиль из базы знаний<select id="sbCar"><option value="">— ввести вручную —</option>${cars.map((c) => `<option value="${c.avito_id}" ${String(state.sandboxItem.id) === String(c.avito_id) ? 'selected' : ''}>${esc(c.title)}${c.price ? ' · ' + Number(c.price).toLocaleString('ru-RU') + ' ₽' : ''}</option>`).join('')}</select><span class="field-help">Агент увидит полную карточку: описание, комплектацию, VIN</span></label>` : ''}
            <label>Название<input type="text" id="sbTitle" value="${esc(state.sandboxItem.title)}" placeholder="Haval Jolion 1.5 AMT, 2026"></label>
            <label>Цена<input type="text" id="sbPrice" value="${esc(state.sandboxItem.price)}" placeholder="2 199 000 ₽"></label>
            <div class="field-help">Оставьте пустым, чтобы проверить личный чат без объявления.</div>
          </div>
          <label style="flex-direction:row;align-items:center;margin-top:16px"><input type="checkbox" id="sbCompare" ${state.sbCompare ? 'checked' : ''}> Сравнить модели</label>
          <input type="text" id="sbModels" value="${esc(state.sbModels || '')}" placeholder="gpt-4o-mini, gpt-4.1-mini, openrouter:…" style="margin-top:6px">
          <div class="field-help">Ответы всех моделей появятся рядом; диалог продолжается с первым.</div>
          <details style="margin-top:16px"><summary class="muted small" style="cursor:pointer">Показать промпт последнего ответа</summary><pre class="prompt" id="sbPrompt">${esc(state.sandboxPrompt || '—')}</pre></details>
        </div>
      </div>`;
    const msgs = $('#sbMsgs'); msgs.scrollTop = msgs.scrollHeight;
    $('#sbCompare').addEventListener('change', (e) => { state.sbCompare = e.target.checked; });
    $('#sbModels').addEventListener('input', (e) => { state.sbModels = e.target.value; });
    if (!state.sbModels) api('/api/runs?limit=1').then((d) => { if (!state.sbModels) { state.sbModels = (d.compareModels.length ? d.compareModels : [d.primaryModel]).join(', '); const el = $('#sbModels'); if (el) el.value = state.sbModels; } }).catch(() => {});
    $('#sbClear').addEventListener('click', () => { state.sandbox = []; render(); });
    ['sbTitle', 'sbPrice'].forEach((id) => $('#' + id).addEventListener('input', () => { state.sandboxItem = { ...state.sandboxItem, title: $('#sbTitle').value, price: $('#sbPrice').value }; }));
    $('#sbCar')?.addEventListener('change', (e) => {
      const car = cars.find((c) => String(c.avito_id) === e.target.value);
      state.sandboxItem = car ? { id: car.avito_id, title: car.title, price: car.price ? Number(car.price).toLocaleString('ru-RU') + ' ₽' : '' } : { id: '', title: '', price: '' };
      render();
    });
    const send = async () => {
      const text = $('#sbText').value.trim();
      if (!text) return;
      state.sandbox.push({ direction: 'in', text });
      render();
      $('#sbSend').disabled = true;
      try {
        const history = state.sandbox.filter((m) => !m.alt);
        const r = await api('/api/sandbox', { body: { history, item: state.sandboxItem, models: state.sbCompare ? state.sbModels : undefined } });
        const note = (x) => [x.model, x.phone && `телефон: ${x.phone}`, x.handoff && 'передать менеджеру', x.skip && 'агент решил промолчать', x.usage && `${x.usage.total_tokens} ток.`, x.ms && (x.ms / 1000).toFixed(1) + ' с'].filter(Boolean).join(' · ');
        state.sandboxPrompt = r.systemPrompt;
        const variants = r.variants || [r];
        variants.forEach((v, i) => state.sandbox.push({ direction: 'out', alt: i > 0 || Boolean(v.error), text: v.error ? '⚠ ' + v.error : v.reply || '(без ответа)', note: note(v) }));
      } catch (e) { toast(e.message, true); state.sandbox.pop(); }
      render();
      $('#sbText').focus();
    };
    $('#sbSend').addEventListener('click', send);
    $('#sbText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  };
  render();
}

async function settingsAvito(box, s) {
  const st = await loadStatus();
  box.innerHTML = `
    <div class="card"><h3>Подключение Авито</h3>
      <div class="stat-list" style="margin-bottom:16px">
        <div><span>Состояние</span><b>${st.avitoUserId ? '<span class="badge green">Подключён</span>' : '<span class="badge orange">Не подключён</span>'}</b></div>
        <div><span>Профиль</span><b>${esc(st.avitoProfile || '—')}</b></div>
        <div><span>ID продавца</span><b>${esc(st.avitoUserId || '—')}</b></div>
        <div><span>Токен</span><b>${st.token?.expiresAt ? 'действует до ' + fmtTime(st.token.expiresAt) : '—'}</b></div>
        <div><span>Последняя синхронизация</span><b>${st.lastPoll?.at ? fmtTime(st.lastPoll.at) + (st.lastPoll.ok ? ` · чатов ${st.lastPoll.chats}, новых сообщений ${st.lastPoll.fresh}` : ' · ошибка') : '—'}</b></div>
      </div>
      ${st.lastPoll?.error ? `<div class="notice" style="margin-bottom:16px">${esc(st.lastPoll.error)}</div>` : ''}
      <div class="form">
        <div class="grid c2">
          <label>Client ID<input type="text" name="avito_client_id" value="${esc(s.avito_client_id)}" autocomplete="off"></label>
          <label>Client Secret<input type="password" name="avito_client_secret" value="${esc(s.avito_client_secret)}" autocomplete="new-password"></label>
        </div>
        <div class="field-help">Ключи берутся в личном кабинете Авито → «Для профессионалов» → «API интеграции». Для чатов нужен тариф с доступом к Messenger API.</div>
        <div class="row"><button class="btn primary save">Сохранить</button><button class="btn" id="avTest">Проверить подключение</button><button class="btn" id="avSync">Синхронизировать чаты</button><button class="btn" id="avSyncFull">Загрузить до 500 чатов</button></div>
      </div>
    </div>

    <div class="card"><h3>Ключи ИИ</h3><div class="form">
      <label>API-ключ<input type="password" name="openai_api_key" value="${esc(s.openai_api_key)}" autocomplete="new-password" placeholder="sk-…"></label>
      <div class="field-help">Можно задать здесь или переменной окружения OPENAI_API_KEY на Railway.</div>
      <label>Ключ OpenRouter (необязательно)<input type="password" name="openrouter_api_key" value="${esc(s.openrouter_api_key)}" autocomplete="new-password" placeholder="sk-or-…"></label>
      <div class="field-help">Нужен, чтобы сравнивать модели других компаний: Claude, Gemini, DeepSeek, Llama. Один ключ на все, оплата по факту: openrouter.ai → Keys. В списке моделей пишется с приставкой, например <code>openrouter:anthropic/claude-sonnet-4.5</code>.</div>
      <div class="row"><button class="btn primary save2">Сохранить</button></div>
    </div></div>

    <div class="card"><h3>Получение сообщений</h3><div class="form">
      <label>Опрос Авито каждые, сек<input type="number" name="poll_interval_sec" value="${esc(s.poll_interval_sec)}" min="10" style="max-width:200px"></label>
      <div class="field-help">Опрос работает всегда. Вебхук ускоряет реакцию до пары секунд.</div>
      <div>Адрес вебхука: ${st.webhookUrl ? `<code>${esc(st.webhookUrl)}</code>` : '<span class="muted">появится после деплоя (нужен публичный адрес)</span>'}</div>
      <div class="row"><button class="btn primary save3">Сохранить</button><button class="btn" id="whOn" ${st.webhookUrl ? '' : 'disabled'}>Подключить вебхук</button><button class="btn" id="whOff" ${st.webhookUrl ? '' : 'disabled'}>Отключить вебхук</button></div>
    </div></div>`;
  bindSave(box, ['avito_client_id', 'avito_client_secret']);
  bindSave(box, ['openai_api_key', 'openrouter_api_key'], '.save2');
  bindSave(box, ['poll_interval_sec'], '.save3');
  const run = (sel, fn) => $(sel).addEventListener('click', async (e) => {
    const b = e.target; const txt = b.textContent; b.disabled = true; b.textContent = '…';
    try { await fn(); } catch (err) { toast(err.message, true); }
    b.disabled = false; b.textContent = txt;
  });
  run('#avTest', async () => { const r = await api('/api/avito/test', { body: {} }); toast(`Подключено: ${r.name || ''} (ID ${r.userId})`); settingsAvito(box, await api('/api/settings')); });
  run('#avSync', async () => { const r = await api('/api/sync', { body: { pages: 1 } }); toast(`Готово: чатов ${r.chats}, новых сообщений ${r.fresh}`); settingsAvito(box, await api('/api/settings')); });
  run('#avSyncFull', async () => { const r = await api('/api/sync', { body: { pages: 5 } }); toast(`Готово: чатов ${r.chats}, новых сообщений ${r.fresh}`); settingsAvito(box, await api('/api/settings')); });
  run('#whOn', async () => { await api('/api/webhook', { body: { enabled: true } }); toast('Вебхук подключён'); });
  run('#whOff', async () => { await api('/api/webhook', { body: { enabled: false } }); toast('Вебхук отключён'); });
}

function settingsNotify(box, s) {
  box.innerHTML = `
    <div class="card"><h3>Уведомления в Telegram</h3><div class="form">
      <div class="field-help">Придут, когда клиент оставил телефон или агент передал диалог менеджеру.</div>
      <div class="grid c2">
        <label>Токен бота<input type="password" name="tg_bot_token" value="${esc(s.tg_bot_token)}" placeholder="123456:ABC…" autocomplete="new-password"></label>
        <label>ID чата / группы<input type="text" name="tg_chat_id" value="${esc(s.tg_chat_id)}" placeholder="-1001234567890"></label>
      </div>
      <div class="row"><button class="btn primary save">Сохранить</button></div>
    </div></div>`;
  bindSave(box, ['tg_bot_token', 'tg_chat_id']);
}

async function settingsLog(box) {
  const d = await api('/api/events?limit=200');
  box.innerHTML = `<div class="card"><div class="row" style="margin-bottom:10px"><h3 style="margin:0">Журнал событий</h3><span class="spacer"></span><button class="btn sm" id="logRefresh">Обновить</button></div>
    ${d.events.map((e) => `<div class="log-item ${e.level}"><span class="muted">${fmtTime(e.ts)}</span><span><span class="badge">${esc(e.type)}</span></span><span>${esc(e.text)} ${e.chat_id ? `<a href="#/chats/${encodeURIComponent(e.chat_id)}">чат →</a>` : ''}</span></div>`).join('') || '<div class="muted">Пока пусто</div>'}</div>`;
  $('#logRefresh').addEventListener('click', () => settingsLog(box));
}


// ---------- черновики ИИ (оценка и исправление) ----------
const KIND_LABEL = { shadow: 'ответ на живое сообщение', replay: 'прогон по истории' };

function runBubble(r) {
  const cls = r.rating === 1 ? 'good' : r.rating === -1 ? 'bad' : '';
  const flags = [r.phone && `<span class="badge green">телефон ${esc(r.phone)}</span>`, r.handoff && '<span class="badge orange">передал бы менеджеру</span>', r.skip && '<span class="badge">промолчал бы</span>', r.comment && `<span class="badge">${esc(r.comment)}</span>`].filter(Boolean).join('');
  const err = r.comment?.startsWith('Ошибка');
  return `<div class="draft ${cls} ${err ? 'bad' : ''}" data-run="${r.id}">
    <div class="draft-head">🤖 <b>${esc(r.model || 'ИИ')}</b> · ${KIND_LABEL[r.kind] || r.kind} · ${fmtTime(r.created)}${r.ms ? ' · ' + (r.ms / 1000).toFixed(1) + ' с' : ''} ${flags}</div>
    <div class="draft-text">${esc(r.reply || '(без ответа)')}</div>
    ${r.correction ? `<div class="draft-fix">✍ Как надо: ${esc(r.correction)}</div>` : ''}
    <div class="draft-actions">
      <button class="btn sm ${r.rating === 1 ? 'on' : ''}" data-rate="1" title="Хороший ответ">👍</button>
      <button class="btn sm ${r.rating === -1 ? 'on' : ''}" data-rate="-1" title="Плохой ответ">👎</button>
      <button class="btn sm" data-fix>✍ Исправить</button>
    </div>
    <div class="fix-box hidden">
      <textarea rows="3">${esc(r.correction || r.reply || '')}</textarea>
      <input type="text" data-comment placeholder="Что не так (необязательно): выдумал цену, не попросил телефон…" value="${esc(r.kind === 'shadow' && r.comment?.startsWith('шаблон') ? '' : r.comment || '')}">
      <label class="small"><input type="checkbox" data-kb checked> Добавить в базу знаний как пример правильного ответа</label>
      <div class="row"><button class="btn sm primary" data-save>Сохранить</button><button class="btn sm" data-cancel>Отмена</button></div>
    </div>
  </div>`;
}

function bindRuns(root, reload) {
  $$('[data-run]', root).forEach((el) => {
    const id = el.dataset.run;
    $$('[data-rate]', el).forEach((b) => b.addEventListener('click', async () => {
      const cur = b.classList.contains('on');
      await api('/api/runs/' + id, { body: { rating: cur ? null : Number(b.dataset.rate) } });
      if (!cur && b.dataset.rate === '-1') { $('.fix-box', el).classList.remove('hidden'); $('textarea', el).focus(); return; }
      reload();
    }));
    $('[data-fix]', el).addEventListener('click', () => { $('.fix-box', el).classList.toggle('hidden'); $('textarea', el).focus(); });
    $('[data-cancel]', el).addEventListener('click', () => { $('.fix-box', el).classList.add('hidden'); reload(); });
    $('[data-save]', el).addEventListener('click', async () => {
      const correction = $('textarea', el).value.trim();
      const r = await api('/api/runs/' + id, { body: { correction, comment: $('[data-comment]', el).value.trim(), addToKb: $('[data-kb]', el).checked && Boolean(correction) } });
      toast(r.kbId ? 'Сохранено и добавлено в базу знаний' : 'Сохранено');
      $('.fix-box', el).classList.add('hidden');
      reload();
    });
  });
}

const OUTCOME = { phone: ['green', 'оставил телефон'], call: ['blue', 'договорились о звонке'], lost: ['orange', 'клиент ушёл'], no_answer: ['red', 'нет ответа продавца'], other: ['', 'другое'] };
const outcomeBadge = (o) => { const [c, t] = OUTCOME[o] || OUTCOME.other; return `<span class="badge ${c}">${t}</span>`; };
const list = (arr) => (arr && arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="muted">—</div>');

function reviewBox(rv) {
  const x = rv.result || {};
  return `<details class="review-box" open><summary><b>🔍 Разбор переписки</b> · оценка продавца ${esc(x.score ?? '?')}/10 · ${outcomeBadge(x.outcome)}</summary>
    <p>${esc(x.summary || '')}</p>
    <div class="grid c2"><div><b>Ошибки</b>${list(x.mistakes)}</div><div><b>Хорошо</b>${list(x.good)}</div></div>
    ${x.speed ? `<div><b>Скорость:</b> ${esc(x.speed)}</div>` : ''}
    ${x.better_reply?.reply ? `<div style="margin-top:8px"><b>Как надо было ответить</b> на «${esc(x.better_reply.client || '')}»:<div class="draft-fix">${esc(x.better_reply.reply)}</div>
      <button class="btn sm" style="margin-top:6px" onclick="addKb([{category:'example',title:${esc(JSON.stringify(x.better_reply.client || ''))},content:${esc(JSON.stringify(x.better_reply.reply))},source:'analysis'}], this)">+ В базу знаний как пример</button></div>` : ''}
  </details>`;
}

async function addKb(entries, btn) {
  try {
    await api('/api/kb', { body: { entries } });
    toast(entries.length > 1 ? `Добавлено в базу знаний: ${entries.length}` : 'Добавлено в базу знаний');
    if (btn) { btn.disabled = true; btn.textContent = '✓ В базе'; }
  } catch (e) { toast(e.message, true); }
}

// ---------- фоновые задачи ----------
function jobHtml(j, label) {
  if (!j) return '';
  const pct = j.total ? Math.round((j.done / j.total) * 100) : null;
  return `<div class="progress"><div style="width:${pct ?? (j.running ? 30 : 100)}%"></div></div>
    <div class="small muted">${j.running ? '⏳ ' + label : j.error ? '⚠ Ошибка: ' + esc(j.error) : '✓ Завершено'} · ${j.done}${j.total ? ' из ' + j.total : ''}
    ${j.messages !== undefined ? ` · новых сообщений ${j.messages}` : ''}${j.tokens ? ` · ${j.tokens} ток.` : ''}${j.errors ? ` · ошибок ${j.errors}` : ''} ${j.note ? '· ' + esc(j.note) : ''}
    ${j.running ? `<button class="link" data-stop="${j.type}">остановить</button>` : ''}</div>`;
}

/** Следить за задачей: обновлять прогресс, по завершении вызвать onDone. */
function watchJob(type, el, label, onDone) {
  let wasRunning = false;
  const tick = async () => {
    const jobs = await api('/api/jobs').catch(() => ({}));
    const j = jobs[type];
    if (!el.isConnected) return;
    el.innerHTML = jobHtml(j, label);
    $('[data-stop]', el)?.addEventListener('click', () => api(`/api/jobs/${type}/stop`, { body: {} }));
    if (j?.running) wasRunning = true;
    else if (wasRunning) { wasRunning = false; onDone && onDone(j); }
  };
  tick();
  state.timers.push(setInterval(tick, 1500));
}

const fmtDur = (sec) => {
  if (sec == null) return '—';
  if (sec < 60) return sec + ' с';
  if (sec < 3600) return Math.round(sec / 60) + ' мин';
  if (sec < 86400) return Math.round((sec / 3600) * 10) / 10 + ' ч';
  return Math.round((sec / 86400) * 10) / 10 + ' дн';
};

// ---------- архив и аналитика ----------
async function renderArchive() {
  const st = state.status || (await loadStatus());
  view().innerHTML = `
    <div class="notice info" style="margin-bottom:16px">Здесь загружается вся переписка кабинета, считается, как работали продавцы, и нейросеть разбирает диалоги: частые вопросы, ошибки, готовые ответы для базы знаний. В Авито ничего не отправляется и не отмечается прочитанным.</div>
    <div class="card"><h3>1. Загрузка всей истории из Авито</h3>
      <div class="muted small">Все чаты и все сообщения. Повторный запуск докачивает только изменившиеся чаты. Если Авито ограничит глубину списка, остальное доберётся по объявлениям — для этого сначала загрузите объявления в «Базе знаний».</div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="impStart" ${st.avitoConfigured ? '' : 'disabled'}>⬇ Загрузить всю историю</button>
        <a class="btn" id="expJsonl" href="/api/archive/export.jsonl">⬇ Выгрузка для анализа (JSONL)</a>
        <span class="muted small">JSONL: одна строка — один диалог. Подходит для ChatGPT/Claude и аналитики.</span></div>
      <div id="impJob"></div>
    </div>

    <div class="card"><div class="row"><h3 style="margin:0">2. Как работали продавцы</h3><span class="spacer"></span>
      <input type="date" id="stFrom" style="width:auto"> — <input type="date" id="stTo" style="width:auto" value="${dateInput(new Date())}"></div>
      <div id="stBox" style="margin-top:14px">Загрузка…</div></div>

    <div class="card"><h3>3. Разбор переписок нейросетью</h3>
      <div class="muted small">Нейросеть читает диалоги как руководитель отдела продаж: что спрашивали клиенты, где продавец ошибся, как надо было ответить. Потом собирает сводный отчёт с правилами и ответами для базы знаний. Примерно 1–3 тыс. токенов на чат.</div>
      <div class="row" style="margin-top:12px">
        <label style="flex-direction:row;align-items:center">Чатов <input type="number" id="rvCount" value="30" min="1" max="200" style="width:90px"></label>
        <select id="rvOrder" style="width:auto"><option value="recent">самые свежие</option><option value="random">случайные</option></select>
        <label style="flex-direction:row;align-items:center"><input type="checkbox" id="rvLeads"> только где оставили телефон</label>
        <button class="btn primary" id="rvStart">🔍 Разобрать</button><button class="btn" id="rvReport">Пересобрать отчёт</button></div>
      <div id="rvJob"></div>
      <div id="reportBox" class="report" style="margin-top:14px"></div>
    </div>`;
  const loadStats = async () => {
    const qs = `from=${$('#stFrom').value}&to=${$('#stTo').value}`;
    $('#expJsonl').href = '/api/archive/export.jsonl?' + ($('#stFrom').value ? qs : '');
    const d = await api('/api/archive/stats?' + ($('#stFrom').value ? qs : `to=${$('#stTo').value}`));
    $('#stBox').innerHTML = !d.chats ? `<div class="muted">Пока нет входящих чатов в базе (всего чатов: ${d.totalChats}). Загрузите историю.</div>` : `
      <div class="kpis">
        <div class="kpi"><span>Входящих чатов</span><b>${d.chats}</b></div>
        <div class="kpi"><span>Оставили телефон</span><b>${d.leads} · ${d.conversion}%</b></div>
        <div class="kpi"><span>Без ответа продавца</span><b style="color:${d.unanswered ? 'var(--red)' : 'inherit'}">${d.unanswered}</b></div>
        <div class="kpi"><span>Продавец просил телефон</span><b>${d.askedPhonePct}%</b></div>
        <div class="kpi"><span>Первый ответ (медиана)</span><b>${fmtDur(d.medianFirstResponse)}</b></div>
        <div class="kpi"><span>днём 9–21 / ночью</span><b>${fmtDur(d.medianFirstResponseDay)} / ${fmtDur(d.medianFirstResponseNight)}</b></div>
        <div class="kpi"><span>Ответ за 5 мин / за час</span><b>${d.within5Pct}% / ${d.within60Pct}%</b></div>
        <div class="kpi"><span>Ушли после ответа без телефона</span><b>${d.lostAfterReply}</b></div>
      </div>
      <div class="muted small" style="margin:10px 0">Загружено полностью: ${d.loadedChats} из ${d.totalChats} чатов, сообщений ${d.totalMessages}. В среднем на чат: клиент ${d.avgClientMsgs}, продавец ${d.avgSellerMsgs} сообщ.
        ${d.authors.length > 1 ? '<br>Сообщения продавца по авторам (ID сотрудника): ' + d.authors.map((a) => `${esc(a.id)} — ${a.messages}`).join(', ') : ''}
        <br>Ответы прежнего бота («ИИ Диалоги») Авито не отличает от ответов продавцов — они тоже считаются здесь.</div>
      <div class="table-wrap" style="box-shadow:none"><table class="table"><thead><tr><th>Месяц</th><th>Чатов</th><th>С ответом</th><th>Телефон</th><th>Конверсия</th><th>Первый ответ</th></tr></thead><tbody>
        ${d.months.map((m) => `<tr><td>${m.month}</td><td>${m.chats}</td><td>${m.answered}</td><td>${m.leads}</td><td>${m.conversion}%</td><td>${fmtDur(m.medianFirstResponse)}</td></tr>`).join('')}
      </tbody></table></div>`;
  };
  const loadReport = async () => {
    const d = await api('/api/archive/reports');
    const r = d.report?.result;
    const box = $('#reportBox');
    if (!box) return;
    box.innerHTML = (r ? `
      <div class="row"><h3 style="margin:0">Сводный отчёт</h3><span class="muted small">${fmtTime(d.report.created)} · чатов ${d.report.n_chats} · средняя оценка продавцов ${r.stats?.avgScore ?? '—'}/10</span></div>
      <p>${esc(r.overview || '')}</p>
      <div class="row">${Object.entries(r.stats?.outcomes || {}).map(([k, v]) => outcomeBadge(k).replace('</span>', `: ${v}</span>`)).join('')}</div>
      <div class="grid c2">
        <div><h4>Частые вопросы клиентов</h4>${list((r.top_questions || []).map((x) => `${x.question} — ${x.count}`))}</div>
        <div><h4>Типичные ошибки → как должен действовать ИИ</h4>${list((r.mistakes || []).map((x) => `${x.mistake} (${x.count}) → ${x.fix}`))}</div>
      </div>
      <h4>Удачные приёмы</h4>${list(r.good_practices)}
      ${r.rules ? `<h4>Предлагаемые правила для агента</h4><pre class="prompt">${esc(r.rules)}</pre>
        <div class="row" style="margin-top:8px"><button class="btn sm" id="addRules">+ Добавить в правила ответа</button><button class="btn sm" id="addRulesKb">+ В базу знаний как правила</button></div>` : ''}
      ${(r.faq || []).length ? `<h4>Ответы для базы знаний (из переписок)</h4>
        <div class="muted small">Проверьте факты перед добавлением: нейросеть взяла их из ответов продавцов.</div>
        ${r.faq.map((f, i) => `<div class="kb-item"><div><div class="kb-title">${esc(f.q)}</div><div class="kb-content">${esc(f.a)}</div></div><button class="btn sm" data-faq="${i}">+ В базу</button></div>`).join('')}
        <button class="btn sm" id="addAllFaq">+ Добавить все</button>` : ''}` : '<div class="muted">Отчёта пока нет.</div>') +
      (d.reviews.length ? `<h4 style="margin-top:18px">Разобранные чаты (${d.reviews.length})</h4>
      <div class="table-wrap" style="box-shadow:none"><table class="table"><thead><tr><th>Клиент</th><th>Оценка</th><th>Итог</th><th>Суть</th><th>Ошибки</th><th></th></tr></thead><tbody>
      ${d.reviews.map((x) => `<tr><td><b>${esc(x.client_name || 'Покупатель')}</b><div class="small muted">${esc(x.item_title || '')}</div></td><td>${x.score ?? '—'}</td><td>${outcomeBadge(x.outcome)}</td>
        <td class="small">${esc(x.summary || '')}</td><td class="small">${esc(x.mistakes.slice(0, 2).join('; '))}</td><td><a href="#/chats/${encodeURIComponent(x.chat_id)}">чат →</a></td></tr>`).join('')}
      </tbody></table></div>` : '');
    $('#addRules')?.addEventListener('click', async (e) => { await api('/api/rules/append', { body: { text: r.rules } }); toast('Добавлено в Настройки → Агент → Правила'); e.target.disabled = true; });
    $('#addRulesKb')?.addEventListener('click', (e) => addKb([{ category: 'rules', title: 'Правила по разбору переписок', content: r.rules, source: 'analysis' }], e.target));
    $$('[data-faq]', box).forEach((b) => b.addEventListener('click', () => { const f = r.faq[Number(b.dataset.faq)]; addKb([{ category: 'faq', title: f.q, content: f.a, source: 'analysis' }], b); }));
    $('#addAllFaq')?.addEventListener('click', (e) => addKb(r.faq.map((f) => ({ category: 'faq', title: f.q, content: f.a, source: 'analysis' })), e.target));
  };
  $('#stFrom').addEventListener('change', loadStats);
  $('#stTo').addEventListener('change', loadStats);
  $('#impStart').addEventListener('click', async () => {
    try { await api('/api/archive/import', { body: {} }); toast('Загрузка истории запущена'); } catch (e) { toast(e.message, true); }
  });
  $('#rvStart').addEventListener('click', async () => {
    try { await api('/api/archive/review', { body: { count: Number($('#rvCount').value), order: $('#rvOrder').value, onlyLeads: $('#rvLeads').checked } }); toast('Разбор запущен'); } catch (e) { toast(e.message, true); }
  });
  $('#rvReport').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api('/api/archive/report', { body: {} }); await loadReport(); toast('Отчёт пересобран'); } catch (err) { toast(err.message, true); }
    e.target.disabled = false;
  });
  watchJob('import', $('#impJob'), 'Загружаю историю…', () => { loadStats(); loadStatus(); });
  watchJob('review', $('#rvJob'), 'Разбираю переписки…', loadReport);
  await Promise.all([loadStats(), loadReport()]);
}

// ---------- база знаний ----------
const KB_HELP = {
  faq: ['Вопрос клиента', 'Ответ', 'Частые вопросы: кредит, трейд-ин, тест-драйв, комплектации, сроки.'],
  company: ['Тема', 'Факты', 'Адрес, часы работы, условия кредита и трейд-ина, акции, гарантия — то, что агент может говорить уверенно.'],
  objections: ['Что говорит клиент', 'Как отвечать', '«Дорого», «Подумаю», «Не хочу давать телефон», «У конкурентов дешевле».'],
  rules: ['Название', 'Правило', 'Что можно и нельзя: не называть ставку кредита, не обещать скидку без менеджера…'],
  example: ['Сообщение клиента', 'Правильный ответ', 'Образцы ответов. Сюда же попадают ваши исправления черновиков ИИ.'],
};

async function renderKb(parts) {
  const sub = parts[0] === 'cars' ? 'cars' : 'entries';
  view().innerHTML = `<div class="subtabs"><a href="#/kb" class="${sub === 'entries' ? 'active' : ''}">Знания</a><a href="#/kb/cars" class="${sub === 'cars' ? 'active' : ''}">Автомобили</a></div><div id="sub"></div>`;
  return sub === 'cars' ? kbCars($('#sub')) : kbEntries($('#sub'));
}

async function kbEntries(box) {
  const d = await api('/api/kb');
  const cats = d.categories;
  const counts = {};
  for (const e of d.entries) counts[e.category] = (counts[e.category] || 0) + 1;
  const shown = d.entries.filter((e) => !state.kbCat || e.category === state.kbCat);
  box.innerHTML = `
    <div class="notice info" style="margin-bottom:16px">Всё, что здесь включено, агент получает вместе с правилами ответа и карточкой автомобиля. Если база станет большой, в промпт попадут записи, ближе всего подходящие к вопросу клиента. Проверяйте результат в «Тест агента» или прогоном по реальным чатам.</div>
    <div class="card"><h3 id="kbFormTitle">Новая запись</h3><div class="form">
      <input type="hidden" id="kbId">
      <div class="grid c2">
        <label>Тип<select id="kbCat">${Object.entries(cats).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label><span id="kbTitleLbl">Вопрос клиента</span><input type="text" id="kbTitle"></label>
      </div>
      <label><span id="kbContentLbl">Ответ</span><textarea id="kbContent" rows="4"></textarea><span class="field-help" id="kbHelp"></span></label>
      <div class="row"><button class="btn primary" id="kbSave">Сохранить</button><button class="btn" id="kbReset">Очистить</button></div>
    </div></div>
    <div class="card"><div class="row" style="margin-bottom:8px"><h3 style="margin:0">Записи</h3><span class="spacer"></span>
      <div class="chips"><button class="chip ${!state.kbCat ? 'active' : ''}" data-cat="">Все ${d.entries.length}</button>${Object.entries(cats).map(([k, v]) => `<button class="chip ${state.kbCat === k ? 'active' : ''}" data-cat="${k}">${v} ${counts[k] || 0}</button>`).join('')}</div></div>
      ${shown.map((e) => `<div class="kb-item ${e.enabled ? '' : 'off'}">
        <div><span class="badge">${esc(cats[e.category] || e.category)}</span> ${e.source && e.source !== 'manual' ? `<span class="badge blue">${e.source === 'correction' ? 'из исправлений' : 'из разбора'}</span>` : ''}
          ${e.title ? `<div class="kb-title" style="margin-top:6px">${esc(e.title)}</div>` : ''}<div class="kb-content">${esc(e.content)}</div></div>
        <div class="row" style="align-items:flex-start;flex-wrap:nowrap">
          <label class="switch" title="Включена"><input type="checkbox" data-on="${e.id}" ${e.enabled ? 'checked' : ''}><span></span></label>
          <button class="btn sm" data-edit="${e.id}">Изменить</button><button class="btn sm danger" data-del="${e.id}">✕</button></div>
      </div>`).join('') || '<div class="muted">Пока пусто. Добавьте факты вручную или возьмите их из отчёта в «Архиве».</div>'}
    </div>`;
  const setHelp = () => { const h = KB_HELP[$('#kbCat').value]; $('#kbTitleLbl').textContent = h[0]; $('#kbContentLbl').textContent = h[1]; $('#kbHelp').textContent = h[2]; };
  $('#kbCat').addEventListener('change', setHelp);
  if (state.kbCat) $('#kbCat').value = state.kbCat;
  setHelp();
  const reset = () => { $('#kbId').value = ''; $('#kbTitle').value = ''; $('#kbContent').value = ''; $('#kbFormTitle').textContent = 'Новая запись'; };
  $('#kbReset').addEventListener('click', reset);
  $('#kbSave').addEventListener('click', async () => {
    try {
      await api('/api/kb', { body: { id: Number($('#kbId').value) || undefined, category: $('#kbCat').value, title: $('#kbTitle').value, content: $('#kbContent').value } });
      toast('Сохранено'); kbEntries(box);
    } catch (e) { toast(e.message, true); }
  });
  $$('[data-cat]', box).forEach((b) => b.addEventListener('click', () => { state.kbCat = b.dataset.cat; kbEntries(box); }));
  $$('[data-edit]', box).forEach((b) => b.addEventListener('click', () => {
    const e = d.entries.find((x) => x.id === Number(b.dataset.edit));
    $('#kbId').value = e.id; $('#kbCat').value = e.category; $('#kbTitle').value = e.title || ''; $('#kbContent').value = e.content;
    $('#kbFormTitle').textContent = 'Запись #' + e.id; setHelp(); view().scrollTo({ top: 0, behavior: 'smooth' });
  }));
  $$('[data-on]', box).forEach((b) => b.addEventListener('change', async () => {
    const e = d.entries.find((x) => x.id === Number(b.dataset.on));
    await api('/api/kb', { body: { ...e, enabled: b.checked } }); kbEntries(box);
  }));
  $$('[data-del]', box).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Удалить запись?')) return;
    await api('/api/kb/' + b.dataset.del, { method: 'DELETE' }); kbEntries(box);
  }));
}

const ITEM_STATUS = { active: 'в продаже', old: 'снято', removed: 'удалено', blocked: 'заблокировано', rejected: 'отклонено' };

async function kbCars(box, query = '') {
  const d = await api('/api/items?q=' + encodeURIComponent(query));
  const st = d.stats || {};
  box.innerHTML = `
    <div class="card"><h3>Откуда берутся автомобили</h3>
      <div class="muted small">Из Авито API приходят название, цена, статус и ссылка. Полное описание, комплектация, VIN и пробег есть только в XML-фиде автозагрузки — его адрес можно взять из профиля автозагрузки Авито автоматически. Агент видит карточку машины, по которой пишет клиент, и короткий список остальных машин в продаже.</div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="itApi">⬇ Объявления из Авито</button></div>
      <div class="row" style="margin-top:12px"><input type="text" id="feedUrl" value="${esc(d.feedUrl || '')}" placeholder="URL XML-фида (пусто — взять из профиля автозагрузки Авито)" style="flex:1;min-width:260px"><button class="btn" id="itFeed">⬇ Загрузить фид</button></div>
      <div class="muted small" style="margin-top:10px">В базе: ${st.total || 0} · в продаже ${st.active || 0} · с описанием ${st.with_desc || 0} · из фида ${st.from_feed || 0}</div>
    </div>
    <div class="card"><div class="row" style="margin-bottom:10px"><h3 style="margin:0">Автомобили</h3><span class="spacer"></span><input type="search" id="itQ" placeholder="Название, VIN, ID" value="${esc(query)}" style="max-width:260px"></div>
      <div class="table-wrap" style="box-shadow:none"><table class="table"><thead><tr><th>Автомобиль</th><th>Цена</th><th>Статус</th><th>VIN / пробег</th><th>Описание</th><th>Чатов</th><th></th></tr></thead><tbody>
      ${d.items.map((it) => `<tr data-key="${esc(it.key)}"><td><b>${esc(it.title)}</b><div class="small muted">${it.avito_id ? 'ID ' + it.avito_id : 'только в фиде'}${it.ad_id ? ' · фид ' + esc(it.ad_id) : ''}</div></td>
        <td>${it.price ? Number(it.price).toLocaleString('ru-RU') + ' ₽' : '—'}</td>
        <td><span class="badge ${it.status === 'active' ? 'green' : ''}">${esc(ITEM_STATUS[it.status] || it.status || 'из фида')}</span></td>
        <td class="small">${esc(it.vin || '—')}${it.mileage ? '<br>' + esc(it.mileage) + ' км' : ''}</td>
        <td>${it.desc_len ? `<span class="badge green">есть</span>` : '<span class="badge">нет</span>'}</td>
        <td>${it.chats || 0}</td>
        <td style="white-space:nowrap"><button class="btn sm" data-card="${esc(it.key)}">Как видит агент</button> ${it.url ? `<a class="btn sm" target="_blank" rel="noopener" href="${esc(it.url)}">↗</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Автомобилей пока нет — загрузите объявления или фид.</td></tr>'}
      </tbody></table></div></div>`;
  const run = (sel, fn) => $(sel).addEventListener('click', async (e) => {
    const b = e.target; const t = b.textContent; b.disabled = true; b.textContent = '…';
    try { await fn(); } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = t; }
  });
  run('#itApi', async () => { const r = await api('/api/items/import-api', { body: {} }); toast(`Загружено объявлений: ${r.count}`); kbCars(box); });
  run('#itFeed', async () => { const r = await api('/api/items/import-feed', { body: { url: $('#feedUrl').value.trim() } }); toast(`Фид: ${r.count} объявлений, сопоставлено с Авито ${r.mapped}`); kbCars(box); });
  let t;
  $('#itQ').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => kbCars(box, e.target.value).then(() => { const q = $('#itQ'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }), 350); });
  $$('[data-card]', box).forEach((b) => b.addEventListener('click', async () => {
    const tr = b.closest('tr');
    if (tr.nextElementSibling?.classList.contains('expand')) return tr.nextElementSibling.remove();
    const r = await api('/api/items/' + encodeURIComponent(b.dataset.card));
    tr.insertAdjacentHTML('afterend', `<tr class="expand"><td colspan="7"><pre class="prompt">${esc(r.card)}</pre></td></tr>`);
  }));
}

// ---------- проверка ответов ----------
const RUN_FILTERS = [['unrated', 'Не оценены'], ['', 'Все'], ['bad', '👎 Плохие'], ['good', '👍 Хорошие'], ['replay', 'Прогон по истории'], ['shadow', 'На живые сообщения']];

async function renderReview() {
  view().innerHTML = `
    <div class="notice info" style="margin-bottom:16px">Агент отвечает на реальные сообщения клиентов из истории — так же, как ответил бы сейчас, с текущими правилами и базой знаний. Рядом ответ продавца. Ставьте 👍/👎 и исправляйте: исправления становятся примерами в базе знаний. После правок прогоните снова и сравните.</div>
    <div class="card"><h3>Прогнать агента по реальным чатам</h3>
      <div class="row">
        <label style="flex-direction:row;align-items:center">Чатов <input type="number" id="rbCount" value="10" min="1" max="100" style="width:80px"></label>
        <label style="flex-direction:row;align-items:center">Ответов на чат <input type="number" id="rbTurns" value="3" min="1" max="10" style="width:70px"></label>
        <select id="rbOrder" style="width:auto"><option value="recent">самые свежие</option><option value="random">случайные</option></select>
        <label style="flex-direction:row;align-items:center"><input type="checkbox" id="rbLeads"> только где оставили телефон</label>
        <label style="flex-direction:row;align-items:center"><input type="checkbox" id="rbSkip" checked> пропускать уже прогнанные</label>
        <button class="btn primary" id="rbStart">🧪 Прогнать</button>
      </div>
      <label style="margin-top:12px">Модели — отвечают параллельно на каждое сообщение
        <input type="text" id="rbModels" placeholder="gpt-4o-mini, gpt-4.1-mini, openrouter:anthropic/claude-sonnet-4.5">
        <span class="field-help">Через запятую. Модели OpenAI — как есть (gpt-4o-mini, gpt-4.1, gpt-5-mini…); другие компании — через OpenRouter с приставкой <code>openrouter:</code>, ключ в Настройки → Авито. Пусто — только основная модель агента. Каждая модель тратит свои токены.</span></label>
      <div id="rbJob"></div>
    </div>
    <div class="card" id="modelCard"></div>
    <div class="card"><div class="row" style="margin-bottom:10px"><h3 style="margin:0">Ответы агента</h3><span class="spacer"></span><span class="small muted" id="runStats"></span></div>
      <div class="chips" style="margin-bottom:12px">${RUN_FILTERS.map(([k, l]) => `<button class="chip ${state.runFilter === k ? 'active' : ''}" data-rf="${k}">${l}</button>`).join('')}</div>
      <div id="runList">Загрузка…</div></div>`;
  const load = async () => {
    const d = await api('/api/runs?limit=80&filter=' + state.runFilter);
    const s = d.stats;
    if ($('#rbModels') && !$('#rbModels').dataset.init) { $('#rbModels').value = (d.compareModels.length ? d.compareModels : [d.primaryModel]).join(', '); $('#rbModels').dataset.init = '1'; }
    $('#modelCard').innerHTML = d.models.length ? `<h3>Сравнение моделей</h3>
      <div class="table-wrap" style="box-shadow:none"><table class="table"><thead><tr><th>Модель</th><th>Ответов</th><th>👍</th><th>👎</th><th>Доля хороших</th><th>Ошибок</th><th>Токенов на ответ</th><th>Время ответа</th><th>Передал менеджеру</th></tr></thead><tbody>
      ${d.models.map((m) => { const rated = (m.good || 0) + (m.bad || 0); return `<tr><td><b>${esc(m.model || '—')}</b></td><td>${m.total}</td><td>${m.good || 0}</td><td>${m.bad || 0}</td>
        <td>${rated ? `<b>${Math.round(((m.good || 0) / rated) * 100)}%</b>` : '—'}</td><td>${m.errors || 0}</td><td>${m.avg_tokens ?? '—'}</td><td>${m.avg_ms ? (m.avg_ms / 1000).toFixed(1) + ' с' : '—'}</td><td>${m.handoffs || 0}</td></tr>`; }).join('')}
      </tbody></table></div><div class="muted small" style="margin-top:8px">Оценивайте ответы 👍/👎 — таблица покажет, какая модель лучше. Время и токены помогают сравнить скорость и цену.</div>` : '';
    const rated = (s.good || 0) + (s.bad || 0);
    $('#runStats').textContent = `всего ${s.total || 0} · 👍 ${s.good || 0} · 👎 ${s.bad || 0} · не оценено ${s.unrated || 0}${rated ? ` · доля хороших ${Math.round(((s.good || 0) / rated) * 100)}%` : ''}${s.tokens ? ` · ${s.tokens} ток.` : ''}`;
    const box = $('#runList');
    // одно сообщение клиента — ответы всех моделей рядом и ответ продавца
    const groups = [];
    const byKey = {};
    for (const r of d.runs) {
      const k = r.chat_id + '|' + r.at_message_id;
      if (!byKey[k]) groups.push((byKey[k] = { first: r, runs: [] }));
      byKey[k].runs.push(r);
    }
    box.innerHTML = groups.map(({ first: r, runs }) => `
      <div style="border-top:1px solid var(--border);padding:14px 0">
        <div class="row small"><b>${esc(r.client_name || 'Покупатель')}</b><span class="muted">${esc(r.item_title || 'личный чат')}${r.item_price ? ' · ' + esc(r.item_price) : ''}</span><span class="spacer"></span><a href="#/chats/${encodeURIComponent(r.chat_id)}">весь чат →</a></div>
        <div class="client-says" style="margin-top:8px"><span class="small muted">Клиент · ${fmtTime(r.at_created)}</span><br>${esc(r.client_text)}</div>
        <div class="compare" style="grid-template-columns:repeat(${Math.min(runs.length + 1, 4)}, minmax(0, 1fr))">${runs.map(runBubble).join('')}<div class="actual"><div class="draft-head">👤 Продавец ответил</div>${r.actual ? esc(r.actual) : '<span class="muted">не ответил</span>'}</div></div>
      </div>`).join('') || '<div class="muted">Пока пусто. Загрузите историю в «Архиве» и запустите прогон.</div>';
    bindRuns(box, load);
  };
  $$('[data-rf]').forEach((b) => b.addEventListener('click', () => { state.runFilter = b.dataset.rf; $$('[data-rf]').forEach((x) => x.classList.toggle('active', x === b)); load(); }));
  $('#rbStart').addEventListener('click', async () => {
    try {
      const models = $('#rbModels').value.trim();
      await api('/api/settings', { body: { compare_models: models } }); // запоминаем выбор: им же пользуется кнопка «Прогнать ИИ» в чате
      await api('/api/replay-batch', { body: { count: Number($('#rbCount').value), maxTurns: Number($('#rbTurns').value), order: $('#rbOrder').value, onlyLeads: $('#rbLeads').checked, skipDone: $('#rbSkip').checked, models } });
      toast('Прогон запущен');
    } catch (e) { toast(e.message, true); }
  });
  watchJob('replay', $('#rbJob'), 'Агент отвечает на сообщения клиентов…', load);
  await load();
}

// ---------- boot ----------
async function boot() {
  const me = await api('/api/me');
  if (me.authRequired && !me.loggedIn) return showLogin();
  $('#app').classList.remove('hidden');
  await loadStatus().catch(() => {});
  setInterval(() => loadStatus().catch(() => {}), 30000);
  route();
}
boot();
