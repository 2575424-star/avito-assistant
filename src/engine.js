// Синхронизация чатов с Авито и логика автоответа.
const { db, getSetting, setSetting, logEvent } = require('./db');
const avito = require('./avito');
const agent = require('./agent');

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Преобразование объектов Авито ----------
function messageText(m) {
  const c = m.content || {};
  if (c.text) return c.text;
  switch (m.type) {
    case 'image': return '[Изображение]';
    case 'voice': return '[Голосовое сообщение]';
    case 'call': return c.call?.status === 'missed' ? '[Пропущенный звонок]' : '[Звонок]';
    case 'item': return `[Объявление: ${c.item?.title || ''} ${c.item?.item_url || ''}]`.trim();
    case 'link': return c.link?.url ? `[Ссылка] ${c.link.url}` : '[Ссылка]';
    case 'location': return `[Геолокация] ${c.location?.text || ''}`.trim();
    case 'deleted': return '[Сообщение удалено]';
    default: return '';
  }
}

function chatFromApi(c, uid) {
  const ctx = c.context || {};
  const item = ctx.type === 'item' ? ctx.value || {} : null;
  const client = (c.users || []).find((u) => String(u.id) !== String(uid)) || {};
  return {
    id: c.id,
    chat_type: item ? 'u2i' : 'u2u',
    item_id: item?.id || null,
    item_title: item?.title || null,
    item_price: item?.price_string || null,
    item_url: item?.url || null,
    item_image: item?.images?.main?.['140x105'] || null,
    client_id: client.id || null,
    client_name: client.name || null,
    created: c.created || null,
    updated: c.updated || null,
  };
}

const upsertChatStmt = db.prepare(`
INSERT INTO chats(id, chat_type, item_id, item_title, item_price, item_url, item_image, client_id, client_name, created, updated, synced_at)
VALUES(:id, :chat_type, :item_id, :item_title, :item_price, :item_url, :item_image, :client_id, :client_name, :created, :updated, :synced_at)
ON CONFLICT(id) DO UPDATE SET
  chat_type = excluded.chat_type,
  item_id = COALESCE(excluded.item_id, chats.item_id),
  item_title = COALESCE(excluded.item_title, chats.item_title),
  item_price = COALESCE(excluded.item_price, chats.item_price),
  item_url = COALESCE(excluded.item_url, chats.item_url),
  item_image = COALESCE(excluded.item_image, chats.item_image),
  client_id = COALESCE(excluded.client_id, chats.client_id),
  client_name = COALESCE(excluded.client_name, chats.client_name),
  created = COALESCE(chats.created, excluded.created),
  updated = excluded.updated,
  synced_at = excluded.synced_at
`);

const insertMsgStmt = db.prepare(`
INSERT INTO messages(id, chat_id, author_id, direction, type, text, flow_id, created, source)
VALUES(?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO NOTHING
`);

function refreshChatSummary(chatId) {
  const last = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created DESC, rowid DESC LIMIT 1').get(chatId);
  if (!last) return;
  const needs = last.direction === 'in' && last.source === 'client' ? 1 : 0;
  db.prepare('UPDATE chats SET last_text = ?, last_direction = ?, last_at = ?, needs_reply = ? WHERE id = ?')
    .run(last.text, last.direction, last.created, needs, chatId);
}

// тексты, которые мы только что отправили через API: чтобы синхронизация не приняла их за ответ менеджера
const pendingOut = new Map(); // text -> {source, ts}

function classify(m, uid) {
  if (m.type === 'system' || String(m.author_id) === '0') return 'system';
  if (m.direction === 'in') return 'client';
  if (m.content?.flow_id) return 'system';
  const p = pendingOut.get(m.content?.text || '');
  if (p && Date.now() - p.ts < 5 * 60_000) return p.source;
  return 'manager';
}

/** Сохранить сообщения; вернуть только новые. */
function storeMessages(chatId, apiMessages, uid) {
  const fresh = [];
  for (const m of apiMessages) {
    const source = classify(m, uid);
    const r = insertMsgStmt.run(
      m.id, chatId, m.author_id ?? null, m.direction || (String(m.author_id) === String(uid) ? 'out' : 'in'),
      m.type || 'text', messageText(m), m.content?.flow_id || null, m.created || now(), source,
    );
    if (r.changes) fresh.push({ ...m, source, text: messageText(m) });
  }
  if (fresh.length) refreshChatSummary(chatId);
  return fresh;
}

