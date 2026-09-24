# HANDOFF: Avito Assistant (ИИ-ассистент для чатов Авито)

Документ для разработчика, который подключается к проекту без контекста переписки.
Дата: 24.09.2026. Заказчик и владелец: Павел (GitHub `2575424-star`, часовой пояс Москва).

> В документе нет ключей, паролей и токенов. Все секреты хранятся только в переменных Railway или вводятся в интерфейсе приложения.

---

## 1. Цель проекта и что должен уметь ассистент

**Цель.** Собственный ИИ-ассистент, который ведёт переписку с покупателями в мессенджере Авито от имени продавца (в первую очередь это автодилер, кабинет «Платон Авто новые автомобили», Воронеж). Главная бизнес-метрика: **успешный чат**, то есть клиент оставил номер телефона. Лид передаётся менеджеру.

Проект развивается **отдельным направлением**. Позже его, возможно, встроят в CRM Павла **VECTOR-CRM** (репозиторий `github.com/2575424-star/VECTOR-CRM`, отдельный проект на Railway «VECTOR CRM»). Пока интеграции нет.

**Образец.** Готовый сервис «ИИ Диалоги» (crm.dialogiai.ru), к которому у Павла есть доступ. Мы изучили его интерфейс и взяли за основу. Что там есть:
- аккаунт = кабинет Авито; глобальный переключатель AI с датой запуска;
- вкладки аккаунта: **Дашборд**, **Чаты**, **Успешные чаты**, **Карточки**, **Настройки**;
- Дашборд: статусы (подключён / токен активен / AI включён / число карточек), «Успешные чаты» за период с разбивкой по каналам (входящие, рассылка скидки, напоминания) и конверсией, график динамики, сравнение с 30 днями до запуска ИИ;
- Чаты: список с поиском и фильтрами (AI вкл, AI выкл, Контакт, Без контакта, Бот не ответил, Хочет общаться в чате), переписка, AI-тумблер на каждый чат, ручной ответ, ссылки на Авито и объявление;
- Успешные чаты: таблица (имя, объявление, тип: входящий или рассылка, дата контакта, телефон, «В чат», «Авито»), фильтр дат, экспорт;
- Карточки: объявления из XML-фида, AI-тумблер на каждое, VIN, ID, дата обновления;
- Настройки → «Настройки AI»: имя консультанта, Seller ID, XML-фид, лимит переключений, информация о компании (кнопка «Подтянуть»), отвечать в личных чатах, отвечать по снятым объявлениям, быстрый ответ (через 2–3 с, один раз на чат, ИИ его не видит), тематики объявлений, уведомления при запросе Автотеки и при ссылке от клиента, напоминания;
- Настройки → «Шаблоны»: ответы на системные сообщения Авито по `flow_id` (`flower_generic_lead_signal`, `two_way_chats`, `sbc_seller_notification`) с модерацией;
- Настройки → «Интеграции»: уведомления в Telegram, MAX или на почту по событиям (клиент оставил контакт, диалог передан менеджеру, клиент не даёт телефон и т. п.), передача лида в Битрикс24, Calltouch, AutoCRM, Rivendell, обмен с 1С, API лидов, Автотека;
- Настройки → «Авито»: OAuth-подключение, токен, ID продавца.

**Что должен уметь наш ассистент (цель):**
1. Подключаться к кабинету Авито по API и собирать все чаты и сообщения.
2. Автоматически отвечать покупателям через LLM по настраиваемым правилам, учитывая объявление, по которому пишет клиент.
3. Вести к цели: получить телефон клиента; распознавать номер, фиксировать лид, уведомлять менеджера.
4. Передавать диалог менеджеру (по запросу клиента, по решению агента, при ручном ответе менеджера).
5. Показывать статистику и конверсию (дашборд), список лидов с экспортом.
6. Давать безопасно отлаживать правила ответа (песочница без отправки в Авито).
7. На следующих этапах: карточки из XML-фида (база знаний по авто), рассылки, напоминания, интеграции с CRM, мультиаккаунт.

---

## 2. Принятые решения и договорённости

### Архитектура
- Один сервис на **Node.js 22** без внешних npm-зависимостей: встроенные `node:http`, `node:sqlite`, `fetch`. Причина: из среды разработки npm-реестр был закрыт, а без зависимостей проще и надёжнее деплой. Добавить зависимости теперь можно (например, Express или Postgres-драйвер), но тогда нужен `package-lock.json` и `npm ci` в Dockerfile.
- **База данных:** SQLite (`node:sqlite`, режим WAL) в файле `$DATA_DIR/assistant.db`. На Railway это том (volume), смонтированный в `/data`.
- **Фронтенд:** SPA на чистом JS без сборки (`public/`), hash-роутинг, светлая и тёмная тема по `prefers-color-scheme`. Отдаётся тем же сервером.
- **Фоновые процессы в том же процессе:** периодический опрос Авито (по умолчанию 30 с), обработчик вебхука, таймеры отложенного ответа на каждый чат.
- **Авторизация в интерфейсе:** один пароль из переменной `ADMIN_PASSWORD`, cookie `sid` = HMAC-SHA256(пароль). Если переменная не задана, интерфейс открыт (только для локальной разработки).
- **Хостинг:** Railway (решение Павла). Сборка по `Dockerfile` (`node:22-slim`).

### Технологии и LLM
- LLM: **OpenAI**, так как у Павла уже есть ключ. Chat Completions API, `response_format: json_object`.
- Модель по умолчанию `gpt-4o-mini`, меняется в интерфейсе. Для моделей `o*` и `gpt-5*` temperature не передаётся.
- Базовый адрес OpenAI переопределяется через `OPENAI_BASE_URL` (использовалось для моков в тестах).

