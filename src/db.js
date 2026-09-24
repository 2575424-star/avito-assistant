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

CREATE TABLE IF NOT EXISTS items (
  key TEXT PRIMARY KEY,         -- avito_id строкой или 'feed:<Id из фида>'
  avito_id INTEGER,
  ad_id TEXT,                   -- Id объявления в фиде автозагрузки
  title TEXT,
  price INTEGER,
  url TEXT,
  status TEXT,
  address TEXT,
  category TEXT,
  vin TEXT,
  year TEXT,
  mileage TEXT,
  description TEXT,
  params TEXT,                  -- JSON: все поля из фида
  source TEXT,                  -- api / feed / api+feed
  updated INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_avito ON items(avito_id);

CREATE TABLE IF NOT EXISTS kb (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,       -- faq / company / rules / objections / example
  title TEXT,
  content TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  source TEXT,                  -- manual / analysis / correction
  created INTEGER,
  updated INTEGER
);

-- ответы, которые агент сгенерировал, но НЕ отправил: теневой режим и прогон по реальным чатам
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  kind TEXT,                    -- shadow (на живое сообщение) / replay (прогон по истории)
  at_message_id TEXT,           -- последнее сообщение клиента, на которое отвечал агент
  at_created INTEGER,
  client_text TEXT,
  reply TEXT,
  phone TEXT,
  handoff INTEGER,
  skip INTEGER,
  rating INTEGER,               -- 1 хорошо / -1 плохо / NULL не оценено
  correction TEXT,
  comment TEXT,
  model TEXT,
  tokens INTEGER,
  batch TEXT,
  created INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_chat ON agent_runs(chat_id, at_created);

-- разбор переписок менеджеров нейросетью
CREATE TABLE IF NOT EXISTS chat_reviews (
  chat_id TEXT PRIMARY KEY,
  score INTEGER,
  outcome TEXT,
  result TEXT,                  -- JSON
  model TEXT,
  tokens INTEGER,
  created INTEGER
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  n_chats INTEGER,
  result TEXT,                  -- JSON
  model TEXT,
  created INTEGER
);

-- версии агента: общая инструкция + стратегия; использованная версия не меняется, правка = новая версия
CREATE TABLE IF NOT EXISTS agent_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,            -- A_direct / B_consultative / C_adaptive / …
  version TEXT NOT NULL,        -- v0.2.0
  title TEXT,
  base_prompt TEXT NOT NULL,
  strategy TEXT,
  model TEXT,                   -- пусто — модель выбирается при прогоне
  temperature REAL,
  status TEXT DEFAULT 'active', -- active / archived
  created INTEGER,
  UNIQUE(key, version)
);

-- полный текст промпта каждого ответа, по хэшу (для воспроизводимости)
CREATE TABLE IF NOT EXISTS prompt_snapshots (
  hash TEXT PRIMARY KEY,
  text TEXT,
  created INTEGER
);

-- фактические целевые действия Авито (списания): чаты и звонки
CREATE TABLE IF NOT EXISTS cpa_actions (
  id TEXT PRIMARY KEY,          -- 'chat:<actionId>' / 'call:<id>'
  kind TEXT,                    -- chat / call
  chat_id TEXT,                 -- channelId для чатов
  message_id TEXT,              -- сообщение, на котором сработало целевое действие
  message TEXT,
  contact_type TEXT,            -- phone / email / nick / other
  target_type TEXT,             -- Контакты / Сделка / Переключения
  price INTEGER,                -- в копейках
  status TEXT,
  arbitrage INTEGER,            -- можно опротестовать
  buyer_id INTEGER,
  buyer_phone TEXT,             -- для звонков
  item_id INTEGER,
  item_title TEXT,
  duration INTEGER,             -- для звонков, сек
  created INTEGER,
  raw TEXT,
  synced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cpa_chat ON cpa_actions(chat_id);

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
  send_enabled: '0',          // 0 — тестовый режим: в Авито ничего не отправляется
  feed_url: '',               // XML-фид автозагрузки с автомобилями
  kb_budget_chars: '16000',   // сколько символов базы знаний класть в промпт
  analysis_model: '',         // модель для разбора чатов (пусто — как у агента)
  compare_models: '',
  compare_configs: '',        // JSON [{versionId, model}] — конфигурации для прогона
  live_agent_version_id: '',  // версия для черновиков на живые сообщения (пусто — правила из настроек)         // модели для сравнения при прогоне: через запятую; openrouter:… — через OpenRouter
  openrouter_api_key: '',
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

// миграции для баз, созданных до появления колонок
for (const [table, col, def] of [['chats', 'history_loaded', 'INTEGER DEFAULT 0'], ['agent_runs', 'ms', 'INTEGER'], ['agent_runs', 'agent_version_id', 'INTEGER'], ['agent_runs', 'prompt_hash', 'TEXT'],
  ['items', 'availability', 'TEXT'], ['kb', 'status', "TEXT DEFAULT 'approved'"], ['items', 'availability_src', 'TEXT'], ['items', 'availability_manual', 'TEXT']]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

// стратегии v0.2.0 из docs/agent-prompt-v0.2.0.md
{
  const { BASE_V020, STRATEGIES_V020 } = require('./strategies');
  const ins = db.prepare('INSERT OR IGNORE INTO agent_versions(key, version, title, base_prompt, strategy, status, created) VALUES(?,?,?,?,?,?,?)');
  for (const x of STRATEGIES_V020) ins.run(x.key, 'v0.2.0', x.title, BASE_V020, x.strategy, 'active', Math.floor(Date.now() / 1000));
}

if (!getSetting('webhook_secret')) {
  setSetting('webhook_secret', require('node:crypto').randomBytes(12).toString('hex'));
}

module.exports = { db, getSetting, setSetting, allSettings, logEvent, DEFAULTS };
