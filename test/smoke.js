// Сквозная проверка на моках: node test/smoke.js
// Поднимает мок Авито/OpenAI и сервис с временной базой, прогоняет основные сценарии обучения агента.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MOCK_PORT = 4100 + Math.floor(Math.random() * 500);
const APP_PORT = MOCK_PORT + 1000;
process.env.MOCK_PORT = String(MOCK_PORT);
const mock = require('./mock-server');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avito-assistant-test-'));
const app = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'src', 'server.js')], {
  env: {
    ...process.env, PORT: String(APP_PORT), DATA_DIR: dataDir, ADMIN_PASSWORD: '',
    AVITO_API_BASE: `http://127.0.0.1:${MOCK_PORT}`, OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    AVITO_CLIENT_ID: 'id', AVITO_CLIENT_SECRET: 'secret', OPENAI_API_KEY: 'sk-test',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, OPENROUTER_API_KEY: 'sk-or-test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appLog = '';
app.stdout.on('data', (d) => (appLog += d));
app.stderr.on('data', (d) => (appLog += d));

const base = `http://127.0.0.1:${APP_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body, method) {
  const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
async function waitJob(type) {
  for (let i = 0; i < 600; i++) {
    const { data } = await api('/api/jobs');
    if (data[type] && !data[type].running) return data[type];
    await sleep(100);
  }
  throw new Error('job timeout ' + type);
}
const counters = async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__counters`)).json();

