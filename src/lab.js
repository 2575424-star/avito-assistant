// «Лаборатория»: сравнение стратегий общения × моделей на тестовых сценариях.
// Полностью изолирована: не трогает чаты, сообщения, лиды, Авито и Telegram — только таблицы lab_* и вызовы моделей.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, getSetting, setSetting, logEvent } = require('./db');
const llm = require('./llm');
const chatstate = require('./chatstate');
const { itemCard, salonFacts, AVAIL_PROMPT } = require('./knowledge'); // только форматирование карточки, без обращений к Авито

const now = () => Math.floor(Date.now() / 1000);
const LAB_DIR = path.join(__dirname, 'lab');
const read = (f) => fs.readFileSync(path.join(LAB_DIR, f), 'utf8');

// ---------- Начальные данные (v0.3.0 от владельца: 3 стратегии × 2 модели) ----------
const LAB_KEYS = ['codex_business', 'codex_friendly', 'claude_independent', 'simple'];

function seed() {
  const common = read('common_rules.md');
  const ins = db.prepare('INSERT OR IGNORE INTO agent_versions(key, version, title, base_prompt, strategy, status, created) VALUES(?,?,?,?,?,?,?)');
  ins.run('codex_business', 'v0.3.0', 'Codex — деловая', common, read('codex_business.md'), 'active', now());
  ins.run('codex_friendly', 'v0.3.0', 'Codex — неформальная', common,
    read('codex_friendly.md') + '\n\n## Библиотека ситуаций (friendly_examples.md)\n\n' + read('friendly_examples.md'), 'active', now());
  ins.run('claude_independent', 'v0.3.0', 'Claude — ответ-проводник', common, read('claude_independent.md'), 'active', now());
  // решение владельца v0.3.0: активны ровно три стратегии, прежние A/B/C — в архив (история сохраняется)
  if (getSetting('lab_seeded') !== 'v0.3.0') {
    db.prepare("UPDATE agent_versions SET status = 'archived' WHERE key IN ('A_direct', 'B_consultative', 'C_adaptive', 'D_friendly')").run();
    setSetting('lab_seeded', 'v0.3.0');
  }
  if (!db.prepare('SELECT 1 FROM lab_models LIMIT 1').get()) {
    const m = db.prepare('INSERT INTO lab_models(label, model, api, price_in, price_cached_in, price_out, price_version, created) VALUES(?,?,?,?,?,?,?,?)');
    const pv = 'OpenAI Standard, ориентир из пакета Codex 24.09.2026 — сверить с openai.com/api/pricing';
    m.run('GPT-6 Sol', 'gpt-6-sol', 'responses', 2, null, 10, pv, now());
    m.run('GPT-6 Luna', 'gpt-6-luna', 'responses', 0.1, null, 0.5, pv, now());
  }
  // решение владельца 24.09: простая стратегия как в первой версии (без общего слоя), Sol скрыт (дорогой),
  // добавлена простая разговорная модель gpt-4o-mini — на ней работала первая версия
  ins.run('simple', 'v0.4.0', 'Простая (как первая версия)', read('simple.md'), null, 'active', now());
  if (getSetting('lab_seeded_v040') !== '1') {
    db.prepare("UPDATE lab_models SET active = 0 WHERE model = 'gpt-6-sol'").run();
    if (!db.prepare("SELECT 1 FROM lab_models WHERE model = 'gpt-4o-mini'").get()) {
      const luna = db.prepare("SELECT key_profile_id FROM lab_models WHERE model = 'gpt-6-luna'").get();
      db.prepare('INSERT INTO lab_models(label, model, api, key_profile_id, price_in, price_cached_in, price_out, price_version, created) VALUES(?,?,?,?,?,?,?,?,?)')
        .run('GPT-4o mini', 'gpt-4o-mini', 'chat', luna?.key_profile_id || null, 0.15, 0.075, 0.6, 'OpenAI Standard, 24.09.2026 — сверить с openai.com/api/pricing', now());
    }
    setSetting('lab_seeded_v040', '1');
  }
  const c = db.prepare(`INSERT INTO lab_cases(id, set_name, version, title, facts, client_turns, turn_mode, expected, created) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version, title = excluded.title, facts = excluded.facts, client_turns = excluded.client_turns, turn_mode = excluded.turn_mode, expected = excluded.expected`);
  for (const [file, set] of [['standard_questions.jsonl', 'standard'], ['faq_questions.jsonl', 'faq'], ['archive_questions.jsonl', 'archive']]) {
    for (const line of read(file).trim().split('\n')) {
      const x = JSON.parse(line);
      c.run(x.id, set, x.version, x.title, JSON.stringify(x.facts || {}), JSON.stringify(x.client_turns), x.turn_mode, JSON.stringify(x.expected || []), now());
    }
  }
}
seed();

