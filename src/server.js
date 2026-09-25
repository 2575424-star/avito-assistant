const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { db, getSetting, setSetting, allSettings, logEvent } = require('./db');
const avito = require('./avito');
const agent = require('./agent');
const engine = require('./engine');
const knowledge = require('./knowledge');
const history = require('./history');
const billing = require('./billing');
const lab = require('./lab');
const llm = require('./llm');
const gptLab = require('./gpt-lab');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION = ADMIN_PASSWORD ? crypto.createHmac('sha256', ADMIN_PASSWORD).update('avito-assistant-session').digest('hex') : null;
const SECRET_KEYS = ['avito_client_secret', 'openai_api_key', 'openrouter_api_key', 'tg_bot_token'];

/** Список моделей из запроса: массив или строка через запятую; пусто — null (берётся из настроек). */
/** Конфигурации прогона из запроса: [{versionId, model}]. */
function configList(v) {
  if (!Array.isArray(v) || !v.length) return null;
  return v.slice(0, 8).map((c) => ({ versionId: Number(c.versionId) || null, model: String(c.model || '').trim() || null }));
}

const RUN_SELECT = `SELECT r.*, c.client_name, c.item_title, c.item_price, v.key AS v_key, v.version AS v_version
  FROM agent_runs r LEFT JOIN chats c ON c.id = r.chat_id LEFT JOIN agent_versions v ON v.id = r.agent_version_id`;

function modelList(v) {
  const list = (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean);
  return list.length ? [...new Set(list)].slice(0, 6) : null;
}
const now = () => Math.floor(Date.now() / 1000);

function publicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN;
  return null;
}
function webhookUrl() {
  const base = publicUrl();
  return base ? `${base}/webhook/avito/${getSetting('webhook_secret')}` : null;
}

// ---------- helpers ----------
function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}
function readRaw(req, limit = 15e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Запись слишком длинная')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1)); });
  return out;
}
function authed(req) {
  if (!SESSION) return true;
  const c = cookies(req).sid || '';
  return c.length === SESSION.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(SESSION));
}
function mask(v) { return v ? '••••' + String(v).slice(-4) : ''; }
function periodFromQuery(q) {
  const from = q.get('from') ? Math.floor(new Date(q.get('from') + 'T00:00:00+03:00').getTime() / 1000) : now() - 30 * 86400;
  const to = q.get('to') ? Math.floor(new Date(q.get('to') + 'T23:59:59+03:00').getTime() / 1000) : now() + 60;
  return { from, to };
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// ---------- статистика ----------
function dashboard(from, to) {
  const one = (sql, ...a) => Object.values(db.prepare(sql).get(...a) || { v: 0 })[0] || 0;
  const incoming = one(`SELECT COUNT(*) v FROM chats c WHERE (SELECT MIN(created) FROM messages m WHERE m.chat_id = c.id AND m.source = 'client') BETWEEN ? AND ?
    AND (SELECT direction FROM messages m WHERE m.chat_id = c.id ORDER BY created LIMIT 1) = 'in'`, from, to);
  const leads = one('SELECT COUNT(*) v FROM chats WHERE lead_at BETWEEN ? AND ?', from, to);
  const leadsIn = one("SELECT COUNT(*) v FROM chats WHERE lead_at BETWEEN ? AND ? AND lead_channel = 'Входящий'", from, to);
  const botMsgs = one("SELECT COUNT(*) v FROM messages WHERE source IN ('bot','quick','template') AND created BETWEEN ? AND ?", from, to);
  const clientMsgs = one("SELECT COUNT(*) v FROM messages WHERE source = 'client' AND created BETWEEN ? AND ?", from, to);
  const botChats = one("SELECT COUNT(DISTINCT chat_id) v FROM messages WHERE source = 'bot' AND created BETWEEN ? AND ?", from, to);
  const handoffs = one("SELECT COUNT(*) v FROM events WHERE type = 'handoff' AND ts BETWEEN ? AND ?", from, to);
  const waiting = one("SELECT COUNT(*) v FROM chats WHERE needs_reply = 1 AND last_at > ?", now() - 86400);
  const totalChats = one('SELECT COUNT(*) v FROM chats');
  const days = [];
  const dayStart = (t) => { const d = new Date((t + 3 * 3600) * 1000); d.setUTCHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000) - 3 * 3600; };
  for (let d = dayStart(Math.max(from, to - 60 * 86400)); d <= to; d += 86400) {
    days.push({
      day: new Date((d + 3 * 3600) * 1000).toISOString().slice(5, 10).split('-').reverse().join('.'),
      incoming: one(`SELECT COUNT(*) v FROM chats c WHERE (SELECT MIN(created) FROM messages m WHERE m.chat_id = c.id AND m.source='client') BETWEEN ? AND ?`, d, d + 86399),
      leads: one('SELECT COUNT(*) v FROM chats WHERE lead_at BETWEEN ? AND ?', d, d + 86399),
      bot: one("SELECT COUNT(*) v FROM messages WHERE source IN ('bot','quick','template') AND created BETWEEN ? AND ?", d, d + 86399),
    });
  }
  // конверсия — по одной группе: входящие чаты периода и телефон от них за 7 дней (см. history.managerStats)
  const cohort = history.managerStats(from, to);
  return { incoming: cohort.chats, leads, leadsIn, conversion: cohort.conversion, cohort, botMsgs, clientMsgs, botChats, handoffs, waiting, totalChats, days };
}

