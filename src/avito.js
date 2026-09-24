// Клиент Avito API (Messenger). Документация: https://developers.avito.ru/api-catalog/messenger/documentation
const { getSetting, setSetting, logEvent } = require('./db');

const BASE = process.env.AVITO_API_BASE || 'https://api.avito.ru';

let tokenCache = { token: null, expiresAt: 0, key: '' };

class AvitoError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function credentials() {
  return {
    clientId: getSetting('avito_client_id'),
    clientSecret: getSetting('avito_client_secret'),
  };
}

function isConfigured() {
  const { clientId, clientSecret } = credentials();
  return Boolean(clientId && clientSecret);
}

async function getToken(force = false) {
  const { clientId, clientSecret } = credentials();
  if (!clientId || !clientSecret) throw new AvitoError('Не заданы client_id / client_secret Авито', 0);
  const key = clientId + ':' + clientSecret;
  if (!force && tokenCache.token && tokenCache.key === key && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  const res = await fetch(BASE + '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new AvitoError('Авито не выдал токен: ' + (data.error_description || data.error || res.status), res.status, data);
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 86400) * 1000,
    key,
  };
  setSetting('avito_token_expires', String(Math.floor(tokenCache.expiresAt / 1000)));
  return tokenCache.token;
}

function tokenInfo() {
  return { hasToken: Boolean(tokenCache.token), expiresAt: tokenCache.expiresAt ? Math.floor(tokenCache.expiresAt / 1000) : null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(res, attempt) {
  const h = Number(res.headers.get('retry-after') || res.headers.get('x-ratelimit-retry-after'));
  if (h > 0) return Math.min(h, 60) * 1000;
  return Math.min(2000 * 2 ** attempt, 30_000);
}

async function request(method, path, { query, json, attempt = 0 } = {}) {
  const token = await getToken();
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: json ? JSON.stringify(json) : undefined,
  });
  if (res.status === 401 && attempt === 0) {
    await getToken(true);
    return request(method, path, { query, json, attempt: 1 });
  }
  // лимит запросов и сбои Авито: ждём (по Retry-After, если есть) и повторяем, не больше 3 раз.
  // POST при 5xx не повторяем: сообщение могло уже уйти, повтор отправил бы его дважды.
  if ((res.status === 429 || (res.status >= 500 && method === 'GET')) && attempt < 3) {
    await sleep(retryDelayMs(res, attempt));
    return request(method, path, { query, json, attempt: attempt + 1 });
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.error?.message || data.message || data.error)) || text || res.statusText;
    throw new AvitoError(`Avito ${method} ${path} → ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status, data);
  }
  return data;
}

// Тестовый режим: всё, что меняет что-то в Авито (отправка, «прочитано»), запрещено.
function sendingEnabled() {
  return getSetting('send_enabled') === '1';
}
function assertSending(what) {
  if (!sendingEnabled()) throw new AvitoError(`Тестовый режим: ${what} в Авито выключено (Настройки → Агент → «Боевой режим»)`, 0);
}

async function getSelf() {
  return request('GET', '/core/v1/accounts/self');
}

async function userId() {
  let id = getSetting('avito_user_id');
  if (!id) {
    const me = await getSelf();
    id = String(me.id);
    setSetting('avito_user_id', id);
    if (me.name) setSetting('avito_profile_name', me.name);
    logEvent('avito', `Подключён профиль ${me.name || ''} (id ${id})`);
  }
  return id;
}

async function getChats({ limit = 100, offset = 0, unreadOnly = false, chatTypes = 'u2i,u2u', itemIds } = {}) {
  const uid = await userId();
  const data = await request('GET', `/messenger/v2/accounts/${uid}/chats`, {
    query: { limit, offset, unread_only: unreadOnly ? 'true' : undefined, chat_types: chatTypes, item_ids: itemIds },
  });
  return data.chats || [];
}

async function getChat(chatId) {
  const uid = await userId();
  return request('GET', `/messenger/v2/accounts/${uid}/chats/${encodeURIComponent(chatId)}`);
}

async function getMessages(chatId, { limit = 100, offset = 0 } = {}) {
  const uid = await userId();
  const data = await request('GET', `/messenger/v3/accounts/${uid}/chats/${encodeURIComponent(chatId)}/messages/`, {
    query: { limit, offset },
  });
  return Array.isArray(data) ? data : data.messages || [];
}

async function sendMessage(chatId, text) {
  assertSending('отправка сообщений');
  const uid = await userId();
  return request('POST', `/messenger/v1/accounts/${uid}/chats/${encodeURIComponent(chatId)}/messages`, {
    json: { message: { text: String(text).slice(0, 1000) }, type: 'text' },
  });
}

async function markRead(chatId) {
  assertSending('отметка «прочитано»');
  const uid = await userId();
  return request('POST', `/messenger/v1/accounts/${uid}/chats/${encodeURIComponent(chatId)}/read`);
}

async function subscribeWebhook(url) {
  return request('POST', '/messenger/v3/webhook', { json: { url } });
}

async function unsubscribeWebhook(url) {
  return request('POST', '/messenger/v1/webhook/unsubscribe', { json: { url } });
}

async function listSubscriptions() {
  return request('POST', '/messenger/v1/subscriptions');
}

// ---------- Объявления и автозагрузка (для базы знаний) ----------

/** Все объявления кабинета: GET /core/v1/items (постранично). */
async function getItems({ statuses = 'active,old,removed,blocked,rejected', perPage = 50, maxPages = 200 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await request('GET', '/core/v1/items', { query: { per_page: perPage, page, status: statuses } });
    const list = data.resources || [];
    out.push(...list);
    if (list.length < perPage) break;
    await sleep(150);
  }
  return out;
}

/** Профиль автозагрузки: там URL XML-фида с автомобилями. */
async function getAutoloadProfile() {
  return request('GET', '/autoload/v2/profile');
}

/** Сопоставить Id из фида с ID объявлений на Авито. */
async function avitoIdsByAdIds(adIds) {
  const out = {};
  for (let i = 0; i < adIds.length; i += 50) {
    const chunk = adIds.slice(i, i + 50);
    const data = await request('GET', '/autoload/v2/items/avito_ids', { query: { query: chunk.join(',') } });
    for (const it of data.items || []) if (it.avito_id) out[it.ad_id] = it.avito_id;
    await sleep(150);
  }
  return out;
}

function resetCache() {
  tokenCache = { token: null, expiresAt: 0, key: '' };
}

module.exports = {
  AvitoError, isConfigured, getToken, tokenInfo, getSelf, userId, getChats, getChat, getMessages,
  sendMessage, markRead, subscribeWebhook, unsubscribeWebhook, listSubscriptions, resetCache,
  getItems, getAutoloadProfile, avitoIdsByAdIds, sendingEnabled,
};