// ---------- Профили ключей ----------
const mask = (k) => (k ? '••••' + String(k).slice(-4) : '');
function profiles() {
  return db.prepare('SELECT id, name, provider, base_url, api_key, created FROM key_profiles ORDER BY id').all()
    .map(({ api_key, ...p }) => ({ ...p, key_mask: mask(api_key), has_key: Boolean(api_key) }));
}
function profileWithSecret(id) {
  return id ? db.prepare('SELECT * FROM key_profiles WHERE id = ?').get(Number(id)) : null;
}

function models() {
  return db.prepare('SELECT m.*, p.name AS profile_name FROM lab_models m LEFT JOIN key_profiles p ON p.id = m.key_profile_id ORDER BY m.id').all();
}

function strategies() {
  return db.prepare(`SELECT id, key, version, title, status, created FROM agent_versions WHERE status = 'active' ORDER BY
    CASE key WHEN 'codex_business' THEN 1 WHEN 'codex_friendly' THEN 2 WHEN 'claude_independent' THEN 3 WHEN 'simple' THEN 4 ELSE 5 END, id`).all();
}

function cases() {
  return db.prepare('SELECT * FROM lab_cases ORDER BY set_name, id').all().map((c) => ({
    ...c, facts: JSON.parse(c.facts || '{}'), client_turns: JSON.parse(c.client_turns || '[]'), expected: JSON.parse(c.expected || '[]'),
  }));
}

// ---------- Сборка промпта: общий слой + стратегия + факты + адаптер формата ----------
const ADAPTER = `АДАПТЕР ПРИЛОЖЕНИЯ:
- Инструментов записи, брони, CRM и отправки материалов у тебя нет: не пиши, что действие выполнено.
- Названия, адреса и цены бери из фактов как есть, без слов «учебный», «тестовый», «пример».
- Клиент видит только текст из поля "reply". Служебные поля обрабатывает программа.
- Верни строго JSON-объект:
{"reply": "текст сообщения клиенту (до 800 символов, без markdown)",
 "phone": "номер телефона клиента, если он есть в переписке, иначе null",
 "handoff": true/false — нужен живой сотрудник (жалоба, спор, вопрос вне полномочий, просьба позвать человека),
 "skip": true/false — отвечать не нужно (клиент попрощался или просит больше не писать и вопроса нет)}`;

// поля сценария, которые заменяет карточка реального автомобиля
const CAR_KEYS = ['model', 'listing_price_rub', 'cash_total_rub', 'our_cash_total_rub', 'price_cash_rub', 'trim', 'features', 'engine', 'transmission', 'drive', 'mileage_km', 'vin'];

function getItem(key) {
  return key ? db.prepare('SELECT * FROM items WHERE key = ?').get(String(key)) || null : null;
}