// ---------- Лиды ----------
function markLead(chatId, phone, how = 'чат') {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat || chat.phone) return false;
  const first = db.prepare('SELECT direction, source FROM messages WHERE chat_id = ? ORDER BY created ASC LIMIT 1').get(chatId);
  const channel = first && first.direction === 'out' ? 'Исходящий' : 'Входящий';
  db.prepare("UPDATE chats SET phone = ?, lead_at = ?, lead_channel = ?, status = CASE WHEN status = 'manager' THEN status ELSE 'lead' END WHERE id = ?")
    .run(phone, now(), channel, chatId);
  logEvent('lead', `Контакт ${phone} (${how})`, chatId);
  notify(`✅ Новый контакт с Авито\n${chat.client_name || 'Клиент'}: ${phone}\n${chat.item_title || 'Личный чат'}${chat.item_price ? ' — ' + chat.item_price : ''}\nhttps://www.avito.ru/profile/messenger/channel/${chatId}`);
  return true;
}

async function notify(text) {
  const token = getSetting('tg_bot_token');
  const chatId = getSetting('tg_chat_id');
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    logEvent('telegram', 'Не удалось отправить уведомление: ' + e.message, null, 'error');
  }
}

// ---------- Синхронизация ----------
async function syncChat(chatId, apiChat = null) {
  const uid = await avito.userId();
  if (!apiChat) apiChat = await avito.getChat(chatId);
  const existed = db.prepare('SELECT id FROM chats WHERE id = ?').get(chatId);
  upsertChatStmt.run({ ...chatFromApi(apiChat, uid), synced_at: now() });
  const msgs = await avito.getMessages(chatId, { limit: existed ? 30 : 100 });
  const fresh = storeMessages(chatId, msgs.slice().reverse(), uid);
  afterNewMessages(chatId, fresh);
  return fresh.length;
}

function afterNewMessages(chatId, fresh) {
  if (!fresh.length) return;
  const startedAt = Number(getSetting('ai_started_at') || 0);
  let schedule = false;
  for (const m of fresh) {
    if (m.source === 'client') {
      const phone = agent.extractPhone(m.text);
      if (phone) markLead(chatId, phone, 'из сообщения клиента');
      if (m.created >= startedAt) schedule = true;
    }
    if (m.source === 'system') {
      recordSystem(m);
      if (m.created >= startedAt) schedule = true;
    }
    if (m.source === 'manager' && startedAt && m.created >= startedAt && getSetting('pause_on_manager') !== '0') {
      const chat = db.prepare('SELECT status FROM chats WHERE id = ?').get(chatId);
      if (chat && chat.status !== 'manager') {
        db.prepare("UPDATE chats SET status = 'manager' WHERE id = ?").run(chatId);
        logEvent('manager', 'Менеджер ответил вручную — бот в этом чате на паузе', chatId);
      }
    }
  }
  if (schedule) scheduleReply(chatId);
}

function recordSystem(m) {
  const flow = m.content?.flow_id || m.flow_id || 'system';
  db.prepare(`INSERT INTO system_seen(flow_id, sample, hits, last_at) VALUES(?,?,1,?)
    ON CONFLICT(flow_id) DO UPDATE SET hits = hits + 1, last_at = excluded.last_at, sample = excluded.sample`)
    .run(flow, (m.text || '').slice(0, 500), now());
}

let pollRunning = false;
let lastPoll = { at: null, ok: null, error: null, chats: 0, fresh: 0 };

