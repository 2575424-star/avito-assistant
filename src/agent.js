// Агент: собирает промпт из правил + данных объявления + истории и получает ответ от OpenAI.
const crypto = require('node:crypto');
const { db, getSetting } = require('./db');
const knowledge = require('./knowledge');

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

/** Модели для сравнения: из настройки compare_models (через запятую или с новой строки). */
function compareModels() {
  const list = String(getSetting('compare_models') || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  return [...new Set(list)];
}

// ---------- Телефоны и состояние чата: общий модуль для импорта, живых чатов и агента ----------
const chatstate = require('./chatstate');
const { normalizePhone } = chatstate;
const extractPhone = chatstate.phoneInText;

// ---------- Промпт ----------
function getVersion(id) {
  return id ? db.prepare('SELECT * FROM agent_versions WHERE id = ?').get(Number(id)) || null : null;
}

/** Подпись конфигурации: «A_direct v0.2.0 · gpt-4o-mini» или «Настройки · …». */
function configLabel(version, model) {
  return `${version ? version.key + ' ' + version.version : 'Настройки'} · ${model || getSetting('openai_model') || 'gpt-4o-mini'}`;
}

function buildSystemPrompt(ctx = {}) {
  const company = getSetting('company_info');
  const parts = [];
  if (ctx.version) {
    // версия агента: своя общая инструкция и стратегия вместо правил из настроек
    parts.push(ctx.version.base_prompt);
    if (ctx.version.strategy) parts.push(ctx.version.strategy);
  } else {
    const name = getSetting('assistant_name') || 'Консультант';
    parts.push(`Тебя зовут ${name}. Ты отвечаешь покупателям в чатах Авито от лица продавца.`);
    parts.push('ПРАВИЛА ОТВЕТА:\n' + getSetting('rules'));
  }
  if (company) parts.push('ИНФОРМАЦИЯ О КОМПАНИИ:\n' + company);

  // карточка автомобиля: полная из базы (фид / API), иначе то, что пришло в контексте чата
  const stored = ctx.item?.id ? knowledge.getItem(ctx.item.id) : null;
  if (stored) {
    parts.push('ОБЪЯВЛЕНИЕ, ПО КОТОРОМУ ПИШЕТ КЛИЕНТ:\n' + knowledge.itemCard(stored));
    if (stored.status && stored.status !== 'active') {
      parts.push('ВНИМАНИЕ: это объявление снято с продажи — не обещай наличие, предложи подобрать похожий вариант из списка ниже.');
    }
  } else if (ctx.item && ctx.item.title) {
    const it = ctx.item;
    const lines = [`Название: ${it.title}`];
    if (it.price) lines.push(`Цена в объявлении: ${it.price}`);
    if (it.url) lines.push(`Ссылка: ${it.url}`);
    if (it.closed) lines.push('ВНИМАНИЕ: объявление снято с продажи — не обещай наличие, предложи подобрать похожий вариант.');
    parts.push('ОБЪЯВЛЕНИЕ, ПО КОТОРОМУ ПИШЕТ КЛИЕНТ:\n' + lines.join('\n'));
  } else {
    parts.push('Это личный чат без привязки к объявлению — отвечай по информации о компании.');
  }

  parts.push('НАЛИЧИЕ АВТОМОБИЛЕЙ: клиенты часто спрашивают, есть ли машина в наличии. Отвечай строго по полю «НАЛИЧИЕ» в карточке: «в наличии» — можно приехать и посмотреть; «в пути» — машина едет в салон, её можно забронировать, дату поступления уточнит менеджер; если наличие не указано — не обещай, скажи, что менеджер уточнит.');

  const kb = knowledge.kbPromptSections(ctx.queryText || '');
  if (kb.text) parts.push(kb.text);

  const stock = knowledge.stockList(stored?.key);
  if (stock) parts.push('ДРУГИЕ АВТОМОБИЛИ В ПРОДАЖЕ (для подбора альтернативы; подробности уточнит менеджер):\n' + stock);

  if (ctx.chatState) parts.push(chatstate.cpaPromptLine(ctx.chatState));
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

/**
 * Вызов LLM. Модель «gpt-4o-mini» — OpenAI; «openrouter:anthropic/claude-…» — OpenRouter
 * (один ключ даёт Claude, Gemini, DeepSeek, Llama и др., API совместим с OpenAI).
 */
async function callOpenAI(messages, opts = {}) {
  const label = opts.model || getSetting('openai_model') || 'gpt-4o-mini';
  const viaRouter = label.startsWith('openrouter:');
  const model = viaRouter ? label.slice('openrouter:'.length) : label;
  const key = viaRouter ? getSetting('openrouter_api_key') : getSetting('openai_api_key');
  const provider = viaRouter ? 'OpenRouter' : 'OpenAI';
  if (!key) throw new Error(viaRouter ? 'Не задан ключ OpenRouter (Настройки → Авито → Ключи ИИ)' : 'Не задан ключ OpenAI (OPENAI_API_KEY)');
  const temperature = opts.temperature ?? Number(getSetting('temperature') || 0.5);
  const body = { model, messages, response_format: { type: 'json_object' } };
  // у reasoning-моделей (o*, gpt-5*) temperature не настраивается
  if (!/^(openai\/)?(o\d|gpt-5)/.test(model)) body.temperature = temperature;

  const post = () => fetch((viaRouter ? OPENROUTER_BASE : OPENAI_BASE) + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(viaRouter ? { 'X-Title': 'Avito Assistant' } : {}) },
    body: JSON.stringify(body),
  });
  let res = await post();
  let data = await res.json().catch(() => ({}));
  // не все модели поддерживают JSON-режим — повторяем без него, ответ разберём сами
  if (!res.ok && res.status === 400 && /response_format|json/i.test(JSON.stringify(data.error || ''))) {
    delete body.response_format;
    res = await post();
    data = await res.json().catch(() => ({}));
  }
  if (!res.ok) throw new Error(`${provider} (${model}): ` + (data.error?.message || res.status));
  const content = data.choices?.[0]?.message?.content || '';
  return { content, usage: data.usage, model: label };
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
async function generateReply(ctx, opts = {}) {
  const alreadyGreeted = (ctx.history || []).some((m) => m.direction === 'out' && /здравствуйте|добрый (день|вечер)|привет/i.test(m.text || ''));
  // последние сообщения клиента — по ним ищем нужные записи в базе знаний
  const queryText = (ctx.history || []).filter((m) => m.direction === 'in' && m.source !== 'system').slice(-3).map((m) => m.text).join('\n');
  const history = ctx.history || [];
  const found = chatstate.findPhone(history);
  const version = getVersion(opts.versionId);
  const system = buildSystemPrompt({ ...ctx, version, phone: ctx.phone || found?.phone || null, alreadyGreeted, queryText, chatState: chatstate.cpaState(history) });
  // снимок промпта: по хэшу всегда можно восстановить, что именно видела модель
  const promptHash = crypto.createHash('sha256').update(system).digest('hex').slice(0, 16);
  db.prepare('INSERT OR IGNORE INTO prompt_snapshots(hash, text, created) VALUES(?,?,?)').run(promptHash, system, Math.floor(Date.now() / 1000));
  const messages = [{ role: 'system', content: system }, ...historyToMessages(ctx.history || [])];
  const started = Date.now();
  const { content, usage, model } = await callOpenAI(messages, {
    model: opts.model || version?.model || undefined,
    temperature: version?.temperature ?? undefined,
  });
  const ms = Date.now() - started;
  const parsed = parseAgentJson(content);
  // телефон из сообщений клиента надёжнее, чем из ответа модели
  const clientText = (ctx.history || []).filter((m) => m.direction === 'in' && m.type !== 'system').map((m) => m.text).join('\n');
  const digits = clientText.replace(/\D/g, '');
  const modelPhoneOk = parsed.phone && digits.includes(parsed.phone.slice(2)); // модель не должна выдумать номер
  const phone = found?.phone || (modelPhoneOk ? parsed.phone : null);
  return { ...parsed, phone, usage, model, ms, systemPrompt: system, versionId: version?.id || null, promptHash, config: configLabel(version, model) };
}

// ---------- Разбор переписок менеджеров ----------
const ROLE_RU = { client: 'Клиент', manager: 'Продавец', bot: 'Продавец (бот)', quick: 'Продавец (быстрый ответ)', template: 'Продавец (шаблон)', system: 'Авито' };

function transcript(messages, maxChars = 9000) {
  const lines = [];
  let prev = null;
  for (const m of messages) {
    if (!m.text) continue;
    const t = new Date(m.created * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const gap = prev ? m.created - prev : 0;
    const gapTxt = gap >= 600 ? ` (через ${gap >= 86400 ? Math.round(gap / 86400) + ' дн' : gap >= 3600 ? Math.round(gap / 3600) + ' ч' : Math.round(gap / 60) + ' мин'})` : '';
    lines.push(`[${t}${gapTxt}] ${ROLE_RU[m.source] || (m.direction === 'in' ? 'Клиент' : 'Продавец')}: ${m.text}`);
    prev = m.created;
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars / 3) + '\n…\n' + text.slice(-maxChars * 2 / 3);
  return text;
}

async function analyzeChat({ chat, messages }) {
  const company = getSetting('company_info');
  const system = `Ты — руководитель отдела продаж автосалона. Разбираешь переписку продавца с покупателем в чате Авито.
Цель продавца — вежливо и быстро ответить на вопрос и получить номер телефона покупателя, чтобы менеджер перезвонил.
${company ? 'Информация о компании:\n' + company + '\n' : ''}
Верни строго JSON:
{"summary": "1–2 предложения: что хотел клиент и чем закончилось",
 "questions": ["вопросы клиента, коротко, в общем виде: «есть ли кредит», «какой пробег»"],
 "outcome": "phone" (клиент оставил телефон) | "call" (договорились созвониться/приехать без телефона в чате) | "lost" (клиент перестал отвечать или ушёл) | "no_answer" (продавец не ответил) | "other",
 "score": 1–10 — оценка работы продавца,
 "speed": "оценка скорости ответов продавца одной фразой",
 "mistakes": ["конкретные ошибки продавца: не ответил на вопрос, не попросил телефон, ответил через сутки, грубость, выдумал условия…"],
 "good": ["что продавец сделал хорошо"],
 "better_reply": {"client": "ключевое сообщение клиента, на котором продавец ошибся", "reply": "как надо было ответить"} или null,
 "faq": [{"q": "общий вопрос клиента", "a": "ответ продавца, если в нём есть полезные факты о компании/условиях, которые можно переиспользовать"}]}
В faq включай только факты, а не персональные детали этого клиента. Пиши по-русски.`;
  const item = chat.item_title ? `Объявление: ${chat.item_title}${chat.item_price ? ', ' + chat.item_price : ''}\n\n` : 'Личный чат без объявления\n\n';
  const { content, usage, model } = await callOpenAI(
    [{ role: 'system', content: system }, { role: 'user', content: item + 'Переписка:\n' + transcript(messages) }],
    { model: getSetting('analysis_model') || undefined, temperature: 0.2 },
  );
  let obj = {};
  try { obj = JSON.parse(content); } catch { const mm = content.match(/\{[\s\S]*\}/); try { obj = mm ? JSON.parse(mm[0]) : {}; } catch { obj = {}; } }
  return { result: obj, usage, model };
}

async function summarizeReviews(reviews) {
  const lines = reviews.map((r, i) => {
    const x = r.result;
    return `#${i + 1} [оценка ${x.score ?? '?'}; итог ${x.outcome || '?'}] ${x.summary || ''}
Вопросы: ${(x.questions || []).join('; ')}
Ошибки: ${(x.mistakes || []).join('; ')}
Хорошо: ${(x.good || []).join('; ')}
FAQ: ${(x.faq || []).map((f) => f.q + ' → ' + f.a).join(' | ')}`;
  }).join('\n\n');
  const system = `Ты — руководитель отдела продаж автосалона. Тебе дали разборы переписок продавцов с покупателями на Авито.
Составь сводный отчёт для настройки ИИ-консультанта, который будет отвечать вместо продавцов. Верни строго JSON:
{"overview": "3–5 предложений: как в целом работают продавцы, главные проблемы",
 "top_questions": [{"question": "частый вопрос клиентов", "count": число разборов, где встречался}],
 "mistakes": [{"mistake": "типичная ошибка", "count": число, "fix": "как должен действовать ИИ-консультант"}],
 "good_practices": ["удачные приёмы продавцов, которые стоит перенять"],
 "rules": "текст дополнительных правил для промпта ИИ-консультанта (список, 5–12 пунктов)",
 "faq": [{"q": "вопрос", "a": "ответ по фактам из переписок"}]}
Сортируй по частоте. В faq — только проверенные факты из переписок, без выдумок. Пиши по-русски.`;
  const { content, usage, model } = await callOpenAI(
    [{ role: 'system', content: system }, { role: 'user', content: `Разборов: ${reviews.length}\n\n${lines}`.slice(0, 60000) }],
    { model: getSetting('analysis_model') || undefined, temperature: 0.2 },
  );
  let obj = {};
  try { obj = JSON.parse(content); } catch { obj = {}; }
  return { result: obj, usage, model };
}

module.exports = { getVersion, configLabel, compareModels, generateReply, extractPhone, normalizePhone, buildSystemPrompt, analyzeChat, summarizeReviews, transcript };