### Подключение к Авито
- **Авторизация:** OAuth2 `client_credentials`: `POST https://api.avito.ru/token` (form: `grant_type`, `client_id`, `client_secret`). Токен кешируется в памяти, при 401 обновляется. `client_id` и `client_secret` Павел вводит сам в интерфейсе (Настройки → Авито) или задаёт переменными `AVITO_CLIENT_ID` / `AVITO_CLIENT_SECRET`.
- **Эндпоинты** (сверены с OpenAPI-спецификацией Авито из репозитория `github.com/MissiaL/avito-api`, файл `references/avito-api-openapi.json`):
  - `GET /core/v1/accounts/self`: ID и имя профиля (ID кешируется в настройке `avito_user_id`);
  - `GET /messenger/v2/accounts/{user_id}/chats?limit&offset&chat_types=u2i,u2u`: список чатов;
  - `GET /messenger/v2/accounts/{user_id}/chats/{chat_id}`: один чат;
  - `GET /messenger/v3/accounts/{user_id}/chats/{chat_id}/messages/?limit&offset`: сообщения (по спецификации это массив; код принимает и `{messages:[...]}`);
  - `POST /messenger/v1/accounts/{user_id}/chats/{chat_id}/messages` `{message:{text}, type:"text"}`: отправка (не длиннее 1000 символов);
  - `POST /messenger/v1/accounts/{user_id}/chats/{chat_id}/read`: прочитать чат;
  - `POST /messenger/v3/webhook` `{url}`: подписка на вебхук; `POST /messenger/v1/webhook/unsubscribe`: отписка;
  - системные сообщения чат-ботов Авито: `type = "system"`, в `content.flow_id` указан бот (`seller_audience_discount`, `sbc_seller_notification`, `flower_161071` и др.).
- **Ограничение Авито:** Messenger API в категории «Товары» доступен только на тарифе **«Максимальный»**. Работать нужно с ключом основного (компанийного) аккаунта, а не сотрудника.
- **Получение сообщений:** всегда работает опрос. Вебхук (`/webhook/avito/{webhook_secret}`) ускоряет реакцию: на событие сервис сразу синхронизирует этот чат. Подпись вебхука (`x-avito-messenger-signature`) пока **не проверяется**, защита только через секрет в URL.

### База знаний (что агент знает)
Сейчас в промпт агента передаются:
1. **Правила ответа.** Редактируемый промпт (настройка `rules`), по умолчанию это консультант автосалона: коротко, вежливо, цель — телефон, не выдумывать цены, скидки и наличие, не обещать условия кредита и трейд-ина.
2. **Информация о компании.** Свободный текст (настройка `company_info`): адрес, часы, условия.
3. **Данные объявления из контекста чата:** название, цена, ссылка (из `chat.context.value`).
4. **История переписки:** последние 40 сообщений; системные помечаются префиксом `[Системное сообщение Авито]`.
5. Флаги: телефон уже получен (не просить повторно); уже здоровались (не здороваться снова).

XML-фид с карточками (VIN, комплектации, наличие) **пока не подключён**, см. раздел 4.

### Правила ответа (логика движка)
- Бот отвечает, только если: глобально включён AI; в чате включён AI; чат не у менеджера; последнее сообщение от клиента или системное; сообщение пришло **после включения AI** (`ai_started_at`) и не старше `only_new_messages_min` (по умолчанию 30 мин). На старые чаты бот не отвечает.
- **Задержка** `reply_delay_sec` (по умолчанию 15 с) с дебаунсом: если клиент дописывает, таймер перезапускается. Если за время генерации пришло новое сообщение, ответ пересобирается.
- **Лимит** ответов бота на чат: `max_bot_replies` (по умолчанию 15).
- **Личные чаты** (`u2u`, не по объявлению) по умолчанию без ответа (`answer_personal=0`).
- **Быстрый ответ** (опционально): фиксированный текст через 2,5 с после первого сообщения клиента, один раз на чат. В отличие от образца, ИИ этот текст **видит** в истории, чтобы не здороваться повторно.
- **Системные сообщения Авито:** ИИ на них не отвечает, срабатывает только **шаблон** (совпадение по `flow_id` или по фразе в тексте), один раз на чат. Все встреченные `flow_id` пишутся в таблицу `system_seen`, из интерфейса по ним создаются шаблоны.
- Ответ LLM приходит как JSON: `{reply, phone, handoff, skip}`. `skip=true` означает промолчать (клиент попрощался).

### Сбор контактов
- Телефон ищется регулярным выражением в **каждом новом сообщении клиента** (даже при выключенном AI) и нормализуется в формат `+79XXXXXXXXX` (только мобильные РФ).
- Номер, который вернула модель, принимается, только если его цифры есть в тексте клиента (защита от выдуманных номеров).
- Номер найден → у чата заполняются `phone`, `lead_at`, `lead_channel` (Входящий / Исходящий по первому сообщению в чате), статус `lead`. Уходит уведомление в Telegram (если заданы бот и chat_id). Чат появляется в «Успешных чатах», есть экспорт в CSV (UTF-8 с BOM, разделитель `;`).

### Передача менеджеру
- Агент вернул `handoff=true` → ответ отправляется, статус чата становится `manager`, бот в чате замолкает, уходит уведомление в Telegram.
- Менеджер ответил вручную (из нашего интерфейса или прямо в Авито) после включения AI → чат переходит в `manager` (настройка `pause_on_manager`, по умолчанию включена). Собственные сообщения бота не принимаются за ответ менеджера: тексты, отправленные через API, помнятся 5 минут (`pendingOut`).
- Кнопка «Вернуть боту» в чате снимает статус `manager`.

