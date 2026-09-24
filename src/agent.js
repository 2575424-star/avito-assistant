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