async function pollOnce({ pages = 1 } = {}) {
  if (pollRunning || !avito.isConfigured()) return lastPoll;
  pollRunning = true;
  let total = 0, fresh = 0;
  try {
    const uid = await avito.userId();
    for (let p = 0; p < pages; p++) {
      const chats = await avito.getChats({ limit: 100, offset: p * 100 });
      total += chats.length;
      for (const c of chats) {
        const stored = db.prepare('SELECT updated FROM chats WHERE id = ?').get(c.id);
        if (stored && stored.updated >= (c.updated || 0)) continue;
        try {
          upsertChatStmt.run({ ...chatFromApi(c, uid), synced_at: now() });
          const msgs = await avito.getMessages(c.id, { limit: stored ? 30 : 50 });
          const newOnes = storeMessages(c.id, msgs.slice().reverse(), uid);
          fresh += newOnes.length;
          afterNewMessages(c.id, newOnes);
          await sleep(120);
        } catch (e) {
          logEvent('sync', `Чат не синхронизирован: ${e.message}`, c.id, 'error');
        }
      }
      if (chats.length < 100) break;
    }
    lastPoll = { at: now(), ok: true, error: null, chats: total, fresh };
  } catch (e) {
    lastPoll = { at: now(), ok: false, error: e.message, chats: total, fresh };
    logEvent('sync', e.message, null, 'error');
  } finally {
    pollRunning = false;
  }
  return lastPoll;
}

let pollTimer = null;
function startPolling() {
  const tick = async () => {
    await pollOnce().catch(() => {});
    const sec = Math.max(10, Number(getSetting('poll_interval_sec') || 30));
    pollTimer = setTimeout(tick, sec * 1000);
  };
  if (!pollTimer) pollTimer = setTimeout(tick, 3000);
}

// ---------- Автоответ ----------
const timers = new Map();
const processing = new Set();

function scheduleReply(chatId, delaySec) {
  if (getSetting('ai_enabled') !== '1') return;
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat || !chat.ai_enabled || chat.status === 'manager') return;

  // быстрый ответ — один раз, до ответа ИИ
  if (getSetting('quick_reply_enabled') === '1' && !chat.quick_sent && getSetting('quick_reply_text').trim()) {
    const hasOut = db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND direction = 'out' LIMIT 1").get(chatId);
    const lastIn = db.prepare("SELECT source FROM messages WHERE chat_id = ? ORDER BY created DESC LIMIT 1").get(chatId);
    if (!hasOut && lastIn?.source === 'client' && canAnswerChat(chat)) {
      db.prepare('UPDATE chats SET quick_sent = 1 WHERE id = ?').run(chatId);
      setTimeout(() => sendAndStore(chatId, getSetting('quick_reply_text').trim(), 'quick').catch((e) => logEvent('quick', e.message, chatId, 'error')), 2500);
    }
  }

  const delay = (delaySec ?? Number(getSetting('reply_delay_sec') || 15)) * 1000;
  clearTimeout(timers.get(chatId));
  timers.set(chatId, setTimeout(() => {
    timers.delete(chatId);
    processChat(chatId).catch((e) => logEvent('agent', e.message, chatId, 'error'));
  }, delay));
}

function canAnswerChat(chat) {
  if (chat.chat_type === 'u2u' && getSetting('answer_personal') !== '1') return false;
  return true;
}

async function sendAndStore(chatId, text, source) {
  text = String(text).slice(0, 1000);
  pendingOut.set(text, { source, ts: Date.now() });
  for (const [k, v] of pendingOut) if (Date.now() - v.ts > 10 * 60_000) pendingOut.delete(k);
  const res = await avito.sendMessage(chatId, text);
  const id = res.id || `local-${Date.now()}`;
  insertMsgStmt.run(id, chatId, Number(getSetting('avito_user_id')) || null, 'out', 'text', text, null, res.created || now(), source);
  refreshChatSummary(chatId);
  return res;
}

function findTemplate(chatId, msg) {
  const templates = db.prepare('SELECT * FROM templates WHERE enabled = 1').all();
  const flow = msg.flow_id || '';
  for (const t of templates) {
    const flowOk = t.flow_id && flow && t.flow_id.trim() === flow;
    const textOk = t.match_text && (msg.text || '').toLowerCase().includes(t.match_text.trim().toLowerCase());
    if (!flowOk && !textOk) continue;
    const used = db.prepare('SELECT 1 FROM template_log WHERE chat_id = ? AND template_id = ?').get(chatId, t.id);
    if (!used) return t;
  }
  return null;
}

