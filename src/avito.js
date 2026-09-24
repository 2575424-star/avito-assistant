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

async function request(method, path, { query, json, retry = true } = {}) {
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
  if (res.status === 401 && retry) {
    await getToken(true);
    return request(method, path, { query, json, retry: false });
  }
  if (res.status === 429 && retry) {
    await new Promise((r) => setTimeout(r, 2000));
    return request(method, path, { query, json, retry: false });
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

async function getChats({ limit = 100, offset = 0, unreadOnly = false, chatTypes = 'u2i,u2u' } = {}) {
  const uid = await userId();
  const data = await request('GET', `/messenger/v2/accounts/${uid}/chats`, {
    query: { limit, offset, unread_only: unreadOnly ? 'true' : undefined, chat_types: chatTypes },
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
  const uid = await userId();
  return request('POST', `/messenger/v1/accounts/${uid}/chats/${encodeURIComponent(chatId)}/messages`, {
    json: { message: { text: String(text).slice(0, 1000) }, type: 'text' },
  });
}

async function markRead(chatId) {
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

function resetCache() {
  tokenCache = { token: null, expiresAt: 0, key: '' };
}

module.exports = {
  AvitoError, isConfigured, getToken, tokenInfo, getSelf, userId, getChats, getChat, getMessages,
  sendMessage, markRead, subscribeWebhook, unsubscribeWebhook, listSubscriptions, resetCache,
};