// ---------- роутинг ----------
async function api(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const m = req.method;

  if (p === '/api/login' && m === 'POST') {
    const b = await readBody(req);
    if (!SESSION) return send(res, 200, { ok: true });
    if (b.password && b.password === ADMIN_PASSWORD) {
      return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${SESSION}; HttpOnly; Path=/; Max-Age=${60 * 86400}; SameSite=Lax${publicUrl()?.startsWith('https') ? '; Secure' : ''}` });
    }
    return send(res, 401, { error: 'Неверный пароль' });
  }
  if (p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
  if (p === '/api/me') return send(res, 200, { authRequired: Boolean(SESSION), loggedIn: authed(req) });
  if (!authed(req)) return send(res, 401, { error: 'Нужна авторизация' });

  if (p === '/api/status') {
    const s = allSettings();
    return send(res, 200, {
      avitoConfigured: avito.isConfigured(),
      avitoUserId: s.avito_user_id,
      avitoProfile: s.avito_profile_name,
      token: avito.tokenInfo(),
      openaiConfigured: Boolean(s.openai_api_key),
      model: s.openai_model,
      aiEnabled: s.ai_enabled === '1',
      aiStartedAt: Number(s.ai_started_at) || null,
      lastPoll: engine.getLastPoll(),
      webhookUrl: webhookUrl(),
      publicUrl: publicUrl(),
      passwordSet: Boolean(SESSION),
      sendEnabled: avito.sendingEnabled(),
      stats: {
        chats: db.prepare('SELECT COUNT(*) c FROM chats').get().c,
        leads: db.prepare('SELECT COUNT(*) c FROM chats WHERE phone IS NOT NULL').get().c,
      },
    });
  }

  if (p === '/api/dashboard') {
    const { from, to } = periodFromQuery(q);
    return send(res, 200, dashboard(from, to));
  }

  if (p === '/api/ai' && m === 'POST') {
    const b = await readBody(req);
    engine.enableAI(Boolean(b.enabled));
    return send(res, 200, { ok: true, aiEnabled: Boolean(b.enabled) });
  }

  // ----- чаты -----
  if (p === '/api/chats' && m === 'GET') {
    const where = [];
    const args = [];
    const search = (q.get('q') || '').trim();
    if (search) {
      where.push('(c.client_name LIKE ? OR c.item_title LIKE ? OR c.phone LIKE ? OR EXISTS (SELECT 1 FROM messages mm WHERE mm.chat_id = c.id AND mm.text LIKE ?))');
      const like = `%${search}%`;
      args.push(like, like, like, like);
    }
    switch (q.get('filter')) {
      case 'ai_on': where.push('c.ai_enabled = 1'); break;
      case 'ai_off': where.push('c.ai_enabled = 0'); break;
      case 'contact': where.push('c.phone IS NOT NULL'); break;
      case 'no_contact': where.push('c.phone IS NULL'); break;
      case 'waiting': where.push('c.needs_reply = 1'); break;
      case 'manager': where.push("c.status = 'manager'"); break;
    }
    const limit = Math.min(200, Number(q.get('limit') || 50));
    const offset = Number(q.get('offset') || 0);
    const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM chats c ${sqlWhere}`).get(...args).c;
    const rows = db.prepare(`SELECT c.*, (SELECT COALESCE(i.availability_manual, i.availability) FROM items i WHERE i.avito_id = c.item_id LIMIT 1) AS item_availability FROM chats c ${sqlWhere} ORDER BY COALESCE(c.last_at, c.updated) DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return send(res, 200, { total, chats: rows });
  }

  let mm = p.match(/^\/api\/chats\/([^/]+)(\/[a-z-]+)?$/);
  if (mm) {
    const id = decodeURIComponent(mm[1]);
    const action = mm[2] || '';
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
    if (!chat) return send(res, 404, { error: 'Чат не найден' });
    if (!action && m === 'GET') {
      const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created ASC, rowid ASC').all(id);
      const events = db.prepare('SELECT * FROM events WHERE chat_id = ? ORDER BY id DESC LIMIT 30').all(id);
      const runs = db.prepare(`${RUN_SELECT} WHERE r.chat_id = ? ORDER BY r.id ASC`).all(id);
      const reviewRow = db.prepare('SELECT * FROM chat_reviews WHERE chat_id = ?').get(id);
      const review = reviewRow ? { ...reviewRow, result: JSON.parse(reviewRow.result || '{}') } : null;
      return send(res, 200, { chat, messages, events, runs, review, sendEnabled: avito.sendingEnabled() });
    }
    if (action === '/send' && m === 'POST') {
      const b = await readBody(req);
      if (!b.text?.trim()) return send(res, 400, { error: 'Пустое сообщение' });
      if (!avito.sendingEnabled()) return send(res, 400, { error: 'Тестовый режим: отправка в Авито выключена' });
      await engine.sendAndStore(id, b.text.trim(), 'manager');
      if (b.pauseBot !== false) db.prepare("UPDATE chats SET status = 'manager' WHERE id = ?").run(id);
      return send(res, 200, { ok: true });
    }
    if (action === '/ai' && m === 'POST') {
      const b = await readBody(req);
      db.prepare('UPDATE chats SET ai_enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, id);
      return send(res, 200, { ok: true });
    }
    if (action === '/status' && m === 'POST') {
      const b = await readBody(req);
      const st = ['new', 'active', 'lead', 'manager'].includes(b.status) ? b.status : 'active';
      db.prepare('UPDATE chats SET status = ? WHERE id = ?').run(st, id);
      if (b.phone !== undefined) db.prepare('UPDATE chats SET phone = ?, lead_at = COALESCE(lead_at, ?), lead_channel = COALESCE(lead_channel, ?) WHERE id = ?').run(b.phone || null, b.phone ? now() : null, 'Входящий', id);
      return send(res, 200, { ok: true });
    }
    if (action === '/reply-now' && m === 'POST') {
      const r = await engine.processChat(id, { force: true });
      return send(res, 200, r);
    }
    if (action === '/replay' && m === 'POST') {
      const b = await readBody(req);
      try {
        return send(res, 200, await history.replayChat(id, { maxTurns: Math.min(20, Number(b.maxTurns) || 8), models: modelList(b.models), configs: configList(b.configs) }));
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (action === '/review' && m === 'POST') {
      try { return send(res, 200, await history.reviewChat(id)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (action === '/sync' && m === 'POST') {
      const n = await engine.syncChat(id);
      return send(res, 200, { ok: true, fresh: n });
    }
  }

  // ----- лиды -----
  if (p === '/api/leads' || p === '/api/leads.csv') {
    const { from, to } = periodFromQuery(q);
    const rows = db.prepare('SELECT * FROM chats WHERE phone IS NOT NULL AND lead_at BETWEEN ? AND ? ORDER BY lead_at DESC').all(from, to);
    if (p.endsWith('.csv')) {
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [['Имя', 'Телефон', 'Объявление', 'Цена', 'Тип', 'Дата', 'Чат'].map(esc).join(';')];
      for (const r of rows) lines.push([r.client_name, r.phone, r.item_title, r.item_price, r.lead_channel, new Date(r.lead_at * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }), `https://www.avito.ru/profile/messenger/channel/${r.id}`].map(esc).join(';'));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads.csv"' });
      return res.end('﻿' + lines.join('\n'));
    }
    return send(res, 200, { leads: rows });
  }

  // ----- настройки -----
  if (p === '/api/settings' && m === 'GET') {
    const s = allSettings();
    for (const k of SECRET_KEYS) s[k] = mask(s[k]);
    delete s.webhook_secret;
    return send(res, 200, s);
  }
  if (p === '/api/settings' && m === 'POST') {
    const b = await readBody(req);
    const allowed = Object.keys(allSettings()).filter((k) => !['ai_enabled', 'ai_started_at', 'webhook_secret', 'avito_user_id', 'avito_profile_name'].includes(k));
    let credsChanged = false;
    for (const [k, v] of Object.entries(b)) {
      if (!allowed.includes(k)) continue;
      if (SECRET_KEYS.includes(k) && String(v).startsWith('••••')) continue;
      if (k.startsWith('avito_client') && v !== getSetting(k)) credsChanged = true;
      setSetting(k, v);
    }
    if (credsChanged) { avito.resetCache(); setSetting('avito_user_id', ''); setSetting('avito_profile_name', ''); }
    return send(res, 200, { ok: true });
  }

  if (p === '/api/avito/test' && m === 'POST') {
    try {
      avito.resetCache();
      setSetting('avito_user_id', '');
      const id = await avito.userId();
      return send(res, 200, { ok: true, userId: id, name: getSetting('avito_profile_name') });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  if (p === '/api/sync' && m === 'POST') {
    const b = await readBody(req);
    const r = await engine.pollOnce({ pages: Math.min(10, Number(b.pages) || 1) });
    return send(res, r.ok === false ? 400 : 200, r);
  }
  if (p === '/api/webhook' && m === 'POST') {
    const b = await readBody(req);
    const url = webhookUrl();
    if (!url) return send(res, 400, { error: 'Не известен публичный адрес сервиса (PUBLIC_URL)' });
    try {
      const r = b.enabled === false ? await avito.unsubscribeWebhook(url) : await avito.subscribeWebhook(url);
      setSetting('webhook_enabled', b.enabled === false ? '0' : '1');
      logEvent('webhook', b.enabled === false ? 'Вебхук отключён' : 'Вебхук подключён: ' + url);
      return send(res, 200, { ok: true, result: r });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  // ----- шаблоны -----
  if (p === '/api/templates' && m === 'GET') {
    return send(res, 200, {
      templates: db.prepare('SELECT * FROM templates ORDER BY id DESC').all(),
      seen: db.prepare('SELECT * FROM system_seen ORDER BY hits DESC').all(),
    });
  }
  if (p === '/api/templates' && m === 'POST') {
    const b = await readBody(req);
    if (!b.reply?.trim()) return send(res, 400, { error: 'Нужен текст ответа' });
    if (b.id) {
      db.prepare('UPDATE templates SET flow_id = ?, match_text = ?, reply = ?, enabled = ? WHERE id = ?').run(b.flow_id || null, b.match_text || null, b.reply.trim(), b.enabled === false ? 0 : 1, b.id);
    } else {
      db.prepare('INSERT INTO templates(flow_id, match_text, reply, enabled, created) VALUES(?,?,?,?,?)').run(b.flow_id || null, b.match_text || null, b.reply.trim(), b.enabled === false ? 0 : 1, now());
    }
    return send(res, 200, { ok: true });
  }
  mm = p.match(/^\/api\/templates\/(\d+)$/);
  if (mm && m === 'DELETE') {
    db.prepare('DELETE FROM templates WHERE id = ?').run(Number(mm[1]));
    return send(res, 200, { ok: true });
  }


  // ----- фоновые задачи -----
  if (p === '/api/jobs') {
    return send(res, 200, { import: history.jobState('import'), replay: history.jobState('replay'), review: history.jobState('review'), cpa: history.jobState('cpa'), lab: history.jobState('lab') });
  }
  mm = p.match(/^\/api\/jobs\/(import|replay|review|cpa|lab)\/stop$/);
  if (mm && m === 'POST') { history.stopJob(mm[1]); return send(res, 200, { ok: true }); }

  // ----- архив и аналитика менеджеров -----
  if (p === '/api/archive/import' && m === 'POST') {
    const b = await readBody(req);
    if (!avito.isConfigured()) return send(res, 400, { error: 'Сначала подключите Авито' });
    try { return send(res, 200, history.importHistory({ maxChats: Number(b.maxChats) || 100000 })); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // ----- расходы Авито (целевые действия) -----
  if (p === '/api/cpa/import' && m === 'POST') {
    const b = await readBody(req);
    if (!avito.isConfigured()) return send(res, 400, { error: 'Сначала подключите Авито' });
    try {
      return send(res, 200, history.startJob('cpa', (job) => billing.importCpa({ days: Math.min(180, Number(b.days) || 60), calls: b.calls !== false }, job)));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/cpa/report') {
    const { from, to } = periodFromQuery(q);
    return send(res, 200, billing.report(q.get('from') ? from : 0, to));
  }
  if (p === '/api/archive/recount' && m === 'POST') {
    return send(res, 200, history.recountLeads());
  }
  if (p === '/api/archive/stats') {
    const { from, to } = periodFromQuery(q);
    return send(res, 200, history.managerStats(q.get('from') ? from : 0, to));
  }
  if (p === '/api/archive/export.jsonl') {
    const { from, to } = periodFromQuery(q);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': 'attachment; filename="avito-chats.jsonl"' });
    for (const line of history.exportJsonl(q.get('from') ? from : 0, to)) res.write(line);
    return res.end();
  }
  if (p === '/api/archive/review' && m === 'POST') {
    const b = await readBody(req);
    try {
      return send(res, 200, history.reviewBatch({ count: Math.min(200, Number(b.count) || 20), order: b.order, onlyLeads: Boolean(b.onlyLeads), onlyWithSeller: b.onlyWithSeller !== false }));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/archive/report' && m === 'POST') {
    try { return send(res, 200, await history.buildReport()); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/archive/reports') {
    const r = db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 1').get();
    const reviews = db.prepare(`SELECT r.chat_id, r.score, r.outcome, r.result, r.created, c.client_name, c.item_title, c.phone
      FROM chat_reviews r LEFT JOIN chats c ON c.id = r.chat_id ORDER BY r.created DESC LIMIT 300`).all()
      .map((x) => { const res = JSON.parse(x.result || '{}'); return { ...x, result: undefined, summary: res.summary, mistakes: res.mistakes || [] }; });
    return send(res, 200, { report: r ? { ...r, result: JSON.parse(r.result || '{}') } : null, reviews });
  }

  // ----- прогон агента по реальным чатам и оценка ответов -----
  if (p === '/api/replay-batch' && m === 'POST') {
    const b = await readBody(req);
    try {
      return send(res, 200, history.replayBatch({
        count: Math.min(100, Number(b.count) || 10), maxTurns: Math.min(10, Number(b.maxTurns) || 3),
        order: b.order, onlyLeads: Boolean(b.onlyLeads), skipDone: b.skipDone !== false, models: modelList(b.models), configs: configList(b.configs),
      }));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/runs' && m === 'GET') {
    const where = [];
    switch (q.get('filter')) {
      case 'unrated': where.push('r.rating IS NULL'); break;
      case 'good': where.push('r.rating = 1'); break;
      case 'bad': where.push('r.rating = -1'); break;
      case 'shadow': where.push("r.kind = 'shadow'"); break;
      case 'replay': where.push("r.kind = 'replay'"); break;
    }
    if (q.get('model')) where.push('r.model = ?');
    const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(300, Number(q.get('limit') || 100));
    // группа = одно сообщение клиента; в группу берём ответы всех моделей (последний от каждой)
    const groups = db.prepare(`SELECT r.chat_id, r.at_message_id, MAX(r.id) mx FROM agent_runs r ${sqlWhere}
      GROUP BY r.chat_id, r.at_message_id ORDER BY mx DESC LIMIT ?`).all(...(q.get('model') ? [q.get('model')] : []), limit);
    // последний ответ каждой конфигурации (версия × модель) на это сообщение
    const groupRuns = db.prepare(`${RUN_SELECT}
      WHERE r.chat_id = ? AND r.at_message_id = ? AND r.id IN (SELECT MAX(id) FROM agent_runs WHERE chat_id = r.chat_id AND at_message_id = r.at_message_id
        GROUP BY COALESCE(model, ''), COALESCE(agent_version_id, 0))
      ORDER BY v.key, r.model`);
    const rows = groups.flatMap((g) => groupRuns.all(g.chat_id, g.at_message_id));
    const nextOut = db.prepare("SELECT direction, source, text FROM messages WHERE chat_id = ? AND created > ? AND source != 'system' ORDER BY created ASC, rowid ASC LIMIT 6");
    for (const r of rows) {
      const after = nextOut.all(r.chat_id, r.at_created);
      const out = [];
      for (const x of after) { if (x.direction === 'in') break; out.push(x.text); }
      r.actual = out.join('\n');
    }
    const stats = db.prepare(`SELECT COUNT(*) total, SUM(rating = 1) good, SUM(rating = -1) bad, SUM(rating IS NULL) unrated,
      SUM(kind = 'shadow') shadow, SUM(kind = 'replay') replay, SUM(tokens) tokens FROM agent_runs`).get();
    const models = db.prepare(`SELECT r.model, r.agent_version_id, v.key AS v_key, v.version AS v_version, COUNT(*) total, SUM(r.rating = 1) good, SUM(r.rating = -1) bad,
      SUM(r.comment LIKE 'Ошибка%') errors, ROUND(AVG(r.tokens)) avg_tokens, ROUND(AVG(r.ms)) avg_ms, SUM(r.handoff) handoffs, SUM(r.phone IS NOT NULL) phones
      FROM agent_runs r LEFT JOIN agent_versions v ON v.id = r.agent_version_id GROUP BY r.model, r.agent_version_id ORDER BY total DESC`).all();
    let compareConfigs = [];
    try { compareConfigs = JSON.parse(getSetting('compare_configs') || '[]'); } catch { /* ignore */ }
    const versions = db.prepare("SELECT id, key, version, title FROM agent_versions WHERE status = 'active' ORDER BY key, id").all();
    return send(res, 200, { runs: rows, stats, models, versions, compareConfigs, compareModels: agent.compareModels(), primaryModel: getSetting('openai_model') });
  }
  mm = p.match(/^\/api\/runs\/(\d+)$/);
  if (mm && m === 'POST') {
    const b = await readBody(req);
    const run = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(Number(mm[1]));
    if (!run) return send(res, 404, { error: 'Не найдено' });
    if (b.rating !== undefined) db.prepare('UPDATE agent_runs SET rating = ? WHERE id = ?').run(b.rating === null ? null : Number(b.rating) > 0 ? 1 : -1, run.id);
    if (b.correction !== undefined) db.prepare('UPDATE agent_runs SET correction = ? WHERE id = ?').run(b.correction || null, run.id);
    if (b.comment !== undefined) db.prepare('UPDATE agent_runs SET comment = ? WHERE id = ?').run(b.comment || null, run.id);
    let kbId = null;
    if (b.addToKb && (b.correction || run.reply)) {
      kbId = Number(db.prepare("INSERT INTO kb(category, title, content, enabled, source, created, updated) VALUES('example', ?, ?, 1, 'correction', ?, ?)")
        .run((run.client_text || '').slice(0, 500), (b.correction || run.reply).trim(), now(), now()).lastInsertRowid);
    }
    return send(res, 200, { ok: true, kbId });
  }
  if (mm && m === 'DELETE') {
    db.prepare('DELETE FROM agent_runs WHERE id = ?').run(Number(mm[1]));
    return send(res, 200, { ok: true });
  }

  // Dedicated GPT laboratory: all routes are below the existing auth gate.
  if (p.startsWith('/api/gpt-lab/')) {
    try {
      if (p === '/api/gpt-lab/config' && m === 'GET') return send(res, 200, gptLab.config());
      if (p === '/api/gpt-lab/run' && m === 'POST') return send(res, 200, gptLab.start(await readBody(req)));
      if (p === '/api/gpt-lab/results' && m === 'GET') return send(res, 200, gptLab.results(q.get('batch')));
      if (p === '/api/gpt-lab/job' && m === 'GET') {
        const j=history.jobState('gpt_lab');
        return send(res,200,j ? {running:j.running,batch:j.batch,done:j.done,total:j.total,errors:j.errors,error:j.error,note:j.stop?'Остановлено: начатые запросы сохраняются':j.running?'Модели отвечают…':'Готово'} : null);
      }
      if (p === '/api/gpt-lab/stop' && m === 'POST') { history.stopJob('gpt_lab'); return send(res,200,{ok:true}); }
      const match=p.match(/^\/api\/gpt-lab\/review\/(\d+)$/);
      if(match && m === 'POST') {gptLab.review(match[1],await readBody(req));return send(res,200,{ok:true});}
      return send(res,404,{error:'Not found'});
    } catch(e) { return send(res,400,{error:e.message}); }
  }

  // ----- Лаборатория: стратегии × модели на тестовых сценариях (изолировано от чатов и Авито) -----
  if (p === '/api/lab/config') {
    const items = db.prepare(`SELECT key, title, price, COALESCE(availability_manual, availability) availability FROM items
      WHERE avito_id IS NOT NULL AND (status = 'active' OR status IS NULL) ORDER BY title LIMIT 400`).all();
    return send(res, 200, { strategies: lab.strategies(), models: lab.models(), profiles: lab.profiles(), cases: lab.cases(), criteria: lab.CRITERIA, items });
  }
  if (p === '/api/lab/estimate' && m === 'POST') {
    const b = await readBody(req);
    return send(res, 200, lab.estimate({ caseIds: b.caseIds || [], versionIds: b.versionIds || [], modelIds: (b.modelIds || []).map(Number), repeats: Math.max(1, Math.min(5, Number(b.repeats) || 1)), itemKey: b.itemKey || null }));
  }
  if (p === '/api/lab/run' && m === 'POST') {
    const b = await readBody(req);
    try {
      const job = lab.start({ caseIds: b.caseIds || [], versionIds: b.versionIds || [], modelIds: (b.modelIds || []).map(Number),
        repeats: Math.max(1, Math.min(5, Number(b.repeats) || 1)), concurrency: b.concurrency, limitUsd: b.limitUsd, itemKey: b.itemKey || null }, history.startJob);
      return send(res, 200, job);
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/lab/case' && m === 'POST') {
    const b = await readBody(req);
    const turns = (Array.isArray(b.client_turns) ? b.client_turns : String(b.text || '').split(/\n\s*\n/)).map((x) => String(x).trim()).filter(Boolean);
    if (!turns.length) return send(res, 400, { error: 'Нужен текст вопроса клиента' });
    let facts = {};
    try { facts = b.facts ? (typeof b.facts === 'string' ? JSON.parse(b.facts) : b.facts) : {}; } catch { return send(res, 400, { error: 'Факты должны быть в формате JSON' }); }
    const id = 'CUS' + Date.now().toString(36).toUpperCase();
    db.prepare('INSERT INTO lab_cases(id, set_name, version, title, facts, client_turns, turn_mode, expected, created) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, 'custom', '1', (b.title || turns[0]).slice(0, 80), JSON.stringify(facts), JSON.stringify(turns), b.turn_mode === 'consecutive' ? 'consecutive_messages_one_response' : 'sequential_dialogue', JSON.stringify([]), now());
    return send(res, 200, { ok: true, id });
  }
  if (p === '/api/lab/runs' && m === 'GET') {
    return send(res, 200, { runs: lab.runs({ caseId: q.get('case') || undefined, batch: q.get('batch') || undefined, limit: Math.min(2000, Number(q.get('limit') || 300)) }) });
  }
  mm = p.match(/^\/api\/lab\/runs\/(\d+)\/rate$/);
  if (mm && m === 'POST') { lab.rate(mm[1], await readBody(req)); return send(res, 200, { ok: true }); }
  if (p === '/api/lab/summary') {
    return send(res, 200, { summary: lab.summary({ batch: q.get('batch') || undefined, set: q.get('set') || undefined }) });
  }
  if (p === '/api/lab/batches') return send(res, 200, { batches: lab.batches() });
  if (p === '/api/lab/ask' && m === 'POST') {
    const b = await readBody(req);
    try { return send(res, 200, { run: await lab.ask(b) }); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // ----- пояснения владельца к вопросам и голосовой ввод -----
  if (p === '/api/lab/notes' && m === 'GET') return send(res, 200, { notes: lab.notes({ set: q.get('set') || 'archive' }) });
  if (p === '/api/lab/notes' && m === 'POST') {
    const b = await readBody(req);
    try { lab.saveNote(b.case_id, b.note); } catch (e) { return send(res, 400, { error: e.message }); }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/lab/notes.csv') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="voprosy-otvety-poyasneniya.csv"' });
    return res.end(lab.notesCsv({ set: q.get('set') || 'archive' }));
  }
  if (p === '/api/transcribe' && m === 'POST') {
    try {
      const buf = await readRaw(req);
      if (!buf.length) return send(res, 400, { error: 'Пустая запись' });
      const text = await llm.transcribe({ profile: lab.transcribeProfile(), buf, mime: req.headers['content-type'] || 'audio/webm' });
      return send(res, 200, { text });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/lab/export.csv') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="lab-answers.csv"' });
    return res.end(lab.exportCsv({ batch: q.get('batch') || undefined }));
  }
  if (p === '/api/lab/export.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="lab-results.json"' });
    return res.end(JSON.stringify(lab.exportAll({ batch: q.get('batch') || undefined }), null, 1));
  }
  // профили ключей: секрет только записывается, наружу — маска
  if (p === '/api/key-profiles' && m === 'GET') return send(res, 200, { profiles: lab.profiles() });
  if (p === '/api/key-profiles' && m === 'POST') {
    const b = await readBody(req);
    if (!b.name?.trim()) return send(res, 400, { error: 'Нужно название профиля' });
    const provider = b.provider === 'openrouter' ? 'openrouter' : 'openai';
    if (b.id) {
      db.prepare('UPDATE key_profiles SET name = ?, provider = ?, base_url = ? WHERE id = ?').run(b.name.trim(), provider, b.base_url?.trim() || null, Number(b.id));
      if (b.api_key && !String(b.api_key).startsWith('••••')) db.prepare('UPDATE key_profiles SET api_key = ? WHERE id = ?').run(String(b.api_key).trim(), Number(b.id));
      return send(res, 200, { ok: true, id: Number(b.id) });
    }
    try {
      const r = db.prepare('INSERT INTO key_profiles(name, provider, base_url, api_key, created) VALUES(?,?,?,?,?)').run(b.name.trim(), provider, b.base_url?.trim() || null, b.api_key?.trim() || null, now());
      return send(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
    } catch { return send(res, 400, { error: 'Профиль с таким названием уже есть' }); }
  }
  mm = p.match(/^\/api\/key-profiles\/(\d+)$/);
  if (mm && m === 'DELETE') {
    db.prepare('UPDATE lab_models SET key_profile_id = NULL WHERE key_profile_id = ?').run(Number(mm[1]));
    db.prepare('DELETE FROM key_profiles WHERE id = ?').run(Number(mm[1]));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/lab/models' && m === 'POST') {
    const b = await readBody(req);
    const num = (v) => (v === '' || v == null ? null : Number(v));
    const vals = [b.label?.trim() || b.model, b.model?.trim(), b.api === 'chat' ? 'chat' : 'responses', Number(b.key_profile_id) || null, b.reasoning_effort || null,
      num(b.max_output_tokens), num(b.price_in), num(b.price_cached_in), num(b.price_out), b.price_version || null, b.active === undefined ? 1 : (b.active === false || b.active === '0' || b.active === 0 ? 0 : 1)];
    if (!vals[1]) return send(res, 400, { error: 'Нужно имя модели' });
    if (b.id) db.prepare('UPDATE lab_models SET label = ?, model = ?, api = ?, key_profile_id = ?, reasoning_effort = ?, max_output_tokens = ?, price_in = ?, price_cached_in = ?, price_out = ?, price_version = ?, active = ? WHERE id = ?').run(...vals, Number(b.id));
    else db.prepare('INSERT INTO lab_models(label, model, api, key_profile_id, reasoning_effort, max_output_tokens, price_in, price_cached_in, price_out, price_version, active, created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals, now());
    return send(res, 200, { ok: true });
  }

  // ----- версии агента (стратегии) -----
  if (p === '/api/agent-versions' && m === 'GET') {
    const rows = db.prepare(`SELECT v.*, (SELECT COUNT(*) FROM agent_runs r WHERE r.agent_version_id = v.id) runs FROM agent_versions v ORDER BY v.key, v.id`).all();
    return send(res, 200, { versions: rows, liveVersionId: Number(getSetting('live_agent_version_id')) || null });
  }
  if (p === '/api/agent-versions' && m === 'POST') {
    const b = await readBody(req);
    if (!b.key?.trim() || !b.version?.trim() || !b.base_prompt?.trim()) return send(res, 400, { error: 'Нужны ключ, номер версии и общая инструкция' });
    if (db.prepare('SELECT 1 FROM agent_versions WHERE key = ? AND version = ?').get(b.key.trim(), b.version.trim())) {
      return send(res, 400, { error: 'Такая версия уже есть. Версии не меняются — укажите новый номер, например v0.2.1' });
    }
    const r = db.prepare('INSERT INTO agent_versions(key, version, title, base_prompt, strategy, model, temperature, status, created) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(b.key.trim(), b.version.trim(), b.title?.trim() || null, b.base_prompt.trim(), b.strategy?.trim() || null, b.model?.trim() || null,
        b.temperature === '' || b.temperature == null ? null : Number(b.temperature), 'active', now());
    return send(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
  }
  mm = p.match(/^\/api\/agent-versions\/(\d+)\/status$/);
  if (mm && m === 'POST') {
    const b = await readBody(req);
    db.prepare('UPDATE agent_versions SET status = ? WHERE id = ?').run(b.status === 'archived' ? 'archived' : 'active', Number(mm[1]));
    return send(res, 200, { ok: true });
  }

  // ----- база знаний -----
  if (p === '/api/kb' && m === 'GET') {
    return send(res, 200, { entries: db.prepare('SELECT * FROM kb ORDER BY category, id DESC').all(), categories: knowledge.KB_CATEGORIES });
  }
  if (p === '/api/kb' && m === 'POST') {
    const b = await readBody(req);
    const list = Array.isArray(b.entries) ? b.entries : [b];
    const ids = [];
    for (const e of list) {
      if (!e.content?.trim() || !knowledge.KB_CATEGORIES[e.category]) continue;
      if (e.id) {
        db.prepare('UPDATE kb SET category = ?, title = ?, content = ?, enabled = ?, updated = ? WHERE id = ?')
          .run(e.category, e.title?.trim() || null, e.content.trim(), e.enabled === false || e.enabled === 0 ? 0 : 1, now(), e.id);
        ids.push(e.id);
      } else {
        // из разбора чатов — кандидат: факты из старых ответов продавцов нужно проверить перед использованием
        const status = e.source === 'analysis' ? 'candidate' : 'approved';
        ids.push(Number(db.prepare('INSERT INTO kb(category, title, content, enabled, source, status, created, updated) VALUES(?,?,?,?,?,?,?,?)')
          .run(e.category, e.title?.trim() || null, e.content.trim(), e.enabled === false ? 0 : 1, e.source || 'manual', status, now(), now()).lastInsertRowid));
      }
    }
    if (!ids.length) return send(res, 400, { error: 'Нужен текст и категория' });
    return send(res, 200, { ok: true, ids });
  }
  mm = p.match(/^\/api\/kb\/(\d+)\/status$/);
  if (mm && m === 'POST') {
    const b = await readBody(req);
    db.prepare('UPDATE kb SET status = ?, updated = ? WHERE id = ?').run(b.status === 'candidate' ? 'candidate' : 'approved', now(), Number(mm[1]));
    return send(res, 200, { ok: true });
  }
  mm = p.match(/^\/api\/kb\/(\d+)$/);
  if (mm && m === 'DELETE') {
    db.prepare('DELETE FROM kb WHERE id = ?').run(Number(mm[1]));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/rules/append' && m === 'POST') {
    const b = await readBody(req);
    if (!b.text?.trim()) return send(res, 400, { error: 'Пустой текст' });
    setSetting('rules', getSetting('rules').trim() + '\n\n' + b.text.trim());
    return send(res, 200, { ok: true });
  }

  // ----- автомобили (объявления) -----
  if (p === '/api/items' && m === 'GET') {
    const search = (q.get('q') || '').trim();
    const args = [];
    let where = '';
    if (search) { where = 'WHERE title LIKE ? OR vin LIKE ? OR CAST(avito_id AS TEXT) LIKE ?'; args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    const rows = db.prepare(`SELECT key, avito_id, ad_id, title, price, url, status, vin, year, mileage, source, updated, length(description) desc_len,
      availability, availability_src, availability_manual,
      (SELECT COUNT(*) FROM chats c WHERE c.item_id = items.avito_id) chats FROM items ${where} ORDER BY status = 'active' DESC, title LIMIT 500`).all(...args);
    return send(res, 200, { items: rows, stats: knowledge.itemsStats(), feedUrl: getSetting('feed_url'), feedSyncedAt: Number(getSetting('feed_synced_at')) || null, feedSyncHours: knowledge.feedSyncHours() });
  }
  if (p === '/api/items/import-api' && m === 'POST') {
    try { return send(res, 200, await knowledge.importItemsFromApi()); } catch (e) { logEvent('kb', 'Объявления не загрузились: ' + e.message, null, 'error'); return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/items/import-feed' && m === 'POST') {
    const b = await readBody(req);
    try {
      if (b.url !== undefined) setSetting('feed_url', b.url.trim());
      return send(res, 200, await knowledge.importFeed(b.url?.trim() || undefined));
    } catch (e) { logEvent('kb', 'Фид не загрузился: ' + e.message, null, 'error'); return send(res, 400, { error: e.message }); }
  }
  // ручная отметка наличия: {keys:[…] | onlyUnknown:true, value:'in_stock'|'in_transit'|'on_order'|null}
  if (p === '/api/items/availability' && m === 'POST') {
    const b = await readBody(req);
    const value = ['in_stock', 'in_transit', 'on_order'].includes(b.value) ? b.value : null;
    let n = 0;
    if (b.onlyUnknown) {
      n = Number(db.prepare("UPDATE items SET availability_manual = ? WHERE status = 'active' AND COALESCE(availability_manual, availability) IS NULL").run(value).changes);
    } else {
      for (const k of b.keys || []) n += Number(db.prepare('UPDATE items SET availability_manual = ? WHERE key = ?').run(value, String(k)).changes);
    }
    return send(res, 200, { ok: true, changed: n });
  }
  mm = p.match(/^\/api\/items\/([^/]+)$/);
  if (mm && m === 'GET') {
    const it = db.prepare('SELECT * FROM items WHERE key = ?').get(decodeURIComponent(mm[1]));
    if (!it) return send(res, 404, { error: 'Не найдено' });
    return send(res, 200, { item: it, card: knowledge.itemCard(it) });
  }

  // ----- песочница -----
  if (p === '/api/sandbox' && m === 'POST') {
    const b = await readBody(req);
    try {
      const history = (b.history || []).map((x) => ({ direction: x.direction === 'out' ? 'out' : 'in', type: 'text', text: String(x.text || ''), source: x.direction === 'out' ? 'bot' : 'client' }));
      const item = b.item?.id ? { id: Number(b.item.id), title: b.item.title } : b.item?.title ? b.item : null;
      const models = modelList(b.models);
      const versionId = Number(b.versionId) || null;
      if (models) {
        const results = await Promise.allSettled(models.map((model) => agent.generateReply({ item, phone: null, history }, { model, versionId })));
        const variants = results.map((x, i) => (x.status === 'fulfilled' ? x.value : { model: models[i], error: x.reason.message }));
        return send(res, 200, { ...(variants.find((v) => !v.error) || {}), variants });
      }
      const r = await agent.generateReply({ item, phone: null, history }, { versionId });
      return send(res, 200, r);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  if (p === '/api/events') {
    return send(res, 200, { events: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(Math.min(500, Number(q.get('limit') || 100))) });
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true });

    // вебхук Авито: отвечаем сразу, обрабатываем в фоне
    const wh = url.pathname.match(/^\/webhook\/avito\/([a-f0-9]+)$/);
    if (wh && req.method === 'POST') {
      const body = await readBody(req);
      if (wh[1] !== getSetting('webhook_secret')) return send(res, 403, { error: 'forbidden' });
      send(res, 200, { ok: true });
      const v = body?.payload?.value || {};
      if (v.chat_id) engine.syncChat(v.chat_id).catch((e) => logEvent('webhook', e.message, v.chat_id, 'error'));
      return;
    }

    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    logEvent('http', `${req.method} ${url.pathname}: ${e.message}`, null, 'error');
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Avito Assistant слушает порт ${PORT}`);
  if (!SESSION) console.warn('ВНИМАНИЕ: ADMIN_PASSWORD не задан — интерфейс открыт без пароля');
  engine.startPolling();
  knowledge.startFeedSync();
});
