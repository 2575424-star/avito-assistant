// Вызов моделей для «Лаборатории»: именованные профили ключей, Responses API или Chat Completions,
// учёт usage (вход, кэш, выход, reasoning) и расчёт стоимости. Ключи не покидают сервер.
const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

/** Убрать ключи из текста ошибки (провайдер может вернуть часть ключа). */
function scrub(text) {
  return String(text || '').replace(/(sk|rk|pk)-[A-Za-z0-9_\-]{4,}/g, '$1-…');
}

function baseUrl(profile) {
  if (profile.base_url) return profile.base_url.replace(/\/$/, '');
  return profile.provider === 'openrouter' ? OPENROUTER_BASE : OPENAI_BASE;
}

/** Нормализованный usage: input включает cached, output включает reasoning — детали не складываем повторно. */
function readUsage(u, api) {
  if (!u) return { input: null, cached: null, output: null, reasoning: null, known: false };
  if (api === 'responses' || u.input_tokens !== undefined) {
    return {
      input: u.input_tokens ?? null,
      cached: u.input_tokens_details?.cached_tokens ?? 0,
      output: u.output_tokens ?? null,
      reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
      known: u.input_tokens != null && u.output_tokens != null,
    };
  }
  return {
    input: u.prompt_tokens ?? null,
    cached: u.prompt_tokens_details?.cached_tokens ?? 0,
    output: u.completion_tokens ?? null,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
    known: u.prompt_tokens != null && u.completion_tokens != null,
  };
}

/**
 * Стоимость в USD по usage и ценам за 1 млн токенов. Цена кэша не задана — считаем по цене входа (с запасом).
 * usage неизвестен или цены не заданы — null (неизвестно, а не ноль).
 */
function costUsd(usage, prices) {
  if (!usage?.known || prices.price_in == null || prices.price_out == null) return null;
  const cached = Math.min(usage.cached || 0, usage.input);
  const cachedPrice = prices.price_cached_in ?? prices.price_in;
  return ((usage.input - cached) * prices.price_in + cached * cachedPrice + usage.output * prices.price_out) / 1e6;
}

function outputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  const parts = [];
  for (const o of data.output || []) for (const c of o.content || []) if (c.type === 'output_text' && c.text) parts.push(c.text);
  return parts.join('');
}

/**
 * @param {object} p {profile:{api_key, provider, base_url}, model, api:'responses'|'chat', system, messages:[{role, content}],
 *                    reasoning_effort?, max_output_tokens?, temperature?}
 * @returns {{content, usage, api, params, ms}}
 */
async function call(p) {
  if (!p.profile?.api_key) throw new Error('У модели не задан профиль ключа (Настройки → Ключи и модели)');
  const base = baseUrl(p.profile);
  const headers = { Authorization: 'Bearer ' + p.profile.api_key, 'Content-Type': 'application/json' };
  const started = Date.now();
  let api = p.api === 'chat' ? 'chat' : 'responses';
  const params = { json: true, reasoning_effort: p.reasoning_effort || null, max_output_tokens: p.max_output_tokens || null, temperature: p.temperature ?? null };

  const build = () => {
    if (api === 'responses') {
      const body = { model: p.model, instructions: p.system, input: p.messages.map((m) => ({ role: m.role, content: m.content })) };
      if (params.json) body.text = { format: { type: 'json_object' } };
      if (params.reasoning_effort) body.reasoning = { effort: params.reasoning_effort };
      if (params.max_output_tokens) body.max_output_tokens = params.max_output_tokens;
      if (params.temperature != null) body.temperature = params.temperature;
      return { url: base + '/responses', body };
    }
    const body = { model: p.model, messages: [{ role: 'system', content: p.system }, ...p.messages] };
    if (params.json) body.response_format = { type: 'json_object' };
    if (params.reasoning_effort) body.reasoning_effort = params.reasoning_effort;
    if (params.max_output_tokens) body.max_completion_tokens = params.max_output_tokens;
    if (params.temperature != null) body.temperature = params.temperature;
    return { url: base + '/chat/completions', body };
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    const { url, body } = build();
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const content = api === 'responses' ? outputText(data) : data.choices?.[0]?.message?.content || '';
      return { content, usage: readUsage(data.usage, api), api, params: { ...params }, ms: Date.now() - started, servedModel: data.model || p.model };
    }
    const msg = scrub(data.error?.message || JSON.stringify(data.error || '') || String(res.status));
    // Responses API недоступен для модели/прокси — пробуем Chat Completions
    // (ошибку «модель не найдена» так не лечим — она вернётся и в Chat Completions)
    if (api === 'responses' && /unknown url|invalid url|no route|responses.{0,40}not (supported|available)|not supported.{0,40}responses/i.test(msg)) { api = 'chat'; continue; }
    // неподдерживаемый параметр — убираем и повторяем
    if (res.status === 400) {
      if (/temperature/i.test(msg) && params.temperature != null) { params.temperature = null; continue; }
      if (/reasoning/i.test(msg) && params.reasoning_effort) { params.reasoning_effort = null; continue; }
      if (/response_format|text\.format|json/i.test(msg) && params.json) { params.json = false; continue; }
      if (/max_(output|completion)_tokens/i.test(msg) && params.max_output_tokens) { params.max_output_tokens = null; continue; }
    }
    const err = new Error(`${p.profile.provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'} (${p.model}): ${msg}`);
    err.status = res.status;
    throw err;
  }
  throw new Error('Не удалось подобрать параметры запроса');
}

/** Распознавание речи (OpenAI Audio Transcriptions). buf — Buffer с записью, mime — тип записи браузера. */
async function transcribe({ profile, buf, mime = 'audio/webm', model = 'gpt-4o-mini-transcribe', language = 'ru' }) {
  if (!profile?.api_key) throw new Error('Нет ключа OpenAI для распознавания речи: Настройки → Ключи и модели');
  const ext = /mp4|m4a|aac/.test(mime) ? 'mp4' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : /mpeg|mp3/.test(mime) ? 'mp3' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime.split(';')[0] }), 'voice.' + ext);
  form.append('model', model);
  form.append('language', language);
  const res = await fetch(baseUrl(profile) + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + profile.api_key }, body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(scrub(`Распознавание: HTTP ${res.status} ${text.slice(0, 300)}`));
  try { return String(JSON.parse(text).text || '').trim(); } catch { return text.trim(); }
}

module.exports = { call, costUsd, readUsage, scrub, transcribe };
