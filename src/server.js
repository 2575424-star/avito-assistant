const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { db, getSetting, setSetting, allSettings, logEvent } = require('./db');
const avito = require('./avito');
const agent = require('./agent');
const engine = require('./engine');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION = ADMIN_PASSWORD ? crypto.createHmac('sha256', ADMIN_PASSWORD).update('avito-assistant-session').digest('hex') : null;
const SECRET_KEYS = ['avito_client_secret', 'openai_api_key', 'tg_bot_token'];
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
  return { incoming, leads, leadsIn, conversion: incoming ? Math.round((leadsIn / incoming) * 1000) / 10 : 0, botMsgs, clientMsgs, botChats, handoffs, waiting, totalChats, days };
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
    const rows = db.prepare(`SELECT c.* FROM chats c ${sqlWhere} ORDER BY COALESCE(c.last_at, c.updated) DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
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
      return send(res, 200, { chat, messages, events });
    }
    if (action === '/send' && m === 'POST') {
      const b = await readBody(req);
      if (!b.text?.trim()) return send(res, 400, { error: 'Пустое сообщение' });
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

  // ----- песочница -----
  if (p === '/api/sandbox' && m === 'POST') {
    const b = await readBody(req);
    try {
      const history = (b.history || []).map((x) => ({ direction: x.direction === 'out' ? 'out' : 'in', type: 'text', text: String(x.text || ''), source: x.direction === 'out' ? 'bot' : 'client' }));
      const r = await agent.generateReply({ item: b.item?.title ? b.item : null, phone: null, history });
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
});