async function step(name, fn) {
  try { await fn(); console.log('✓', name); } catch (e) { console.log('✗', name); throw e; }
}

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/health'); break; } catch { await sleep(100); } }

  await step('статус: тестовый режим включён по умолчанию', async () => {
    const { data } = await api('/api/status');
    assert.equal(data.sendEnabled, false);
  });

  await step('подключение Авито', async () => {
    const { status, data } = await api('/api/avito/test', {});
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.userId, '111');
  });

  await step('объявления из API и фид автозагрузки', async () => {
    let r = await api('/api/items/import-api', {});
    assert.equal(r.data.count, 3);
    r = await api('/api/items/import-feed', {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.count, 3);
    assert.equal(r.data.mapped, 2);
    const { data } = await api('/api/items');
    assert.equal(data.items.length, 4);
    const card = await api('/api/items/9001');
    assert.match(card.data.card, /VIN: LGWEF4A5XRH000001/);
    assert.match(card.data.card, /Кредит от 4,9%/);
    assert.match(card.data.card, /Климат-контроль, Камера заднего вида/);
    assert.equal(card.data.item.source, 'api+feed');
    assert.equal(card.data.item.title, 'Haval Jolion 1.5 AMT, 2025', 'фид не перетирает название из Авито');
    assert.match(card.data.card, /НАЛИЧИЕ: В НАЛИЧИИ/, 'наличие из описания');
    const card2 = await api('/api/items/9002');
    assert.match(card2.data.card, /НАЛИЧИЕ: В ПУТИ/, 'наличие из поля фида');
    assert.doesNotMatch(card2.data.card, /Наличие: В пути/, 'поле не дублируется');
    const st = (await api('/api/items')).data.stats;
    assert.equal(st.in_stock, 1);
    assert.equal(st.in_transit, 1);
    let r2 = await api('/api/items/availability', { keys: ['9002'], value: 'in_stock' });
    assert.equal(r2.data.changed, 1);
    assert.match((await api('/api/items/9002')).data.card, /НАЛИЧИЕ: В НАЛИЧИИ/, 'ручная отметка важнее фида');
    await api('/api/items/import-feed', {});
    assert.match((await api('/api/items/9002')).data.card, /НАЛИЧИЕ: В НАЛИЧИИ/, 'ручная отметка переживает перезагрузку фида');
    await api('/api/items/availability', { keys: ['9002'], value: null });
    assert.match((await api('/api/items/9002')).data.card, /НАЛИЧИЕ: В ПУТИ/);
  });

  await step('загрузка всей истории (с добором по объявлениям после ограничения списка)', async () => {
    const r = await api('/api/archive/import', {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const job = await waitJob('import');
    assert.ok(!job.error, job.error);
    assert.equal(job.done, 260);
    const stats = (await api('/api/archive/stats')).data;
    assert.equal(stats.totalMessages, 3 * 150 + 257 * 4, 'все сообщения, включая длинные чаты');
    assert.equal(stats.loadedChats, 260);
    const again = await api('/api/archive/import', {});
    assert.equal(again.status, 200);
    const job2 = await waitJob('import');
    assert.equal(job2.messages, 0, 'повторная загрузка не дублирует сообщения');
  });

  await step('статистика менеджеров и выгрузка JSONL', async () => {
    const { data } = await api('/api/archive/stats');
    assert.equal(data.chats, 260);
    assert.equal(data.leads, 52);
    assert.equal(data.unanswered, 0);
    assert.ok(data.medianFirstResponse > 0);
    const jsonl = await (await fetch(base + '/api/archive/export.jsonl')).text();
    const lines = jsonl.trim().split('\n');
    assert.equal(lines.length, 260);
    const first = JSON.parse(lines[0]);
    assert.ok(first.messages.length > 0 && first.item.title);
    const leads = (await api('/api/leads?from=2000-01-01')).data.leads;
    assert.equal(leads.length, 52, 'телефоны из истории попадают в лиды');
    const events = (await api('/api/events?limit=500')).data.events;
    assert.ok(!events.some((e) => e.type === 'lead'), 'лиды из истории без уведомлений');
  });

  await step('база знаний и прогон агента по реальному чату', async () => {
    let r = await api('/api/kb', { category: 'faq', title: 'Есть трейд-ин?', content: 'Да, оценка бесплатно за 30 минут.' });
    assert.equal(r.status, 200);
    r = await api('/api/chats/u2i-chat-0/replay', { maxTurns: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.turns, 3);
    const chat = (await api('/api/chats/u2i-chat-0')).data;
    assert.equal(chat.runs.length, 3);
    assert.match(chat.runs[0].reply, /VIN LGWEF4A5XRH000001/, 'агент видит карточку из фида');
    assert.match(chat.runs[0].reply, /Трейд-ин/, 'агент видит базу знаний');
    const runs = (await api('/api/runs')).data;
    assert.ok(runs.runs[0].actual.includes('в наличии'), 'рядом показан ответ менеджера');
    // запись из разбора чатов — кандидат, агент её не видит до утверждения
    const cand = await api('/api/kb', { entries: [{ category: 'faq', title: 'Скидка?', content: 'Скидка 300 000 ₽ всем', source: 'analysis' }] });
    const sb1 = await api('/api/sandbox', { history: [{ direction: 'in', text: 'Какая скидка?' }] });
    assert.doesNotMatch(sb1.data.systemPrompt, /300 000/);
    await api(`/api/kb/${cand.data.ids[0]}/status`, { status: 'approved' });
    const sb2 = await api('/api/sandbox', { history: [{ direction: 'in', text: 'Какая скидка?' }] });
    assert.match(sb2.data.systemPrompt, /300 000/);
    await api(`/api/kb/${cand.data.ids[0]}`, null, 'DELETE');
    r = await api('/api/runs/' + chat.runs[0].id, { rating: -1, correction: 'Да, в наличии! Как к вам обращаться и удобно ли, если менеджер перезвонит?', addToKb: true });
    assert.ok(r.data.kbId);
    const kb = (await api('/api/kb')).data.entries;
    assert.ok(kb.some((e) => e.category === 'example' && e.source === 'correction'));
  });

  await step('массовый прогон по чатам', async () => {
    const r = await api('/api/replay-batch', { count: 5, maxTurns: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const job = await waitJob('replay');
    assert.equal(job.done, 5);
    assert.equal(job.errors, 0);
  });

  await step('разбор чатов нейросетью и сводный отчёт', async () => {
    const r = await api('/api/archive/review', { count: 5 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const job = await waitJob('review');
    assert.ok(!job.error, job.error);
    const { data } = await api('/api/archive/reports');
    assert.equal(data.reviews.length, 5);
    assert.ok(data.report.result.faq.length > 0);
    assert.equal(data.report.result.stats.n, 5);
  });

  await step('тестовый режим: ИИ включён, но в Авито ничего не уходит', async () => {
    await api('/api/ai', { enabled: true });
    const r = await api('/api/chats/u2i-chat-5/reply-now', {});
    assert.ok(r.data.draft, JSON.stringify(r.data));
    const send = await api('/api/chats/u2i-chat-5/send', { text: 'тест' });
    assert.equal(send.status, 400);
    const c = await counters();
    assert.equal(c.send, 0, 'в Авито ничего не отправлено');
    assert.equal(c.read, 0, 'чаты не отмечены прочитанными');
    const chat = (await api('/api/chats/u2i-chat-5')).data;
    assert.ok(chat.runs.some((x) => x.kind === 'shadow'));
  });

  await step('расходы Авито: списания, стоимость телефона, кандидаты на опротестование', async () => {
    const r = await api('/api/cpa/import', { days: 60 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const job = await waitJob('cpa');
    assert.ok(!job.error, job.error);
    assert.equal(job.result.chats, 54);
    assert.equal(job.result.calls, 1);
    const rep = (await api('/api/cpa/report')).data;
    assert.equal(rep.chats.n, 54);
    assert.equal(rep.withPhone, 52);
    assert.equal(rep.noPhoneCount, 2, 'длинные чаты без телефона оплачены впустую');
    assert.equal(rep.triggerSide['клиент'], 54);
    // в моке один и тот же номер в чатах 0, 80, 160, 240 и звонок с него
    assert.deepEqual(rep.contest.map((x) => x.chat_id).sort(), ['u2i-chat-0', 'u2i-chat-160', 'u2i-chat-240', 'u2i-chat-80'], 'звонок и чат одного покупателя');
    assert.ok(rep.costPerPhone > 0);
  });

  await step('несколько моделей отвечают параллельно', async () => {
    const models = ['gpt-4o-mini', 'openrouter:vendor/no-json', 'bad-model'];
    const r = await api('/api/chats/u2i-chat-1/replay', { maxTurns: 2, models });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.turns, 2);
    assert.equal(r.data.errors, 2, 'ошибка одной модели не ломает прогон');
    const chat = (await api('/api/chats/u2i-chat-1')).data;
    assert.equal(chat.runs.length, 6);
    const noJson = chat.runs.find((x) => x.model === 'openrouter:vendor/no-json');
    assert.equal(noJson.reply, 'Ответ без JSON-режима');
    assert.ok(chat.runs.find((x) => x.model === 'bad-model').comment.startsWith('Ошибка'));
    const runs = (await api('/api/runs?filter=replay')).data;
    const grp = runs.runs.filter((x) => x.chat_id === 'u2i-chat-1');
    assert.equal(grp.length, 6, 'группы содержат ответы всех моделей');
    assert.ok(runs.models.some((m) => m.model === 'openrouter:vendor/no-json' && m.avg_ms !== null));
    const sb = await api('/api/sandbox', { history: [{ direction: 'in', text: 'Привет' }], models: 'gpt-4o-mini, openrouter:vendor/no-json' });
    assert.equal(sb.data.variants.length, 2);
    assert.equal(sb.data.reply.length > 0, true);
  });

  await step('стратегии A/B/C: версии, прогон «версия × модель», старые ответы не удаляются', async () => {
    const v = (await api('/api/agent-versions')).data.versions;
    // решение владельца v0.3.0: A/B/C в архиве (история и прогон по id сохраняются), активны три стратегии лаборатории
    assert.deepEqual(v.filter((x) => x.status === 'archived').map((x) => x.key).sort(), ['A_direct', 'B_consultative', 'C_adaptive']);
    assert.deepEqual(v.filter((x) => x.status === 'active').map((x) => x.key).sort(), ['claude_independent', 'codex_business', 'codex_friendly']);
    const A = v.find((x) => x.key === 'A_direct'), C = v.find((x) => x.key === 'C_adaptive');
    const before = (await api('/api/chats/u2i-chat-3')).data.runs.length;
    const r = await api('/api/chats/u2i-chat-3/replay', { maxTurns: 1, configs: [{ versionId: A.id, model: 'gpt-4o-mini' }, { versionId: C.id, model: 'gpt-4o-mini' }] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.configs, ['A_direct v0.2.0 · gpt-4o-mini', 'C_adaptive v0.2.0 · gpt-4o-mini']);
    await api('/api/chats/u2i-chat-3/replay', { maxTurns: 1, configs: [{ versionId: A.id, model: 'gpt-4o-mini' }] });
    const runs = (await api('/api/chats/u2i-chat-3')).data.runs;
    assert.equal(runs.length, before + 3, 'повторный прогон добавляет, а не заменяет');
    const a = runs.filter((x) => x.agent_version_id === A.id);
    assert.equal(a.length, 2);
    assert.ok(a[0].prompt_hash && a[0].prompt_hash === a[1].prompt_hash, 'одинаковый промпт — одинаковый снимок');
    const list = (await api('/api/runs?filter=replay')).data;
    const grp = list.runs.filter((x) => x.chat_id === 'u2i-chat-3');
    assert.equal(grp.length, 2, 'в сравнении — последний ответ каждой конфигурации');
    assert.ok(list.models.some((m) => m.v_key === 'C_adaptive'));
    // новая версия с тем же номером запрещена
    const dup = await api('/api/agent-versions', { key: 'A_direct', version: 'v0.2.0', base_prompt: 'x' });
    assert.equal(dup.status, 400);
    const sb = await api('/api/sandbox', { history: [{ direction: 'in', text: 'Есть в наличии?' }], item: { id: 9001 }, versionId: A.id });
    assert.match(sb.data.systemPrompt, /Ярослав/);
    assert.match(sb.data.systemPrompt, /СТРАТЕГИЯ: уже в первом ответе/);
    assert.match(sb.data.systemPrompt, /СОСТОЯНИЕ ЧАТА: реплик 1, чат ещё не платный/);
  });

  await step('Лаборатория: 3 стратегии × 2 модели, отдельные ключи, расходы, изоляция', async () => {
    const cfg = (await api('/api/lab/config')).data;
    assert.deepEqual(cfg.strategies.map((x) => x.key), ['codex_business', 'codex_friendly', 'claude_independent'], 'ровно три активные стратегии');
    assert.deepEqual(cfg.models.map((x) => x.model), ['gpt-6-sol', 'gpt-6-luna', 'gpt-4o-mini']);
    assert.equal(cfg.cases.filter((c) => c.set_name === 'standard').length, 12);
    assert.equal(cfg.cases.filter((c) => c.set_name === 'faq').length, 20);
    const [sol, luna] = cfg.models;
    // без ключей прогон не запускается
    const noKey = await api('/api/lab/run', { caseIds: ['FAQ01'], versionIds: cfg.strategies.map((x) => x.id), modelIds: [sol.id], limitUsd: 1 });
    assert.equal(noKey.status, 400);
    // два профиля ключей: секрет не возвращается
    const p1 = (await api('/api/key-profiles', { name: 'Sol', provider: 'openai', api_key: 'sk-sol-test-1234' })).data.id;
    const p2 = (await api('/api/key-profiles', { name: 'Luna', provider: 'openai', api_key: 'sk-luna-test-5678' })).data.id;
    const prof = (await api('/api/key-profiles')).data.profiles;
    assert.ok(!JSON.stringify(prof).includes('sk-sol-test'), 'ключ не уходит в браузер');
    assert.equal(prof[0].key_mask, '••••1234');
    await api('/api/lab/models', { ...sol, key_profile_id: p1 });
    await api('/api/lab/models', { ...luna, key_profile_id: p2 });
    const before = { chats: (await api('/api/archive/stats')).data.totalChats, msgs: (await api('/api/archive/stats')).data.totalMessages, leads: (await api('/api/leads?from=2000-01-01')).data.leads.length, runs: (await api('/api/runs?filter=')).data.stats.total, c: await counters() };
    const sel = { caseIds: ['STD02', 'STD10', 'FAQ01'], versionIds: cfg.strategies.map((x) => x.id), modelIds: [sol.id, luna.id] };
    const est = (await api('/api/lab/estimate', sel)).data;
    assert.equal(est.runs, 18);
    assert.equal(est.requests, 6 * (1 + 3 + 1), 'STD02 — один ответ на две реплики, STD10 — три хода');
    assert.ok(est.low > 0 && est.high > est.low);
    const r = await api('/api/lab/run', { ...sel, limitUsd: 5, concurrency: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const job = await waitJob('lab');
    assert.equal(job.done, 18);
    assert.equal(job.errors, 0);
    const c = await counters();
    assert.equal(c.keys['gpt-6-sol'], 'Bearer sk-sol-test-1234', 'Sol — своим ключом');
    assert.equal(c.keys['gpt-6-luna'], 'Bearer sk-luna-test-5678', 'Luna — своим ключом');
    assert.equal(c.send, before.c.send, 'в Авито ничего не отправлено');
    assert.equal(c.read, before.c.read);
    const after = { chats: (await api('/api/archive/stats')).data.totalChats, msgs: (await api('/api/archive/stats')).data.totalMessages, leads: (await api('/api/leads?from=2000-01-01')).data.leads.length, runs: (await api('/api/runs?filter=')).data.stats.total };
    assert.deepEqual(after, { chats: before.chats, msgs: before.msgs, leads: before.leads, runs: before.runs }, 'рабочие чаты, лиды и черновики не тронуты');
    const runs = (await api('/api/lab/runs?case=STD10')).data.runs;
    assert.equal(runs.length, 6);
    for (const x of runs) {
      assert.equal(x.turns.length, 3, 'три хода диалога');
      assert.match(x.turns[0].reply, /Ярослав/);
      assert.doesNotMatch(x.turns[1].reply, /Ярослав/, 'во втором ходе своя история: уже представлялся');
      assert.ok(x.turns.every((t) => t.reply.includes(x.model)), 'в истории только свои ответы');
    }
    const solRun = runs.find((x) => x.model === 'gpt-6-sol');
    // 3 хода × (4000×$2 + 1000 кэш×$2 (цена кэша не задана) + 300×$10) / 1e6
    assert.ok(Math.abs(solRun.cost_usd - 0.039) < 1e-9, 'стоимость по usage: ' + solRun.cost_usd);
    assert.equal(solRun.input_tokens, 15000);
    assert.equal(solRun.cached_tokens, 3000);
    assert.equal(solRun.reasoning_tokens, 360);
    assert.equal(solRun.key_profile, 'Sol');
    // оценка и сводка по шести комбинациям
    await api(`/api/lab/runs/${solRun.id}/rate`, { scores: { completeness: 5, accuracy: 4, constraints: 5, naturalness: 4, next_step: 3 }, critical: false, comment: 'ок' });
    const sum = (await api('/api/lab/summary')).data.summary;
    assert.equal(sum.length, 6);
    const row = sum.find((x) => x.lab_model_id === sol.id && x.version_id === solRun.version_id);
    assert.equal(row.rated, 1);
    assert.equal(row.overall, 4.2);
    // все ответы сохраняются: список прогонов и выгрузка ответов для Excel
    const bl = (await api('/api/lab/batches')).data.batches;
    assert.equal(bl[0].runs, 18);
    const csv = await (await fetch(base + '/api/lab/export.csv?batch=' + bl[0].batch)).text();
    assert.equal((csv.match(/^"lab\d+"/gm) || []).length, 6 * (1 + 3 + 1), 'строка на каждый ход каждой комбинации');
    assert.ok(csv.includes('Ответ gpt-6-luna'), 'в выгрузке тексты ответов');
    // экспорт без ключей
    const exp = await (await fetch(base + '/api/lab/export.json')).text();
    assert.ok(!exp.includes('sk-sol-test') && !exp.includes('sk-luna-test'));
    // лимит расхода останавливает прогон; повтор не удаляет прошлые результаты
    await api('/api/lab/run', { caseIds: ['STD10'], versionIds: cfg.strategies.map((x) => x.id), modelIds: [sol.id], limitUsd: 0.05, concurrency: 1 });
    const job2 = await waitJob('lab');
    assert.ok(job2.done < 3 && /лимит/.test(job2.note), job2.note);
    assert.equal((await api('/api/lab/runs?case=STD10')).data.runs.length, 6 + job2.done);
    // ошибка модели сохраняется, остальные работают
    await api('/api/lab/models', { label: 'Сломанная', model: 'broken-model', api: 'responses', key_profile_id: p1, price_in: 1, price_out: 1 });
    const broken = (await api('/api/lab/config')).data.models.find((x) => x.model === 'broken-model');
    await api('/api/lab/run', { caseIds: ['FAQ01'], versionIds: [cfg.strategies[0].id], modelIds: [broken.id, luna.id], limitUsd: 1 });
    const job3 = await waitJob('lab');
    assert.equal(job3.errors, 1);
    const fr = (await api('/api/lab/runs?case=FAQ01')).data.runs.filter((x) => x.batch === job3.result.batch);
    assert.equal(fr.find((x) => x.model === 'broken-model').status, 'error');
    assert.equal(fr.find((x) => x.model === 'gpt-6-luna').status, 'ok');
    // модель без Responses API — автоматически через Chat Completions
    await api('/api/lab/models', { label: 'Только chat', model: 'no-responses-model', api: 'responses', key_profile_id: p2, price_in: 1, price_out: 1 });
    const nr = (await api('/api/lab/config')).data.models.find((x) => x.model === 'no-responses-model');
    await api('/api/lab/run', { caseIds: ['FAQ18'], versionIds: [cfg.strategies[2].id], modelIds: [nr.id], limitUsd: 1 });
    const job4 = await waitJob('lab');
    assert.equal(job4.errors, 0);
    const nrRun = (await api('/api/lab/runs?case=FAQ18')).data.runs[0];
    assert.equal(nrRun.api, 'chat');
    assert.equal(nrRun.cost_usd, null, 'нет разбивки usage — стоимость неизвестна, а не ноль');
    assert.equal(nrRun.usage_known, 0);
    // прогон на реальной машине из базы знаний
    const labCfg = (await api('/api/lab/config')).data;
    assert.ok(labCfg.items.some((i) => i.key === '9001'));
    assert.ok(!JSON.stringify(labCfg.cases).match(/[Уу]чебн/), 'в сценариях нет заглушек «учебный»');
    await api('/api/lab/run', { caseIds: ['FAQ01'], versionIds: [cfg.strategies[0].id], modelIds: [luna.id], limitUsd: 1, itemKey: '9001' });
    await waitJob('lab');
    const carRun = (await api('/api/lab/runs?case=FAQ01')).data.runs[0];
    assert.equal(carRun.item_title, 'Haval Jolion 1.5 AMT, 2025');
    // свой вопрос
    const cust = await api('/api/lab/case', { text: 'А зимняя резина в подарок?' });
    assert.ok(cust.data.id.startsWith('CUS'));
  });

  await step('песочница с автомобилем из базы', async () => {
    const r = await api('/api/sandbox', { history: [{ direction: 'in', text: 'Какой привод?' }], item: { id: 9002 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.systemPrompt, /Полный привод & панорама/);
    assert.match(r.data.systemPrompt, /ДРУГИЕ АВТОМОБИЛИ В ПРОДАЖЕ/);
  });

  console.log('\nВсе проверки пройдены');
})().catch((e) => {
  console.error(e);
  console.error('--- лог сервиса ---\n' + appLog.slice(-3000));
  process.exitCode = 1;
}).finally(() => {
  app.kill();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