function buildPrompt(version, kase, history, item = null) {
  const facts = { 'company.display_name': 'InDrive', ...kase.facts };
  if (item) {
    for (const k of CAR_KEYS) delete facts[k];
    // у реальной машины наличие своё — оно важнее условия сценария
    if (item.availability_manual || item.availability) { delete facts.availability; delete facts.eta; delete facts.eta_confirmed; }
  }
  // тип объявления из сценария (в наличии / в пути), если реальная машина не выбрана
  const availKey = facts.availability_key; delete facts.availability_key;
  const parts = [version.base_prompt];
  if (version.strategy) parts.push(version.strategy);
  const sf = salonFacts();
  if (sf) parts.push(sf);
  if (!item && AVAIL_PROMPT[availKey]) parts.push('ОБЪЯВЛЕНИЕ, ПО КОТОРОМУ ПИШЕТ КЛИЕНТ:\nНАЛИЧИЕ: ' + AVAIL_PROMPT[availKey]);
  if (item) parts.push('АВТОМОБИЛЬ ИЗ ОБЪЯВЛЕНИЯ (подтверждённые данные):\n' + itemCard(item) + '\n\nФакты ниже (кредит, трейд-ин, сроки, полномочия компании) дополняют карточку.');
  parts.push('ФАКТЫ (считать подтверждёнными на сегодня; null или отсутствие поля — данных нет):\n' + JSON.stringify(facts, null, 1));
  if (!version.key?.startsWith('gpt_egor_')) parts.push(chatstate.cpaPromptLine(chatstate.cpaState(history)));
  parts.push(ADAPTER);
  return parts.join('\n\n');
}

function parseReply(content) {
  let obj = null;
  try { obj = JSON.parse(content); } catch {
    const m = String(content).match(/\{[\s\S]*\}/);
    try { obj = m ? JSON.parse(m[0]) : null; } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, reply: String(content || '').trim(), phone: null, handoff: false, skip: false };
  return { ok: true, reply: String(obj.reply || '').trim(), phone: obj.phone || null, handoff: Boolean(obj.handoff), skip: Boolean(obj.skip) };
}

// ---------- Автопроверки ответа (не заменяют оценку человека) ----------
const REFUSAL_RE = /не готов звонить|звонки[^.]{0,20}неудоб|не звоните|только писать|только (в )?чат|номер оставлять не хочу|не хочу (давать|оставлять) (номер|телефон)|больше не пишите/i;
const MONEY_RE = /(\d[\d\s]{2,}(?:[.,]\d+)?)\s*(₽|руб|р\.|тыс|млн)|(\d{1,3}(?:[\s ]\d{3}){1,3})(?!\d)/gi;

function factNumbers(facts) {
  const out = new Set();
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'number') { out.add(String(v)); return; }
    if (typeof v === 'string') { for (const m of v.match(/\d[\d\s]*\d|\d/g) || []) out.add(m.replace(/\s/g, '')); return; }
    if (Array.isArray(v)) v.forEach(walk); else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(facts);
  return out;
}

function checkTurn({ reply, parsed, turnIndex, clientTurns, facts, history }) {
  const flags = [];
  const add = (code, text, critical = false) => flags.push({ code, text, critical });
  if (!parsed.ok) add('json', 'Ответ не в формате JSON — приложение не сможет его разобрать', true);
  if (!reply && !parsed.skip) add('empty', 'Пустой ответ');
  if (/\[[^\]]{2,60}\]/.test(reply)) add('placeholder', 'Заполнитель в квадратных скобках попал в ответ', true);
  if (turnIndex > 0 && /меня зовут Ярослав/i.test(reply)) add('reintro', 'Повторное представление');
  if (turnIndex === 0 && !/Ярослав/.test(reply) && !parsed.skip) add('nointro', 'Нет представления в первом ответе');
  const avail = String(facts.availability || '');
  if (/пути|заказ/i.test(avail) && /(?<!не\s)(?<!нет\s)в наличии/i.test(reply) && !/в пути|поступ|едет|под заказ/i.test(reply)) {
    add('availability', `Назвал «в наличии», а по фактам: ${avail}`, true);
  }
  if (/(записал[аи]?\s|вы записаны|забронировал|бронь оформлена|оформил[аи]? бронь|отправил[аи]? (вам )?(расч|фото|видео|кп))/i.test(reply)) {
    add('action', 'Заявляет выполненное действие, которого система не делала', true);
  }
  const refused = clientTurns.some((t) => REFUSAL_RE.test(t)); // clientTurns — сообщения клиента до этого ответа включительно
  if (refused && /(позвон|созвон|оставьте (ваш |свой )?(номер|телефон)|ваш номер|по телефону)/i.test(reply)) {
    add('refusal', 'Предлагает звонок/номер после отказа клиента', true);
  }
  if (/(лучше|удобнее) (пишите|писать)|не звоните/i.test(reply)) add('calls', 'Отговаривает звонить (нарушение п. 2.9 правил Авито)', true);
  const known = factNumbers(facts);
  for (const m of reply.matchAll(MONEY_RE)) {
    const n = (m[1] || m[3] || '').replace(/[\s ]/g, '').replace(/[.,]\d+$/, '');
    if (n.length >= 4 && ![...known].some((k) => k.includes(n) || n.includes(k))) add('money', `Сумма «${m[0].trim()}» не из фактов — проверить, не выдумана ли`);
  }
  if (reply.length > 800) add('long', `Длинный ответ: ${reply.length} знаков`);
  if (history.length && /\?\s*$/.test(reply) && (reply.match(/\?/g) || []).length > 2) add('questions', 'Больше двух вопросов в ответе');
  return flags;
}