### Деплой на Railway (уже создано)
- Проект **«Avito Assistant»** (workspace `2575424-star's Projects`), окружение `production`.
  - projectId `163dfe40-5366-4a56-9792-6bc3a7a5413d`, environmentId `2dc1bace-5c49-408d-b11d-47c6ee0bf80b`
  - сервис `avito-assistant`, serviceId `194e731d-622f-4a4b-be00-a51b888b51e0`
  - том `avito-data`, смонтирован в `/data`
  - домен `https://avito-assistant-production.up.railway.app` (порт 3000)
  - заданы переменные `ADMIN_PASSWORD` (значение у Павла), `DATA_DIR=/data`, `PORT=3000`
- **Источник у сервиса ещё не подключён**, деплоя не было. Нужно подключить GitHub-репозиторий (см. раздел 4).
- GitHub: создан пустой **публичный** репозиторий `2575424-star/avito-assistant`, код в него **ещё не запушен**. Код лежит у Павла на Mac в `~/avito-assistant` (там же служебный `transfer.html`, его нужно удалить, в git он не нужен).

---

## 3. Что уже сделано

Готова и проверена локально версия **v0.1** (end-to-end с моками Авито и OpenAI):
- синхронизация чатов и сообщений, классификация сообщений (клиент / бот / менеджер / системное / быстрый ответ / шаблон);
- автоответ через OpenAI с задержкой, лимитами и правилами выше; распознавание телефона → лид; шаблон на системное сообщение; бот не ставит сам себя на паузу;
- интерфейс: Дашборд, Чаты (поиск, фильтры, переписка, AI-тумблер на чат, ручной ответ, «Ответить ИИ», синхронизация чата, ссылки на Авито и объявление), Успешные чаты (фильтр дат, CSV), Настройки (Агент, Шаблоны, Тест агента, Авито, Уведомления, Журнал), экран входа, адаптив под телефон;
- песочница «Тест агента»: диалог с агентом по текущим правилам без отправки в Авито, с тестовым объявлением и просмотром итогового промпта;
- Dockerfile и README.

**На реальных ключах Авито и OpenAI ещё не проверялось.**

### Структура

```
avito-assistant/
├── .gitignore
├── Dockerfile
├── README.md
├── package.json
├── public/            # фронтенд (SPA без сборки)
│   ├── index.html
│   ├── style.css
│   └── app.js
└── src/               # бэкенд
    ├── server.js      # HTTP-сервер, REST API, авторизация, вебхук, статика
    ├── db.js          # схема SQLite, настройки (БД → env → дефолт), журнал событий
    ├── avito.js       # клиент Avito API
    ├── agent.js       # промпт, вызов OpenAI, извлечение телефона
    └── engine.js      # синхронизация, классификация, автоответ, лиды, уведомления
```

### Настройки
Хранятся в таблице `settings`. Порядок чтения: значение в БД → переменная окружения с тем же именем в верхнем регистре → значение по умолчанию. Список ключей и значения по умолчанию: объект `DEFAULTS` в `src/db.js`. Секретные поля (`avito_client_secret`, `openai_api_key`, `tg_bot_token`) API отдаёт в интерфейс замаскированными.

### REST API (все эндпоинты, кроме login/me/health/webhook, требуют cookie)
| Метод | Путь | Назначение |
|---|---|---|
| POST | `/api/login`, `/api/logout` · GET `/api/me` | авторизация |
| GET | `/api/status` | состояние подключений, AI, последняя синхронизация, адрес вебхука |
| GET | `/api/dashboard?from&to` | метрики и данные по дням |
| POST | `/api/ai` `{enabled}` | глобальный AI (при включении пишет `ai_started_at`) |
| GET | `/api/chats?filter&q&limit&offset` | список чатов (`filter`: ai_on, ai_off, contact, no_contact, waiting, manager) |
| GET | `/api/chats/:id` | чат, сообщения, события |
| POST | `/api/chats/:id/send` `{text}` | ответ менеджера (ставит чат в `manager`) |
| POST | `/api/chats/:id/ai` `{enabled}` · `/status` `{status, phone?}` · `/reply-now` · `/sync` | управление чатом |
| GET | `/api/leads?from&to`, `/api/leads.csv` | лиды |
| GET/POST | `/api/settings` | настройки |
| POST | `/api/avito/test`, `/api/sync` `{pages}`, `/api/webhook` `{enabled}` | Авито |
| GET/POST/DELETE | `/api/templates[/:id]` | шаблоны и встреченные системные сообщения |
| POST | `/api/sandbox` `{history, item}` | песочница |
| GET | `/api/events?limit` | журнал |
| POST | `/webhook/avito/:secret` | вебхук Авито |
| GET | `/health` | healthcheck |

