/* Авито Ассистент — интерфейс (без сборки) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = () => $('#view');

const state = { status: null, chatFilter: '', chatQuery: '', chatId: null, chatTimer: null, sandbox: [], sandboxItem: { title: '', price: '' } };

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
  toast(on ? 'ИИ включён — бот отвечает на новые сообщения' : 'ИИ выключен');
  loadStatus();
});

// ---------- router ----------
const routes = { dashboard: renderDashboard, chats: renderChats, leads: renderLeads, settings: renderSettings };
function route() {
  clearInterval(state.chatTimer);
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
      <button class="btn sm" id="replyNow" title="Сгенерировать и отправить ответ ИИ прямо сейчас">🤖 Ответить ИИ</button>
      <button class="btn sm" id="syncChat" title="Обновить из Авито">⟳</button>
      <a class="btn sm" target="_blank" rel="noopener" href="https://www.avito.ru/profile/messenger/channel/${encodeURIComponent(c.id)}" title="Открыть на Авито">↗</a>
      ${c.item_url ? `<a class="btn sm" target="_blank" rel="noopener" href="${esc(c.item_url)}" title="Объявление">📄</a>` : ''}
      <span class="small muted">AI</span><label class="switch"><input type="checkbox" id="chatAi" ${c.ai_enabled ? 'checked' : ''}><span></span></label>
    </div>
    <div class="messages">${d.messages.map((m) => {
      if (m.source === 'system') return `<div class="msg system">${esc(m.text)}<div class="meta">Авито · ${fmtTime(m.created)}</div></div>`;
      return `<div class="msg ${m.direction} ${m.source}">${esc(m.text)}<div class="meta">${SOURCE_LABEL[m.source] || ''} ${fmtTime(m.created)}</div></div>`;
    }).join('') || '<div class="empty">Сообщений нет</div>'}</div>
    <div class="composer">
      <textarea id="composerText" rows="1" placeholder="Написать сообщение от менеджера (бот в этом чате встанет на паузу)…">${esc(draft)}</textarea>
      <button class="btn primary" id="sendBtn">Отправить</button>
    </div>`;
  const msgs = $('.messages', pane);
  if (!silent || atBottom) msgs.scrollTop = msgs.scrollHeight;

  $('#chatAi').addEventListener('change', async (e) => { await api(`/api/chats/${encodeURIComponent(id)}/ai`, { body: { enabled: e.target.checked } }); toast(e.target.checked ? 'AI в чате включён' : 'AI в чате выключен'); loadChatList(true); });
  $('#syncChat').addEventListener('click', async () => { try { await api(`/api/chats/${encodeURIComponent(id)}/sync`, { body: {} }); loadChat(id); } catch (e) { toast(e.message, true); } });
  $('#resumeBot')?.addEventListener('click', async () => { await api(`/api/chats/${encodeURIComponent(id)}/status`, { body: { status: 'active' } }); toast('Чат возвращён боту'); loadChat(id); });
  $('#replyNow').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = '…думает';
    try {
      const r = await api(`/api/chats/${encodeURIComponent(id)}/reply-now`, { body: {} });
      toast(r.sent ? 'Ответ отправлен' : 'Не отправлено: ' + (r.skipped || ''), !r.sent);
      loadChat(id);
    } catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = '🤖 Ответить ИИ'; }
  });
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
    <div class="card"><h3>Основное</h3><div class="form">
      <div class="grid c2">
        <label>Имя AI-консультанта<input type="text" name="assistant_name" value="${esc(s.assistant_name)}"></label>
        <label>Модель OpenAI<input type="text" name="openai_model" value="${esc(s.openai_model)}" placeholder="gpt-4o-mini"></label>
        <label>Задержка перед ответом, сек<input type="number" name="reply_delay_sec" value="${esc(s.reply_delay_sec)}" min="0"><span class="field-help">Ждём, пока клиент допишет несколько сообщений подряд</span></label>
        <label>Лимит ответов бота в одном чате<input type="number" name="max_bot_replies" value="${esc(s.max_bot_replies)}" min="1"></label>
        <label>Креативность (temperature)<input type="number" step="0.1" min="0" max="1.5" name="temperature" value="${esc(s.temperature)}"></label>
        <label>Отвечать на сообщения не старше, мин<input type="number" name="only_new_messages_min" value="${esc(s.only_new_messages_min)}" min="1"></label>
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
  bindSave(box, ['assistant_name', 'openai_model', 'reply_delay_sec', 'max_bot_replies', 'temperature', 'only_new_messages_min', 'rules', 'company_info', 'answer_personal', 'pause_on_manager', 'quick_reply_enabled', 'quick_reply_text']);
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

function settingsSandbox(box) {
  const render = () => {
    box.innerHTML = `
      <div class="sandbox">
        <div class="card">
          <div class="row" style="margin-bottom:12px"><h3 style="margin:0">Диалог с агентом</h3><span class="spacer"></span><button class="btn sm" id="sbClear">Начать заново</button></div>
          <div class="messages" id="sbMsgs">${state.sandbox.map((m) => `<div class="msg ${m.direction} ${m.direction === 'out' ? 'bot' : ''}">${esc(m.text)}${m.note ? `<div class="meta">${esc(m.note)}</div>` : ''}</div>`).join('') || '<div class="empty">Напишите сообщение от лица покупателя — агент ответит по текущим правилам. В Авито ничего не отправляется.</div>'}</div>
          <div class="composer" style="padding:12px 0 0;background:none;border:0">
            <textarea id="sbText" rows="1" placeholder="Сообщение покупателя…"></textarea>
            <button class="btn primary" id="sbSend">Отправить</button>
          </div>
        </div>
        <div class="card">
          <h3>Объявление для теста</h3>
          <div class="form">
            <label>Название<input type="text" id="sbTitle" value="${esc(state.sandboxItem.title)}" placeholder="Haval Jolion 1.5 AMT, 2026"></label>
            <label>Цена<input type="text" id="sbPrice" value="${esc(state.sandboxItem.price)}" placeholder="2 199 000 ₽"></label>
            <div class="field-help">Оставьте пустым, чтобы проверить личный чат без объявления.</div>
          </div>
          <details style="margin-top:16px"><summary class="muted small" style="cursor:pointer">Показать промпт последнего ответа</summary><pre class="prompt" id="sbPrompt">${esc(state.sandboxPrompt || '—')}</pre></details>
        </div>
      </div>`;
    const msgs = $('#sbMsgs'); msgs.scrollTop = msgs.scrollHeight;
    $('#sbClear').addEventListener('click', () => { state.sandbox = []; render(); });
    ['sbTitle', 'sbPrice'].forEach((id) => $('#' + id).addEventListener('input', () => { state.sandboxItem = { title: $('#sbTitle').value, price: $('#sbPrice').value }; }));
    const send = async () => {
      const text = $('#sbText').value.trim();
      if (!text) return;
      state.sandbox.push({ direction: 'in', text });
      render();
      $('#sbSend').disabled = true;
      try {
        const r = await api('/api/sandbox', { body: { history: state.sandbox, item: state.sandboxItem } });
        const notes = [r.phone && `телефон: ${r.phone}`, r.handoff && 'передать менеджеру', r.skip && 'агент решил промолчать', r.usage && `${r.usage.total_tokens} ток.`].filter(Boolean).join(' · ');
        state.sandboxPrompt = r.systemPrompt;
        state.sandbox.push({ direction: 'out', text: r.reply || '(без ответа)', note: notes });
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

    <div class="card"><h3>Ключ OpenAI</h3><div class="form">
      <label>API-ключ<input type="password" name="openai_api_key" value="${esc(s.openai_api_key)}" autocomplete="new-password" placeholder="sk-…"></label>
      <div class="field-help">Можно задать здесь или переменной окружения OPENAI_API_KEY на Railway.</div>
      <div class="row"><button class="btn primary save2">Сохранить</button></div>
    </div></div>

    <div class="card"><h3>Получение сообщений</h3><div class="form">
      <label>Опрос Авито каждые, сек<input type="number" name="poll_interval_sec" value="${esc(s.poll_interval_sec)}" min="10" style="max-width:200px"></label>
      <div class="field-help">Опрос работает всегда. Вебхук ускоряет реакцию до пары секунд.</div>
      <div>Адрес вебхука: ${st.webhookUrl ? `<code>${esc(st.webhookUrl)}</code>` : '<span class="muted">появится после деплоя (нужен публичный адрес)</span>'}</div>
      <div class="row"><button class="btn primary save3">Сохранить</button><button class="btn" id="whOn" ${st.webhookUrl ? '' : 'disabled'}>Подключить вебхук</button><button class="btn" id="whOff" ${st.webhookUrl ? '' : 'disabled'}>Отключить вебхук</button></div>
    </div></div>`;
  bindSave(box, ['avito_client_id', 'avito_client_secret']);
  bindSave(box, ['openai_api_key'], '.save2');
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