/** Решить, отвечать ли в чате, и ответить. opts.force — ответить сейчас, игнорируя паузы. */
async function processChat(chatId, opts = {}) {
  if (processing.has(chatId)) return { skipped: 'уже обрабатывается' };
  processing.add(chatId);
  try {
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!chat) return { skipped: 'чат не найден' };
    if (!opts.force) {
      if (getSetting('ai_enabled') !== '1') return { skipped: 'ИИ выключен глобально' };
      if (!chat.ai_enabled) return { skipped: 'ИИ выключен в чате' };
      if (chat.status === 'manager') return { skipped: 'чат передан менеджеру' };
      if (!canAnswerChat(chat)) return { skipped: 'личный чат — ответы выключены' };
    }

    const history = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created ASC, rowid ASC').all(chatId);
    const last = history[history.length - 1];
    if (!last) return { skipped: 'нет сообщений' };
    if (last.direction === 'out' && !opts.force) return { skipped: 'последнее сообщение уже наше' };

    if (!opts.force) {
      const maxAgeMin = Number(getSetting('only_new_messages_min') || 30);
      if (now() - last.created > maxAgeMin * 60) return { skipped: 'сообщение слишком старое' };
      const startedAt = Number(getSetting('ai_started_at') || 0);
      if (last.created < startedAt) return { skipped: 'сообщение пришло до включения ИИ' };
    }

    // системное сообщение Авито → только шаблон
    if (last.source === 'system') {
      const t = findTemplate(chatId, last);
      if (!t) return { skipped: 'системное сообщение без шаблона' };
      await sendAndStore(chatId, t.reply, 'template');
      db.prepare('INSERT OR IGNORE INTO template_log(chat_id, template_id) VALUES(?,?)').run(chatId, t.id);
      db.prepare('UPDATE templates SET hits = hits + 1 WHERE id = ?').run(t.id);
      logEvent('template', `Ответ по шаблону #${t.id}`, chatId);
      return { sent: t.reply, template: t.id };
    }

    const maxReplies = Number(getSetting('max_bot_replies') || 15);
    if (!opts.force && chat.bot_replies >= maxReplies) {
      logEvent('agent', `Достигнут лимит ответов бота (${maxReplies})`, chatId, 'warn');
      return { skipped: 'лимит ответов бота' };
    }

    const result = await agent.generateReply({
      item: chat.item_title ? { title: chat.item_title, price: chat.item_price, url: chat.item_url } : null,
      phone: chat.phone,
      history,
    });

    if (result.phone && !chat.phone) markLead(chatId, result.phone, 'распознал агент');

    if (result.skip || !result.reply) {
      db.prepare('UPDATE chats SET needs_reply = 0 WHERE id = ?').run(chatId);
      logEvent('agent', 'Агент решил не отвечать', chatId);
      return { skipped: 'агент решил не отвечать' };
    }

    // если за время генерации клиент написал ещё — перегенерируем позже
    const newer = db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND created > ? AND direction = 'in'").get(chatId, last.created);
    if (newer && !opts.force) {
      processing.delete(chatId);
      scheduleReply(chatId, 3);
      return { skipped: 'пришло новое сообщение, ответ пересобирается' };
    }

    await sendAndStore(chatId, result.reply, 'bot');
    db.prepare("UPDATE chats SET bot_replies = bot_replies + 1, status = CASE WHEN status = 'new' THEN 'active' ELSE status END WHERE id = ?").run(chatId);
    try { await avito.markRead(chatId); } catch { /* не критично */ }

    if (result.handoff) {
      db.prepare("UPDATE chats SET status = 'manager' WHERE id = ?").run(chatId);
      logEvent('handoff', 'Агент передал диалог менеджеру', chatId);
      notify(`🙋 Клиенту нужен менеджер\n${chat.client_name || 'Клиент'} · ${chat.item_title || 'личный чат'}\nhttps://www.avito.ru/profile/messenger/channel/${chatId}`);
    }
    logEvent('agent', `Ответ отправлен (${result.model}, ${result.usage?.total_tokens || '?'} ток.)`, chatId);
    return { sent: result.reply, phone: result.phone, handoff: result.handoff };
  } finally {
    processing.delete(chatId);
  }
}

function enableAI(on) {
  setSetting('ai_enabled', on ? '1' : '0');
  if (on) setSetting('ai_started_at', String(now()));
  logEvent('ai', on ? 'ИИ включён' : 'ИИ выключен');
}

module.exports = {
  pollOnce, startPolling, syncChat, processChat, scheduleReply, sendAndStore, markLead, notify, enableAI,
  getLastPoll: () => lastPoll,
};