### Переменные окружения
`ADMIN_PASSWORD`, `DATA_DIR`, `PORT`, `PUBLIC_URL` (на Railway вычисляется из `RAILWAY_PUBLIC_DOMAIN`), `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `AVITO_CLIENT_ID`, `AVITO_CLIENT_SECRET`, `AVITO_API_BASE`, а также любые ключи из `DEFAULTS` в верхнем регистре.

### Локальный запуск
```bash
ADMIN_PASSWORD=dev node --no-warnings src/server.js   # http://localhost:3000
# тесты с моками: AVITO_API_BASE=http://127.0.0.1:4000 OPENAI_BASE_URL=http://127.0.0.1:4000/v1
```
Автотестов в репозитории нет: проверка шла через временный мок-сервер (см. раздел 4).

### Код по файлам

Полное содержимое всех файлов проекта на момент передачи. Тот же код приложен архивом `avito-assistant.zip`.

#### 3.1 `package.json`

````json
{
  "name": "avito-assistant",
  "version": "0.1.0",
  "description": "AI-ассистент для чатов Авито",
  "main": "src/server.js",
  "scripts": {
    "start": "node --no-warnings src/server.js"
  },
  "engines": { "node": ">=22.13" }
}
````

#### 3.2 `Dockerfile`

````dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 3000
CMD ["node", "--no-warnings", "src/server.js"]
````

#### 3.3 `.gitignore`

````
node_modules
data
*.db
.env
````

#### 3.4 `README.md`

````markdown
# Авито Ассистент

ИИ-менеджер для чатов Авито: собирает переписки через Messenger API, отвечает покупателям по вашим правилам (OpenAI), вытаскивает телефоны и собирает «успешные чаты».

Без внешних зависимостей: Node.js 22+ (встроенные `http` и `node:sqlite`).

## Возможности

- **Дашборд** — входящие чаты, успешные (оставили телефон), конверсия, работа бота, график по дням.
- **Чаты** — список с поиском и фильтрами (AI вкл/выкл, контакт, без ответа, у менеджера), переписка, ручной ответ менеджера, переключатель AI в каждом чате, кнопка «Ответить ИИ».
- **Успешные чаты** — таблица лидов с телефоном, фильтр по датам, экспорт CSV.
- **Настройки**
  - *Агент* — имя, модель, правила ответа (промпт), информация о компании, задержка, лимит ответов, быстрый ответ, пауза при ответе менеджера, личные чаты.
  - *Шаблоны* — ответы на системные сообщения Авито (по `flow_id` или фразе).
  - *Тест агента* — песочница: переписка с агентом без отправки в Авито.
  - *Авито* — ключи, проверка, синхронизация, вебхук.
  - *Уведомления* — Telegram о новых контактах и передаче менеджеру.
  - *Журнал* — события и ошибки.

## Как работает

1. Каждые 30 сек (и мгновенно по вебхуку) сервис забирает обновлённые чаты и новые сообщения.
2. На новое сообщение клиента (пришедшее после включения AI) запускается таймер задержки — чтобы клиент успел дописать.
3. Агент получает правила + данные объявления + историю и отвечает JSON'ом: текст, телефон, нужен ли менеджер.
4. Телефон из сообщения клиента → чат попадает в «Успешные», уходит уведомление в Telegram.
5. Если менеджер ответил сам — бот в этом чате встаёт на паузу.

## Переменные окружения

| Переменная | Описание |
|---|---|
| `ADMIN_PASSWORD` | Пароль входа в интерфейс (обязательно на сервере) |
| `OPENAI_API_KEY` | Ключ OpenAI (можно указать в интерфейсе) |
| `AVITO_CLIENT_ID`, `AVITO_CLIENT_SECRET` | Ключи Авито (можно указать в интерфейсе) |
| `DATA_DIR` | Папка для базы SQLite (на Railway — `/data`, подключить Volume) |
| `PUBLIC_URL` | Публичный адрес (на Railway определяется сам) |

## Запуск локально

```bash
ADMIN_PASSWORD=secret npm start
# http://localhost:3000
```

## Деплой на Railway

1. Репозиторий на GitHub → New Service → GitHub Repo (собирается по `Dockerfile`).
2. Volume с mount path `/data`.
3. Переменные `ADMIN_PASSWORD`, `OPENAI_API_KEY`.
4. Settings → Networking → Generate Domain.
5. В интерфейсе: Настройки → Авито → ключи → «Проверить подключение» → «Синхронизировать чаты» → «Подключить вебхук» → включить AI.
````

#### 3.5 `src/server.js`

````javascript
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
````

#### 3.6 `src/db.js`

````javascript
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
````

#### 3.7 `src/avito.js`

````javascript
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
````

#### 3.8 `src/agent.js`

````javascript
// Агент: собирает промпт из правил + данных объявления + истории и получает ответ от OpenAI.
const { getSetting } = require('./db');

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

// ---------- Телефоны ----------
const PHONE_RE = /(?:\+?\s*[78])?[\s\-–(]*\d{3}[\s\-–)]*\d{3}[\s\-–]*\d{2}[\s\-–]*\d{2}/g;

function normalizePhone(raw) {
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 10 && d[0] === '9') d = '7' + d;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length !== 11 || d[0] !== '7' || d[1] !== '9') return null; // только мобильные РФ
  return '+' + d;
}

function extractPhone(text) {
  if (!text) return null;
  const matches = String(text).match(PHONE_RE) || [];
  for (const m of matches) {
    const p = normalizePhone(m);
    if (p) return p;
  }
  return null;
}

// ---------- Промпт ----------
function buildSystemPrompt(ctx = {}) {
  const name = getSetting('assistant_name') || 'Консультант';
  const rules = getSetting('rules');
  const company = getSetting('company_info');
  const parts = [];
  parts.push(`Тебя зовут ${name}. Ты отвечаешь покупателям в чатах Авито от лица продавца.`);
  parts.push('ПРАВИЛА ОТВЕТА:\n' + rules);
  if (company) parts.push('ИНФОРМАЦИЯ О КОМПАНИИ:\n' + company);

  if (ctx.item && ctx.item.title) {
    const it = ctx.item;
    const lines = [`Название: ${it.title}`];
    if (it.price) lines.push(`Цена в объявлении: ${it.price}`);
    if (it.url) lines.push(`Ссылка: ${it.url}`);
    if (it.closed) lines.push('ВНИМАНИЕ: объявление снято с продажи — не обещай наличие, предложи подобрать похожий вариант.');
    parts.push('ОБЪЯВЛЕНИЕ, ПО КОТОРОМУ ПИШЕТ КЛИЕНТ:\n' + lines.join('\n'));
  } else {
    parts.push('Это личный чат без привязки к объявлению — отвечай по информации о компании.');
  }
  if (ctx.phone) parts.push(`Клиент уже оставил телефон: ${ctx.phone}. Повторно номер не проси.`);
  if (ctx.alreadyGreeted) parts.push('Ты уже здоровался в этом чате — не здоровайся повторно.');

  parts.push(`ФОРМАТ ОТВЕТА: верни строго JSON-объект:
{"reply": "текст сообщения клиенту (до 800 символов, без markdown)",
 "phone": "номер телефона клиента, если он есть в переписке, иначе null",
 "handoff": true/false — true, если клиенту нужен живой менеджер (жалоба, сложный вопрос, просит позвать человека),
 "skip": true/false — true, если отвечать не нужно (клиент попрощался, написал «спасибо»/«ок» после завершения диалога)}`);
  return parts.join('\n\n');
}

function historyToMessages(history) {
  // history: [{direction:'in'|'out', type, text, source}]
  const out = [];
  for (const m of history) {
    if (!m.text) continue;
    if (m.type === 'system' || m.source === 'system') {
      out.push({ role: 'user', content: `[Системное сообщение Авито] ${m.text}` });
    } else if (m.direction === 'in') {
      out.push({ role: 'user', content: m.text });
    } else {
      out.push({ role: 'assistant', content: m.text });
    }
  }
  // OpenAI допускает подряд идущие сообщения одной роли — оставляем как есть
  return out.slice(-40);
}

async function callOpenAI(messages) {
  const key = getSetting('openai_api_key');
  if (!key) throw new Error('Не задан ключ OpenAI (OPENAI_API_KEY)');
  const model = getSetting('openai_model') || 'gpt-4o-mini';
  const temperature = Number(getSetting('temperature') || 0.5);
  const body = { model, messages, response_format: { type: 'json_object' } };
  // у reasoning-моделей (o*, gpt-5*) temperature не настраивается
  if (!/^(o\d|gpt-5)/.test(model)) body.temperature = temperature;

  const res = await fetch(OPENAI_BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('OpenAI: ' + (data.error?.message || res.status));
  const content = data.choices?.[0]?.message?.content || '';
  return { content, usage: data.usage, model: data.model || model };
}

function parseAgentJson(content) {
  let obj;
  try {
    obj = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    try { obj = m ? JSON.parse(m[0]) : null; } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object') obj = { reply: content };
  return {
    reply: typeof obj.reply === 'string' ? obj.reply.trim() : '',
    phone: obj.phone ? normalizePhone(obj.phone) : null,
    handoff: Boolean(obj.handoff),
    skip: Boolean(obj.skip),
  };
}

/**
 * Сгенерировать ответ.
 * @param {object} ctx {item:{title,price,url,closed}, phone, history:[...]}
 */
async function generateReply(ctx) {
  const alreadyGreeted = (ctx.history || []).some((m) => m.direction === 'out' && /здравствуйте|добрый (день|вечер)|привет/i.test(m.text || ''));
  const system = buildSystemPrompt({ ...ctx, alreadyGreeted });
  const messages = [{ role: 'system', content: system }, ...historyToMessages(ctx.history || [])];
  const { content, usage, model } = await callOpenAI(messages);
  const parsed = parseAgentJson(content);
  // телефон из сообщений клиента надёжнее, чем из ответа модели
  const clientText = (ctx.history || []).filter((m) => m.direction === 'in' && m.type !== 'system').map((m) => m.text).join('\n');
  const digits = clientText.replace(/\D/g, '');
  const modelPhoneOk = parsed.phone && digits.includes(parsed.phone.slice(2)); // модель не должна выдумать номер
  const phone = extractPhone(clientText) || (modelPhoneOk ? parsed.phone : null);
  return { ...parsed, phone, usage, model, systemPrompt: system };
}

module.exports = { generateReply, extractPhone, normalizePhone, buildSystemPrompt };
````

#### 3.9 `src/engine.js`

````javascript
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
````

#### 3.10 `public/index.html`

````html
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Авито Ассистент</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%234f46e5'/%3E%3Cpath d='M9 11h14v8h-8l-4 3v-3H9z' fill='white'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div id="login" class="login hidden">
    <form class="login-card" id="loginForm">
      <div class="logo-mark big">
        <svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 6h16v10h-9l-5 4v-4H4z" fill="currentColor"/></svg>
      </div>
      <h1>Авито Ассистент</h1>
      <p class="muted">ИИ-менеджер для чатов Авито</p>
      <label>Пароль<input type="password" id="loginPassword" autocomplete="current-password" placeholder="Введите пароль"></label>
      <button class="btn primary wide" type="submit">Войти</button>
      <div class="error" id="loginError"></div>
    </form>
  </div>

  <div id="app" class="layout hidden">
    <aside class="sidebar">
      <div class="brand">
        <div class="logo-mark"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 6h16v10h-9l-5 4v-4H4z" fill="currentColor"/></svg></div>
        <div><div class="brand-name">Авито Ассистент</div><div class="brand-sub">ИИ для чатов</div></div>
      </div>
      <nav class="nav">
        <div class="nav-title">Работа</div>
        <a href="#/dashboard" data-nav="dashboard"><span class="ico">▦</span>Дашборд</a>
        <a href="#/chats" data-nav="chats"><span class="ico">💬</span>Чаты</a>
        <a href="#/leads" data-nav="leads"><span class="ico">☎</span>Успешные чаты</a>
        <div class="nav-title">Агент</div>
        <a href="#/settings/agent" data-nav="settings"><span class="ico">⚙</span>Настройки</a>
        <a href="#/settings/sandbox" data-nav="sandbox"><span class="ico">🧪</span>Тест агента</a>
      </nav>
      <div class="sidebar-foot">
        <div id="connState" class="conn"></div>
        <button class="link" id="logoutBtn">Выйти</button>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div class="account">
          <div class="avatar" id="accAvatar">А</div>
          <div>
            <div class="acc-name"><span id="accName">Кабинет Авито</span> <span class="badge blue">Авито</span></div>
            <div class="muted small" id="accSub">не подключён</div>
          </div>
        </div>
        <div class="ai-switch">
          <span class="small muted">AI</span>
          <label class="switch"><input type="checkbox" id="aiGlobal"><span></span></label>
          <span class="small muted" id="aiSince"></span>
        </div>
      </header>
      <div class="tabs" id="tabs">
        <a href="#/dashboard" data-tab="dashboard">Дашборд</a>
        <a href="#/chats" data-tab="chats">Чаты</a>
        <a href="#/leads" data-tab="leads">Успешные чаты</a>
        <a href="#/settings/agent" data-tab="settings">Настройки</a>
      </div>
      <section id="view" class="view"></section>
    </main>
  </div>

  <div id="toast" class="toast hidden"></div>
  <script src="/app.js"></script>
</body>
</html>
````

#### 3.11 `public/style.css`

````css
:root {
  --bg: #f7f7fb;
  --panel: #ffffff;
  --panel-2: #f1f2f7;
  --border: #e6e7ef;
  --text: #16172b;
  --muted: #6b6f86;
  --accent: #4f46e5;
  --accent-soft: #eef0ff;
  --green: #16a34a;
  --green-soft: #e8f7ee;
  --orange: #ea7a1c;
  --orange-soft: #fff3e6;
  --red: #dc2626;
  --red-soft: #fdecec;
  --bubble-in: #ffffff;
  --bubble-out: #4f46e5;
  --shadow: 0 1px 2px rgba(20, 20, 50, .04), 0 2px 8px rgba(20, 20, 50, .04);
  --radius: 14px;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1020; --panel: #171830; --panel-2: #20213d; --border: #2b2d4d; --text: #ececf6; --muted: #9a9cb8;
    --accent: #7c74ff; --accent-soft: #25264a; --green-soft: #13301f; --orange-soft: #33230f; --red-soft: #3a1618;
    --bubble-in: #20213d; --bubble-out: #5b54f0; color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; background: var(--bg); color: var(--text); }
a { color: var(--accent); text-decoration: none; }
.hidden { display: none !important; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
h1, h2, h3 { margin: 0; }

/* layout */
.layout { display: grid; grid-template-columns: 240px 1fr; height: 100vh; }
.sidebar { background: var(--panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
.brand { display: flex; gap: 10px; align-items: center; padding: 20px 18px; border-bottom: 1px solid var(--border); }
.logo-mark { width: 36px; height: 36px; border-radius: 10px; background: var(--accent); color: #fff; display: grid; place-items: center; }
.logo-mark.big { width: 48px; height: 48px; margin: 0 auto 12px; border-radius: 12px; }
.brand-name { font-weight: 700; }
.brand-sub { font-size: 12px; color: var(--muted); }
.nav { padding: 12px; display: flex; flex-direction: column; gap: 2px; }
.nav-title { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: 14px 10px 6px; }
.nav a { display: flex; gap: 10px; align-items: center; padding: 9px 12px; border-radius: 10px; color: var(--text); }
.nav a:hover { background: var(--panel-2); }
.nav a.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.ico { width: 18px; text-align: center; opacity: .8; }
.sidebar-foot { margin-top: auto; padding: 14px 18px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.conn { font-size: 12px; color: var(--muted); }
.link { background: none; border: 0; color: var(--muted); cursor: pointer; padding: 0; text-align: left; font: inherit; }
.link:hover { color: var(--accent); }

.main { display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 16px 28px; background: var(--panel); }
.account { display: flex; gap: 12px; align-items: center; }
.avatar { width: 42px; height: 42px; border-radius: 12px; background: var(--accent-soft); color: var(--accent); display: grid; place-items: center; font-weight: 700; flex: none; }
.avatar.sm { width: 34px; height: 34px; border-radius: 50%; font-size: 13px; }
.acc-name { font-weight: 700; font-size: 17px; display: flex; gap: 8px; align-items: center; }
.ai-switch { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.tabs { display: flex; gap: 6px; padding: 0 20px; background: var(--panel); border-bottom: 1px solid var(--border); overflow-x: auto; }
.tabs a, .subtabs a { padding: 12px 14px; color: var(--muted); border-bottom: 2px solid transparent; white-space: nowrap; font-size: 15px; }
.tabs a.active, .subtabs a.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.subtabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin: -8px -4px 20px; overflow-x: auto; }
.subtabs a { font-size: 14px; padding: 10px 12px; }
.view { flex: 1; overflow: auto; padding: 24px 28px 40px; }
.view.flush { padding: 0; overflow: hidden; }

/* elements */
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; background: var(--panel-2); color: var(--muted); white-space: nowrap; }
.badge.blue { background: var(--accent-soft); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent); }
.badge.green { background: var(--green-soft); color: var(--green); }
.badge.orange { background: var(--orange-soft); color: var(--orange); }
.badge.red { background: var(--red-soft); color: var(--red); }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 22px; box-shadow: var(--shadow); }
.card + .card { margin-top: 16px; }
.card h3 { font-size: 15px; margin-bottom: 14px; }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.grid { display: grid; gap: 16px; }
.grid.c3 { grid-template-columns: repeat(3, 1fr); }
.grid.c2 { grid-template-columns: repeat(2, 1fr); }
.grid.c4 { grid-template-columns: repeat(4, 1fr); }
.spacer { flex: 1; }

.btn { border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 10px; padding: 8px 14px; font: inherit; font-weight: 500; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; }
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.primary:hover { filter: brightness(1.08); color: #fff; }
.btn.danger:hover { border-color: var(--red); color: var(--red); }
.btn.sm { padding: 5px 10px; font-size: 13px; }
.btn.wide { width: 100%; justify-content: center; padding: 11px; }
.btn:disabled { opacity: .55; cursor: default; }

input[type=text], input[type=password], input[type=number], input[type=date], input[type=search], textarea, select {
  width: 100%; background: var(--panel-2); border: 1px solid transparent; color: var(--text); border-radius: 10px; padding: 10px 12px; font: inherit; outline: none;
}
input:focus, textarea:focus, select:focus { border-color: var(--accent); background: var(--panel); }
textarea { resize: vertical; min-height: 90px; line-height: 1.5; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); }
.field-help { font-size: 12px; color: var(--muted); margin-top: -2px; }
.form { display: grid; gap: 16px; }
.toggle-row { display: flex; gap: 14px; align-items: flex-start; padding: 14px 0; border-top: 1px solid var(--border); }
.toggle-row:first-child { border-top: 0; }
.toggle-row b { display: block; margin-bottom: 2px; }

.switch { position: relative; width: 42px; height: 24px; display: inline-block; flex: none; }
.switch input { display: none; }
.switch span { position: absolute; inset: 0; background: #c9cbd9; border-radius: 99px; cursor: pointer; transition: .2s; }
.switch span::after { content: ""; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .2s; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.switch input:checked + span { background: var(--accent); }
.switch input:checked + span::after { transform: translateX(18px); }

/* dashboard */
.status-strip { display: flex; gap: 8px; flex-wrap: wrap; }
.kpi-label { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; }
.kpi-value { font-size: 38px; font-weight: 700; line-height: 1.1; margin: 4px 0; }
.kpi-value.orange { color: var(--orange); }
.stat-list > div { display: flex; justify-content: space-between; padding: 11px 0; border-top: 1px solid var(--border); }
.stat-list > div:first-child { border-top: 0; }
.stat-list b { font-size: 16px; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 8px; }
.section-title { display: flex; gap: 10px; align-items: baseline; margin: 26px 0 14px; }
.section-title h2 { font-size: 18px; }
.chart { width: 100%; height: 220px; }
.legend { display: flex; gap: 8px; }

/* chats */
.chats-layout { display: grid; grid-template-columns: 340px 1fr; height: 100%; }
.chat-list { border-right: 1px solid var(--border); display: flex; flex-direction: column; background: var(--panel); min-height: 0; }
.chat-list-head { padding: 14px; border-bottom: 1px solid var(--border); display: grid; gap: 10px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { border: 1px solid var(--border); background: var(--panel); border-radius: 999px; padding: 4px 11px; font-size: 12px; cursor: pointer; color: var(--text); }
.chip.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.chat-count { padding: 8px 14px; font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--border); }
.chat-items { overflow: auto; flex: 1; }
.chat-item { display: flex; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); cursor: pointer; }
.chat-item:hover { background: var(--panel-2); }
.chat-item.active { background: var(--accent-soft); }
.chat-item .body { min-width: 0; flex: 1; }
.chat-item .top { display: flex; justify-content: space-between; gap: 8px; }
.chat-item .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-item .item { color: var(--accent); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-item .preview { color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-item .tags { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
.chat-pane { display: flex; flex-direction: column; min-height: 0; background: var(--bg); }
.chat-head { display: flex; gap: 12px; align-items: center; padding: 12px 20px; background: var(--panel); border-bottom: 1px solid var(--border); }
.chat-head .spacer { flex: 1; }
.messages { flex: 1; overflow: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 10px; }
.msg { max-width: min(560px, 78%); padding: 10px 14px; border-radius: 16px; white-space: pre-wrap; word-wrap: break-word; position: relative; box-shadow: var(--shadow); }
.msg.in { align-self: flex-start; background: var(--bubble-in); border: 1px solid var(--border); border-bottom-left-radius: 6px; }
.msg.out { align-self: flex-end; background: var(--bubble-out); color: #fff; border-bottom-right-radius: 6px; }
.msg.out.manager { background: #0f766e; }
.msg.system { align-self: center; background: var(--panel-2); color: var(--muted); font-size: 12.5px; max-width: 80%; text-align: center; box-shadow: none; border-radius: 10px; }
.msg .meta { font-size: 11px; opacity: .7; margin-top: 4px; text-align: right; }
.composer { display: flex; gap: 10px; padding: 12px 20px; background: var(--panel); border-top: 1px solid var(--border); align-items: flex-end; }
.composer textarea { min-height: 44px; max-height: 160px; }
.empty { display: grid; place-items: center; height: 100%; color: var(--muted); text-align: center; padding: 30px; }

/* tables */
.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.table td { padding: 13px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.table tr:last-child td { border-bottom: 0; }
.table-wrap { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); overflow: auto; box-shadow: var(--shadow); }

/* sandbox */
.sandbox { display: grid; grid-template-columns: 1fr 360px; gap: 16px; align-items: start; }
.sandbox .messages { background: var(--bg); border-radius: 12px; min-height: 360px; max-height: 60vh; border: 1px solid var(--border); }
pre.prompt { white-space: pre-wrap; font-size: 12px; background: var(--panel-2); padding: 12px; border-radius: 10px; max-height: 360px; overflow: auto; margin: 0; }

.log-item { display: grid; grid-template-columns: 130px 110px 1fr; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.log-item.error { color: var(--red); }

.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #16172b; color: #fff; padding: 10px 18px; border-radius: 10px; z-index: 50; box-shadow: 0 6px 24px rgba(0,0,0,.2); max-width: 90vw; }
.toast.error { background: var(--red); }

.login { position: fixed; inset: 0; display: grid; place-items: center; background: var(--bg); }
.login-card { width: min(360px, 92vw); text-align: center; display: grid; gap: 14px; }
.login-card h1 { font-size: 22px; }
.login-card label { text-align: left; }
.error { color: var(--red); font-size: 13px; min-height: 18px; }
.notice { background: var(--orange-soft); color: var(--orange); padding: 12px 14px; border-radius: 10px; font-size: 13px; }
.notice.info { background: var(--accent-soft); color: var(--accent); }
code { background: var(--panel-2); padding: 2px 6px; border-radius: 6px; font-size: 12px; word-break: break-all; }

@media (max-width: 1000px) {
  .grid.c3, .grid.c4 { grid-template-columns: 1fr 1fr; }
  .sandbox { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar { display: none; }
  .topbar { padding: 12px 16px; }
  .view { padding: 16px; }
  .grid.c3, .grid.c2, .grid.c4 { grid-template-columns: 1fr; }
  .chats-layout { grid-template-columns: 1fr; }
  .chats-layout.has-chat .chat-list { display: none; }
  .chats-layout:not(.has-chat) .chat-pane { display: none; }
}
.grid > .card + .card { margin-top: 0; }
.btn { white-space: nowrap; }
.chat-head > div { flex-shrink: 1; }
.sandbox > .card + .card { margin-top: 0; }
````

#### 3.12 `public/app.js`

````javascript
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
````


---

## 4. Что осталось сделать (по приоритету)

1. **Запушить код в GitHub и задеплоить.** Залить содержимое `~/avito-assistant` (без `transfer.html`) в `2575424-star/avito-assistant`, ветка `main`. Подключить репозиторий к сервису Railway `avito-assistant` (serviceId выше) и дождаться сборки по Dockerfile. Проверить `/health` и вход. Желательно сделать репозиторий приватным и дать Railway GitHub App доступ к нему.
2. **Первый запуск на реальных данных.** Павел сам вводит ключи Авито и OpenAI в интерфейсе → «Проверить подключение» → «Загрузить до 500 чатов» → «Подключить вебхук». Проверить на реальных ответах API: форму ответа `messages/` (массив или объект), поле `direction`, `author_id` системных сообщений, `status_id` объявления, заголовки и формат тела вебхука (`payload.value.chat_id`). Поправить парсинг, если что-то расходится.
3. **Отладить правила вместе с Павлом** в «Тест агента» (тон, длина, поведение при отказе дать телефон, вопросы про кредит, трейд-ин, наличие). Завести шаблоны для частых системных сообщений (`two_way_chats`, `flower_generic_lead_signal`, `sbc_seller_notification`). Только после этого включать AI глобально.
4. **Надёжность:**
   - проверка подписи вебхука (`x-avito-messenger-signature`, алгоритм уточнить в документации Авито);
   - ограничение частоты запросов и ретраи с backoff;
   - таймеры ответов сейчас хранятся в памяти: после рестарта чаты, в которых ждали ответа, досылаются только при следующем сообщении; нужен пересмотр `needs_reply` при старте;
   - защита от гонок при нескольких инстансах (Railway должен работать строго в 1 реплику, потому что SQLite);
   - ротация журнала событий уже есть, нужен бэкап БД.
5. **База знаний по объявлениям:** подтягивать XML-фид (у образца `https://export.maxposter.ru/avito/5883.xml`) или Avito Items API. Вкладка «Карточки» с AI-тумблером на каждое объявление. В промпт передавать комплектацию, пробег, VIN и наличие. Правило для **снятых объявлений** (у образца есть тумблер «Отвечать по снятым объявлениям», у нас настройка `answer_closed_items` заведена, но не используется: нужен статус объявления).
6. **Уведомления по событиям**, как у образца: «клиент не даёт телефон», «клиент ждёт менеджера», «контакт в чате, где бот не ответил», запрос Автотеки, ссылка от клиента. Каналы: Telegram (есть), MAX, почта.
7. **Передача лида в CRM:** в первую очередь в **VECTOR-CRM** (формат уточнить), затем вебхук Битрикс24 и т. п. Обратный канал: API лидов по ключу.
8. **Рассылки и напоминания** (у образца это отдельные каналы с собственной конверсией): повторное сообщение клиенту, который не ответил, через N часов; рассылка скидки. Потребуют разбивки лидов по каналам на дашборде.
9. **Мультиаккаунт:** несколько кабинетов Авито (у образца это «Аккаунты»). Сейчас схема рассчитана на один кабинет. Нужны таблица `accounts` и `account_id` во всех таблицах.
10. **Пользователи и роли** вместо одного общего пароля; «Кошелёк» и биллинг не нужны, пока проект внутренний.
11. **Тесты:** вынести мок-сервер Авито и OpenAI (использовался при разработке, в репозиторий не попал) в `test/`, добавить сценарии: дебаунс, шаблон, лид, пауза при менеджере, `skip`, лимит ответов.
12. **Интеграция в VECTOR-CRM** (решение отложено Павлом): встраивать как модуль или оставить отдельным сервисом с API.

