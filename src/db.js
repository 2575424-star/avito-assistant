const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'assistant.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  chat_type TEXT,               -- u2i (по объявлению) / u2u (личный)
  item_id INTEGER,
  item_title TEXT,
  item_price TEXT,
  item_url TEXT,
  item_image TEXT,
  client_id INTEGER,
  client_name TEXT,
  created INTEGER,
  updated INTEGER,
  last_text TEXT,
  last_direction TEXT,
  last_at INTEGER,
  ai_enabled INTEGER DEFAULT 1,
  status TEXT DEFAULT 'new',     -- new / active / lead / manager
  phone TEXT,
  lead_at INTEGER,
  lead_channel TEXT,
  quick_sent INTEGER DEFAULT 0,
  bot_replies INTEGER DEFAULT 0,
  needs_reply INTEGER DEFAULT 0,
  synced_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  author_id INTEGER,
  direction TEXT,               -- in / out
  type TEXT,
  text TEXT,
  flow_id TEXT,
  created INTEGER,
  source TEXT                   -- client / bot / manager / system / quick / template
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id TEXT,
  match_text TEXT,
  reply TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  hits INTEGER DEFAULT 0,
  created INTEGER
);

CREATE TABLE IF NOT EXISTS template_log (
  chat_id TEXT,
  template_id INTEGER,
  PRIMARY KEY (chat_id, template_id)
);

CREATE TABLE IF NOT EXISTS system_seen (
  flow_id TEXT PRIMARY KEY,
  sample TEXT,
  hits INTEGER DEFAULT 0,
  last_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  level TEXT,
  type TEXT,
  chat_id TEXT,
  text TEXT
);
`);

const DEFAULTS = {
  ai_enabled: '0',
  ai_started_at: '',
  assistant_name: 'Сергей',
  company_info: '',
  rules: `Ты — консультант автосалона на Авито. Отвечай коротко (1–3 предложения), вежливо, по-человечески, без канцелярита и без эмодзи.
Главная цель — получить номер телефона клиента, чтобы менеджер перезвонил с расчётом и условиями.
Не выдумывай цены, скидки, комплектации и наличие — если данных нет, скажи, что менеджер уточнит и перезвонит.
Не обещай конкретных условий кредита, трейд-ина и скидок.
Если клиент оставил номер — поблагодари и скажи, что менеджер свяжется в ближайшее время.
Если клиент отказывается давать телефон — предложи продолжить в чате и ответь на вопрос.`,
  openai_model: 'gpt-4o-mini',
  temperature: '0.5',
  reply_delay_sec: '15',
  max_bot_replies: '15',
  answer_personal: '0',
  answer_closed_items: '1',
  only_new_messages_min: '30',
  quick_reply_enabled: '0',
  quick_reply_text: '',
  avito_client_id: '',
  avito_client_secret: '',
  avito_user_id: '',
  avito_profile_name: '',
  openai_api_key: '',
  tg_bot_token: '',
  tg_chat_id: '',
  webhook_secret: '',
  poll_interval_sec: '30',
  pause_on_manager: '1',
};

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function getSetting(key) {
  const row = getStmt.get(key);
  if (row && row.value !== null && row.value !== '') return row.value;
  const envKey = key.toUpperCase();
  if (process.env[envKey]) return process.env[envKey];
  return DEFAULTS[key] ?? '';
}

function setSetting(key, value) {
  setStmt.run(key, value == null ? '' : String(value));
}

function allSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = getSetting(k);
  return out;
}

function logEvent(type, text, chatId = null, level = 'info') {
  try {
    db.prepare('INSERT INTO events(ts, level, type, chat_id, text) VALUES(?,?,?,?,?)')
      .run(Math.floor(Date.now() / 1000), level, type, chatId, String(text).slice(0, 2000));
    db.prepare('DELETE FROM events WHERE id < (SELECT MAX(id) - 5000 FROM events)').run();
  } catch (e) { /* ignore */ }
  const line = `[${level}] ${type}${chatId ? ' ' + chatId : ''}: ${text}`;
  level === 'error' ? console.error(line) : console.log(line);
}

if (!getSetting('webhook_secret')) {
  setSetting('webhook_secret', require('node:crypto').randomBytes(12).toString('hex'));
}

module.exports = { db, getSetting, setSetting, allSettings, logEvent, DEFAULTS };