// ---------- Прогон одной комбинации на одном сценарии ----------
async function runOne({ kase, version, model, batch, isStopped, item = null }) {
  const profile = profileWithSecret(model.key_profile_id);
  const turnsOut = [];
  const history = []; // только свои ответы этой комбинации
  const clientTurns = kase.client_turns;
  const groups = kase.turn_mode === 'consecutive_messages_one_response' ? [clientTurns] : clientTurns.map((t) => [t]);
  let totals = { input: 0, cached: 0, output: 0, reasoning: 0, known: true };
  let cost = 0, costKnown = true, ms = 0, status = 'ok', error = null, api = model.api, params = null, promptHash = null;
  let idx = 0;
  for (const g of groups) {
    if (isStopped()) { status = 'stopped'; break; }
    for (const text of g) history.push({ id: 'c' + history.length, direction: 'in', source: 'client', type: 'text', text, created: now() });
    const system = buildPrompt(version, kase, history, item);
    promptHash ||= crypto.createHash('sha256').update(system).digest('hex').slice(0, 16);
    db.prepare('INSERT OR IGNORE INTO prompt_snapshots(hash, text, created) VALUES(?,?,?)').run(
      crypto.createHash('sha256').update(system).digest('hex').slice(0, 16), system, now());
    const messages = history.map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.text }));
    try {
      const r = await llm.call({ profile, model: model.model, api: model.api, system, messages, reasoning_effort: model.reasoning_effort, max_output_tokens: model.max_output_tokens });
      api = r.api; params = r.params;
      const parsed = parseReply(r.content);
      const c = llm.costUsd(r.usage, model);
      const flags = checkTurn({ reply: parsed.reply, parsed, turnIndex: idx, clientTurns: g.length > 1 ? clientTurns : clientTurns.slice(0, clientTurns.indexOf(g[0]) + 1), facts: kase.facts, history });
      turnsOut.push({ client: g.join('\n'), reply: parsed.reply, parsed, usage: r.usage, ms: r.ms, cost: c, flags });
      ms += r.ms;
      if (r.usage.known) for (const k of ['input', 'cached', 'output', 'reasoning']) totals[k] += r.usage[k] || 0; else totals.known = false;
      if (c == null) costKnown = false; else cost += c;
      history.push({ id: 'a' + history.length, direction: 'out', source: 'bot', type: 'text', text: parsed.reply || '', created: now() });
    } catch (e) {
      status = 'error';
      // A failed request may still have consumed tokens; never report its usage as zero.
      totals.known = false; costKnown = false;
      error = llm.scrub(e.message).slice(0, 500);
      turnsOut.push({ client: g.join('\n'), reply: null, error });
      break;
    }
    idx++;
  }
  const flags = turnsOut.flatMap((t, i) => (t.flags || []).map((f) => ({ ...f, turn: i + 1 })));
  const r = db.prepare(`INSERT INTO lab_runs(batch, case_id, case_version, version_id, lab_model_id, model, api, params, key_profile, prompt_hash, turns, status, error,
      input_tokens, cached_tokens, output_tokens, reasoning_tokens, usage_known, cost_usd, price_version, ms, flags, created, item_key)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    batch, kase.id, kase.version, version.id, model.id, model.model, api, JSON.stringify(params), profile?.name || null, promptHash,
    JSON.stringify(turnsOut), status, error,
    totals.known ? totals.input : null, totals.known ? totals.cached : null, totals.known ? totals.output : null, totals.known ? totals.reasoning : null,
    totals.known && turnsOut.length ? 1 : 0, costKnown && turnsOut.some((t) => t.usage) ? cost : null, model.price_version, ms, JSON.stringify(flags), now(),
    item?.key || null,
  );
  return { id: Number(r.lastInsertRowid), status, cost: costKnown ? cost : null };
}

// ---------- Оценка расхода до запуска ----------
function estimate({ caseIds, versionIds, modelIds, repeats = 1, itemKey = null }) {
  const item = getItem(itemKey);
  const cs = cases().filter((c) => caseIds.includes(c.id));
  const vs = versionIds.map((id) => db.prepare('SELECT * FROM agent_versions WHERE id = ?').get(Number(id))).filter(Boolean);
  const ms = models().filter((m) => modelIds.includes(m.id));
  let requests = 0;
  const perModel = {};
  for (const m of ms) perModel[m.id] = { label: m.label, requests: 0, low: 0, high: 0, priced: m.price_in != null && m.price_out != null };
  for (const c of cs) {
    const calls = c.turn_mode === 'consecutive_messages_one_response' ? 1 : c.client_turns.length;
    for (const v of vs) {
      // ~3 символа на токен для русского текста; история растёт с каждым ходом
      const promptTokens = Math.round(buildPrompt(v, c, [], item).length / 3);
      for (const m of ms) {
        for (let t = 0; t < calls; t++) {
          const input = promptTokens + t * 250;
          const low = (input * (m.price_in || 0) + 150 * (m.price_out || 0)) / 1e6;
          const high = (input * 1.3 * (m.price_in || 0) + 1200 * (m.price_out || 0)) / 1e6; // с запасом на reasoning
          perModel[m.id].requests += repeats; perModel[m.id].low += low * repeats; perModel[m.id].high += high * repeats;
          requests += repeats;
        }
      }
    }
  }
  const low = Object.values(perModel).reduce((a, x) => a + x.low, 0);
  const high = Object.values(perModel).reduce((a, x) => a + x.high, 0);
  const missingKeys = ms.filter((m) => !profileWithSecret(m.key_profile_id)?.api_key).map((m) => m.label);
  return { runs: cs.length * vs.length * ms.length * repeats, requests, low, high, perModel: Object.values(perModel), missingKeys };
}

// ---------- Пакетный прогон ----------
function start({ caseIds, versionIds, modelIds, repeats = 1, concurrency = 3, limitUsd, itemKey = null }, startJob, options = {}) {
  const est = estimate({ caseIds, versionIds, modelIds, repeats, itemKey });
  const item = getItem(itemKey);
  if (itemKey && !item) throw new Error('Автомобиль не найден в базе знаний');
  if (!est.runs) throw new Error('Выберите хотя бы один сценарий, стратегию и модель');
  if (est.missingKeys.length) throw new Error('Нет ключа у модели: ' + est.missingKeys.join(', ') + '. Настройки → Ключи и модели');
  const limit = Number(limitUsd);
  if (!(limit > 0)) throw new Error('Укажите лимит расхода в долларах');
  const cs = cases().filter((c) => caseIds.includes(c.id));
  const vs = versionIds.map((id) => db.prepare('SELECT * FROM agent_versions WHERE id = ?').get(Number(id))).filter(Boolean);
  const ms = models().filter((m) => modelIds.includes(m.id)).map(m => ({...m, ...(options.requestParams?.(m) || {})}));
  const tasks = [];
  for (let r = 0; r < repeats; r++) for (const c of cs) for (const v of vs) for (const m of ms) tasks.push({ kase: c, version: v, model: m });
  const batch = 'lab' + Date.now();
  return startJob('lab', async (job) => {
    job.total = tasks.length;
    job.batch = batch;
    job.models = ms.map(m => m.model);
    job.cost = 0;
    job.limit = limit;
    job.estimate = { low: est.low, high: est.high };
    let next = 0;
    const isStopped = () => job.stop;
    const worker = async () => {
      while (!job.stop && next < tasks.length) {
        const t = tasks[next++];
        const r = await runOne({ ...t, batch, isStopped, item });
        if (r.status === 'error') job.errors++;
        // неизвестный расход учитываем по верхней оценке, чтобы лимит не пробить
        job.cost += r.cost ?? (est.high / Math.max(1, est.runs));
        job.done++;
        if (job.cost >= limit && !job.stop) { job.stop = true; job.note = `Остановлено: достигнут лимит $${limit}`; }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(6, Number(concurrency) || 3)) }, worker));
    if (!job.note) job.note = job.stop ? 'Остановлено вручную: новые запросы не отправлялись, начатые сохранены' : 'Готово';
    logEvent('lab', `Прогон ${batch}: ${job.done} из ${job.total}, ошибок ${job.errors}, расход ~$${job.cost.toFixed(4)}`);
    return { batch };
  });
}

// ---------- Результаты и сводка ----------
const CRITERIA = ['completeness', 'accuracy', 'constraints', 'naturalness', 'next_step'];

function runs({ caseId, batch, limit = 500 } = {}) {
  const where = [];
  const args = [];
  if (caseId) { where.push('r.case_id = ?'); args.push(caseId); }
  if (batch) { where.push('r.batch = ?'); args.push(batch); }
  return db.prepare(`SELECT r.*, v.key AS v_key, v.version AS v_version, m.label AS model_label, i.title AS item_title FROM lab_runs r
      LEFT JOIN agent_versions v ON v.id = r.version_id LEFT JOIN lab_models m ON m.id = r.lab_model_id LEFT JOIN items i ON i.key = r.item_key
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC LIMIT ?`).all(...args, limit)
    .map((r) => ({ ...r, turns: JSON.parse(r.turns || '[]'), flags: JSON.parse(r.flags || '[]'), scores: r.scores ? JSON.parse(r.scores) : null, params: r.params ? JSON.parse(r.params) : null }));
}

function rate(id, b) {
  const scores = {};
  for (const k of CRITERIA) if (b.scores?.[k] != null && b.scores[k] !== '') scores[k] = Math.max(1, Math.min(5, Number(b.scores[k])));
  db.prepare('UPDATE lab_runs SET scores = ?, critical = ?, comment = ?, correction = ?, rated_at = ? WHERE id = ?').run(
    Object.keys(scores).length ? JSON.stringify(scores) : null, b.critical ? 1 : 0, b.comment || null, b.correction || null, now(), Number(id));
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };

/** Сводка по комбинациям «версия стратегии × модель». Разные версии — разные строки. */
function summary({ batch, set } = {}) {
  let list = runs({ batch, limit: 100000 });
  if (set) { const ids = new Set(cases().filter((c) => c.set_name === set).map((c) => c.id)); list = list.filter((r) => ids.has(r.case_id)); }
  const groups = {};
  for (const r of list) {
    const k = r.version_id + '|' + r.lab_model_id;
    (groups[k] ||= { version_id: r.version_id, v_key: r.v_key, v_version: r.v_version, lab_model_id: r.lab_model_id, model_label: r.model_label, model: r.model, rows: [] }).rows.push(r);
  }
  return Object.values(groups).map((g) => {
    const ok = g.rows.filter((r) => r.status === 'ok');
    const rated = g.rows.filter((r) => r.rated_at);
    const avg = {};
    for (const k of CRITERIA) { const v = rated.map((r) => r.scores?.[k]).filter((x) => x != null); avg[k] = v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; }
    const all = CRITERIA.map((k) => avg[k]).filter((x) => x != null);
    const known = g.rows.filter((r) => r.cost_usd != null);
    return {
      version_id: g.version_id, strategy: `${g.v_key} ${g.v_version}`, lab_model_id: g.lab_model_id, model: g.model_label || g.model,
      runs: g.rows.length, errors: g.rows.filter((r) => r.status === 'error').length, rated: rated.length,
      avg, overall: all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10 : null,
      criticalHuman: rated.filter((r) => r.critical).length,
      criticalAuto: g.rows.filter((r) => r.flags.some((f) => f.critical)).length,
      medianMs: median(ok.map((r) => r.ms)),
      inputTokens: ok.reduce((a, r) => a + (r.input_tokens || 0), 0),
      cachedTokens: ok.reduce((a, r) => a + (r.cached_tokens || 0), 0),
      outputTokens: ok.reduce((a, r) => a + (r.output_tokens || 0), 0),
      reasoningTokens: ok.reduce((a, r) => a + (r.reasoning_tokens || 0), 0),
      cost: known.reduce((a, r) => a + r.cost_usd, 0),
      costUnknown: g.rows.length - known.length,
      costPerRun: known.length ? known.reduce((a, r) => a + r.cost_usd, 0) / known.length : null,
    };
  }).sort((a, b) => (a.strategy + a.model).localeCompare(b.strategy + b.model));
}

/** Прогоны (пакеты) — последние сверху. */
function batches() {
  return db.prepare(`SELECT r.batch, MIN(r.created) created, COUNT(*) runs, COUNT(DISTINCT r.case_id) cases, SUM(r.status = 'error') errors, SUM(r.cost_usd) cost, MAX(i.title) item_title
    FROM lab_runs r LEFT JOIN items i ON i.key = r.item_key GROUP BY r.batch ORDER BY created DESC LIMIT 100`).all();
}

/** Ответы таблицей для Excel: одна строка — один ход одной комбинации. */
function exportCsv({ batch } = {}) {
  const cs = Object.fromEntries(cases().map((c) => [c.id, c]));
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Прогон', 'Дата', 'Вопрос', 'Название', 'Стратегия', 'Модель', 'Ход', 'Клиент', 'Ответ', 'Передать менеджеру', 'Промолчал', 'Время, с', 'Токены вход', 'Кэш', 'Выход', 'Reasoning', 'Стоимость прогона, $', 'Автопроверки', 'Оценки', 'Критично', 'Комментарий', 'Как надо'].map(esc).join(';')];
  for (const r of runs({ batch, limit: 100000 }).reverse()) {
    const turns = r.turns.length ? r.turns : [{ client: '', reply: r.error }];
    turns.forEach((t, i) => {
      lines.push([r.batch, new Date(r.created * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }), r.case_id, cs[r.case_id]?.title, `${r.v_key} ${r.v_version}`, r.model_label || r.model,
        i + 1, t.client, t.reply ?? ('ОШИБКА: ' + (t.error || r.error || '')), t.parsed?.handoff ? 'да' : '', t.parsed?.skip ? 'да' : '',
        t.ms ? (t.ms / 1000).toFixed(1) : '', t.usage?.input, t.usage?.cached, t.usage?.output, t.usage?.reasoning,
        i === 0 && r.cost_usd != null ? r.cost_usd.toFixed(6).replace('.', ',') : '', (t.flags || []).map((f) => f.text).join('; '),
        i === 0 && r.scores ? Object.entries(r.scores).map(([k, v]) => `${k}=${v}`).join(', ') : '', i === 0 && r.critical ? 'да' : '', i === 0 ? r.comment : '', i === 0 ? r.correction : ''].map(esc).join(';'));
    });
  }
  return '\ufeff' + lines.join('\n');
}

// ---------- Быстрый вопрос по реальной машине (сразу ответ; сохраняется как свой вопрос) ----------
async function ask({ itemKey, text, versionId, modelId }) {
  const turns = String(text || '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  if (!turns.length) throw new Error('Напишите вопрос клиента');
  const item = itemKey ? getItem(itemKey) : null;
  if (itemKey && !item) throw new Error('Автомобиль не найден в базе знаний');
  const version = versionId ? db.prepare('SELECT * FROM agent_versions WHERE id = ?').get(Number(versionId))
    : db.prepare("SELECT * FROM agent_versions WHERE key = 'simple' ORDER BY id DESC").get();
  const model = modelId ? models().find((m) => m.id === Number(modelId)) : models().find((m) => m.model === 'gpt-4o-mini');
  if (!version || !model) throw new Error('Нет стратегии или модели');
  if (!profileWithSecret(model.key_profile_id)?.api_key) throw new Error(`Нет ключа у ${model.label}: Настройки → Ключи и модели`);
  const id = 'ASK' + Date.now().toString(36).toUpperCase();
  const kase = { id, version: '1', title: turns[0].slice(0, 80), facts: {}, client_turns: turns, turn_mode: 'sequential_dialogue', expected: [] };
  db.prepare('INSERT INTO lab_cases(id, set_name, version, title, facts, client_turns, turn_mode, expected, created) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, 'custom', '1', kase.title, '{}', JSON.stringify(turns), kase.turn_mode, '[]', now());
  const r = await runOne({ kase, version, model, batch: 'ask' + Date.now(), isStopped: () => false, item });
  return runs({ caseId: id, limit: 1 })[0] || r;
}

// ---------- Пояснения владельца к вопросам (из них собираются факты салона для агента) ----------
/** Вопросы набора + последний ответ агента (предпочтительно «Простая» × GPT-4o mini) + пояснение владельца. */
function notes({ set = 'archive' } = {}) {
  const saved = Object.fromEntries(db.prepare('SELECT case_id, note, updated FROM lab_case_notes').all().map((n) => [n.case_id, n]));
  return cases().filter((c) => c.set_name === set).map((c) => {
    const ok = runs({ caseId: c.id, limit: 200 }).filter((r) => r.status === 'ok');
    const best = ok.find((r) => r.v_key === 'simple' && r.model === 'gpt-4o-mini') || ok[0] || null;
    return {
      id: c.id, title: c.title, client_turns: c.client_turns,
      answer: best ? { run_id: best.id, by: `${best.v_key} ${best.v_version} · ${best.model_label || best.model}`, created: best.created, turns: best.turns.map((t) => ({ client: t.client, reply: t.reply })) } : null,
      note: saved[c.id]?.note || '', note_updated: saved[c.id]?.updated || null,
    };
  });
}

function saveNote(caseId, note) {
  if (!db.prepare('SELECT 1 FROM lab_cases WHERE id = ?').get(String(caseId))) throw new Error('Вопрос не найден');
  db.prepare('INSERT INTO lab_case_notes(case_id, note, updated) VALUES(?,?,?) ON CONFLICT(case_id) DO UPDATE SET note = excluded.note, updated = excluded.updated')
    .run(String(caseId), String(note || '').slice(0, 20000), now());
}

/** Отчёт для Excel: вопрос, ответ агента, пояснение владельца. */
function notesCsv({ set = 'archive' } = {}) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['№', 'Вопрос', 'Сообщения клиента', 'Ответ агента', 'Кто ответил', 'Пояснение Павла'].map(esc).join(';')];
  for (const n of notes({ set })) {
    const answer = n.answer ? n.answer.turns.map((t) => (n.answer.turns.length > 1 ? `Клиент: ${t.client}\nАгент: ` : '') + (t.reply ?? '')).join('\n\n') : '';
    lines.push([n.id, n.title, n.client_turns.join(' / '), answer, n.answer?.by || '', n.note].map(esc).join(';'));
  }
  return '\ufeff' + lines.join('\n');
}

/** Профиль ключа для распознавания речи: ключ модели GPT-4o mini, иначе любой профиль OpenAI с ключом. */
function transcribeProfile() {
  const m = models().find((x) => x.model === 'gpt-4o-mini' && x.key_profile_id);
  const p = m && profileWithSecret(m.key_profile_id);
  if (p?.api_key && p.provider === 'openai') return p;
  return db.prepare("SELECT * FROM key_profiles WHERE provider = 'openai' AND api_key IS NOT NULL AND api_key != '' ORDER BY id").get() || null;
}

/** Экспорт: результаты + конфигурации + сценарии. Ключей в экспорте нет — только имена профилей. */
function exportAll({ batch } = {}) {
  return {
    exported: new Date().toISOString(),
    strategies: db.prepare('SELECT id, key, version, title, status, base_prompt, strategy FROM agent_versions').all(),
    models: models().map(({ key_profile_id, ...m }) => m),
    profiles: profiles().map(({ key_mask, ...p }) => p),
    cases: cases(),
    runs: runs({ batch, limit: 100000 }),
    summary: summary({ batch }),
  };
}

module.exports = { ask, notes, saveNote, notesCsv, transcribeProfile, batches, exportCsv, LAB_KEYS, profiles, profileWithSecret, models, strategies, cases, buildPrompt, checkTurn, runOne, estimate, start, runs, rate, summary, exportAll, CRITERIA, mask };