---

## 5. Открытые вопросы к Павлу

1. Какой тариф у кабинета Авито: есть ли доступ к Messenger API («Максимальный»)? Ключи от основного аккаунта компании?
2. Какой кабинет подключаем первым: «Платон Авто новые автомобили» (Воронеж, ID продавца 313181761) или другой? Сколько кабинетов будет в итоге?
3. Как ассистент должен работать с чатами, которые сейчас ведёт «ИИ Диалоги»? Два бота в одном кабинете будут конфликтовать: нужно решить, отключаем ли «ИИ Диалоги» и когда.
4. Финальные правила ответа: имя консультанта, тон, что можно обещать про цену, кредит, трейд-ин, скидки, тест-драйв; как отвечать, если клиент отказывается дать телефон; нужно ли предлагать мессенджеры (WhatsApp, Telegram, MAX) вместо звонка.
5. Информация о компании для промпта: адрес, часы работы, условия, контакты.
6. Источник данных по автомобилям: XML-фид (какой URL), выгрузка из учётной системы или Avito API?
7. Куда слать лиды и уведомления: Telegram-группа (какая), MAX, почта, VECTOR-CRM, Битрикс24? Кто получает уведомления?
8. Нужны ли рассылки и напоминания, и по каким правилам (через сколько, сколько раз, какой текст)?
9. Модель OpenAI: оставить `gpt-4o-mini` или взять более сильную? Есть ли лимит бюджета на токены?
10. Режим работы бота: круглосуточно или только в нерабочее время менеджеров?
11. Делать ли GitHub-репозиторий приватным (сейчас он публичный)?
12. Кто, кроме Павла, будет пользоваться интерфейсом (нужны ли отдельные логины)?
