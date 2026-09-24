// Архив переписок: загрузка всей истории из Авито, статистика работы менеджеров,
// выгрузка для анализа, прогон агента по реальным чатам и разбор чатов нейросетью.
const { db, logEvent, getSetting } = require('./db');
const avito = require('./avito');
const agent = require('./agent');
const engine = require('./engine');
const chatstate = require('./chatstate');

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Фоновые задачи (одна задача каждого типа за раз) ----------
const jobs = {};

function jobState(type) {
  return jobs[type] || null;
}

function startJob(type, fn) {
  if (jobs[type]?.running) throw new Error('Задача уже выполняется');
  const job = { type, running: true, stop: false, done: 0, total: null, errors: 0, note: '', startedAt: now(), finishedAt: null, result: null };
  jobs[type] = job;
  fn(job)
    .then((result) => { job.result = result || null; })
    .catch((e) => { job.error = e.message; logEvent(type, 'Задача прервана: ' + e.message, null, 'error'); })
    .finally(() => { job.running = false; job.finishedAt = now(); });
  return job;
}

function stopJob(type) {
  if (jobs[type]?.running) jobs[type].stop = true;
}

// ---------- Загрузка всей истории ----------
async function importChatMessages(chatId, uid, maxMessages = 3000) {
  const all = [];
  for (let offset = 0; offset < maxMessages; offset += 100) {
    const page = await avito.getMessages(chatId, { limit: 100, offset });
    all.push(...page);
    if (page.length < 100) break;
    await sleep(150);
  }
  // Авито отдаёт от новых к старым
  const fresh = engine.storeMessages(chatId, all.slice().reverse(), uid);
  // телефон из истории: лид датой сообщения, без уведомлений
  if (fresh.length) engine.detectLead(chatId, 'из истории');
  db.prepare('UPDATE chats SET history_loaded = 1 WHERE id = ?').run(chatId);
  return fresh.length;
}

function importHistory({ maxChats = 100000 } = {}) {
  return startJob('import', async (job) => {
    const uid = await avito.userId();
    job.total = null;
    job.messages = 0;
    job.skipped = 0;
    const seen = new Set();
    const handle = async (c) => {
      if (seen.has(c.id)) return;
      seen.add(c.id);
      const stored = db.prepare('SELECT updated, history_loaded FROM chats WHERE id = ?').get(c.id);
      engine.upsertChat(c, uid);
      if (stored?.history_loaded && stored.updated >= (c.updated || 0)) { job.skipped++; job.done++; return; }
      try {
        job.messages += await importChatMessages(c.id, uid);
      } catch (e) {
        job.errors++;
        logEvent('import', `Чат не загружен: ${e.message}`, c.id, 'error');
      }
      job.done++;
      if (job.done % 200 === 0) logEvent('import', `Загрузка истории: чатов ${job.done}, новых сообщений ${job.messages}, ошибок ${job.errors}`);
      await sleep(150);
    };

    // 1) общий список чатов постранично
    let offset = 0;
    let listError = null;
    while (!job.stop && seen.size < maxChats) {
      let chats;
      try {
        chats = await avito.getChats({ limit: 100, offset, chatTypes: 'u2i,u2u' });
      } catch (e) {
        listError = e.message;
        break;
      }
      job.note = `Список чатов: ${offset + chats.length}`;
      for (const c of chats) {
        if (job.stop || seen.size >= maxChats) break;
        await handle(c);
      }
      if (chats.length < 100) break;
      offset += 100;
    }

    // 2) если Авито ограничил глубину списка — добираем чаты по каждому объявлению
    if (listError && !job.stop) {
      logEvent('import', `Список чатов оборвался на ${offset}: ${listError}. Добираю по объявлениям.`, null, 'warn');
      const items = db.prepare('SELECT avito_id FROM items WHERE avito_id IS NOT NULL').all().map((r) => r.avito_id);
      if (!items.length) job.note = 'Список чатов оборвался. Загрузите объявления (База знаний → Автомобили) и запустите ещё раз — остальные чаты доберутся по объявлениям.';
      const before = seen.size;
      let fallbackErrors = 0;
      // все чаты по списку объявлений; offset по одному объявлению тоже может упереться в предел — идём, пока отдаёт
      const byItems = async (ids) => {
        for (let off = 0; !job.stop; off += 100) {
          const chats = await avito.getChats({ limit: 100, offset: off, chatTypes: 'u2i', itemIds: ids });
          for (const c of chats) await handle(c);
          if (chats.length < 100) break;
        }
      };
      for (let i = 0; i < items.length && !job.stop; i += 20) {
        const batch = items.slice(i, i + 20);
        try {
          await byItems(batch.join(','));
        } catch (e) {
          // пачкой не вышло — по одному объявлению
          for (const id of batch) {
            if (job.stop) break;
            try { await byItems(String(id)); } catch (e2) {
              fallbackErrors++;
              if (fallbackErrors <= 3) logEvent('import', `Чаты по объявлению ${id} не получены: ${e2.message}`, null, 'warn');
            }
          }
        }
        job.note = `Добор по объявлениям: ${Math.min(i + 20, items.length)} из ${items.length}, найдено ещё ${seen.size - before} чатов`;
      }
      logEvent('import', `Добор по объявлениям: объявлений ${items.length}, найдено ещё чатов ${seen.size - before}, ошибок ${fallbackErrors}`);
    }
    if (!job.note.startsWith('Список чатов оборвался')) job.note = job.stop ? 'Остановлено' : 'Готово';
    const db1 = (sql) => db.prepare(sql).get().n;
    logEvent('import', `История загружена: чатов ${job.done} (без изменений ${job.skipped}), новых сообщений ${job.messages}, ошибок ${job.errors}. `
      + `В базе: чатов ${db1('SELECT COUNT(*) n FROM chats')}, сообщений ${db1('SELECT COUNT(*) n FROM messages')}, `
      + `чатов без сообщений ${db1('SELECT COUNT(*) n FROM chats c WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id)')}, `
      + `с ответом продавца ${db1("SELECT COUNT(DISTINCT chat_id) n FROM messages WHERE direction = 'out' AND source != 'system'")}`);
    return { chats: job.done, messages: job.messages, errors: job.errors };
  });
}

// ---------- Статистика работы менеджеров ----------
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2);
};

const mskHour = (ts) => (new Date(ts * 1000).getUTCHours() + 3) % 24;
const ASK_PHONE = /номер|телефон|позвон|созвон|whatsapp|ватсап|вотсап|телеграм|telegram/i;

const COHORT_DAYS = 7;

/**
 * Статистика продавцов по когорте: входящие чаты, где первое живое сообщение клиента
 * попало в период. Результат — телефон в течение 7 дней от этого сообщения.
 * Телефон до первого ответа продавца считается отдельно; чаты моложе 7 дней — «незрелые».
 */
function managerStats(from, to) {
  const chats = db.prepare(`SELECT c.* FROM chats c WHERE EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id)`).all();
  const msgStmt = db.prepare('SELECT id, direction, source, type, created, author_id, text FROM messages WHERE chat_id = ? ORDER BY created ASC, rowid ASC');
  const st = {
    chats: 0, mature: 0, answered: 0, unanswered: 0, leads: 0, leads7d: 0, leadsBeforeReply: 0, askedPhone: 0,
    firstResponse: [], firstResponseDay: [], firstResponseNight: [],
    within5: 0, within60: 0, lostAfterReply: 0, clientMsgs: 0, sellerMsgs: 0,
    billedEst: 0, billedNoPhone: 0, billedBy: {},
    outgoing: 0, outgoingLeads: 0, systemOnly: 0,
    months: {}, authors: {},
  };
  const cutoff = now() - COHORT_DAYS * 86400;
  for (const c of chats) {
    const msgs = msgStmt.all(c.id);
    const dir = chatstate.direction(msgs);
    const human = msgs.filter(chatstate.isHuman);
    const start = human[0];
    if (!start) { const t = msgs[0]?.created; if (t >= from && t <= to) st.systemOnly++; continue; }
    if (start.created < from || start.created > to) continue;
    const found = chatstate.findPhone(msgs);
    if (dir === 'outgoing') { st.outgoing++; if (found) st.outgoingLeads++; continue; }
    st.chats++;
    const mature = start.created <= cutoff;
    if (mature) st.mature++;
    const month = new Date((start.created + 3 * 3600) * 1000).toISOString().slice(0, 7);
    const mo = (st.months[month] ||= { chats: 0, mature: 0, answered: 0, leads: 0, fr: [] });
    mo.chats++;
    if (mature) mo.mature++;
    const sellerMsgs = human.filter(chatstate.isSeller);
    const reply = sellerMsgs.find((m) => m.created >= start.created);
    st.clientMsgs += human.filter(chatstate.isClient).length;
    st.sellerMsgs += sellerMsgs.length;
    for (const m of sellerMsgs) st.authors[m.author_id || '—'] = (st.authors[m.author_id || '—'] || 0) + 1;
    if (reply) {
      st.answered++;
      mo.answered++;
      const dt = reply.created - start.created;
      st.firstResponse.push(dt);
      mo.fr.push(dt);
      const h = mskHour(start.created);
      (h >= 9 && h < 21 ? st.firstResponseDay : st.firstResponseNight).push(dt);
      if (dt <= 300) st.within5++;
      if (dt <= 3600) st.within60++;
    } else {
      st.unanswered++;
    }
    if (sellerMsgs.some((m) => ASK_PHONE.test(m.text || ''))) st.askedPhone++;
    if (found) {
      st.leads++;
      if (!reply || found.at < reply.created) st.leadsBeforeReply++;
      else if (mature && found.at - start.created <= COHORT_DAYS * 86400) { st.leads7d++; mo.leads++; }
    }
    const cpa = chatstate.cpaState(msgs);
    if (cpa.billed) {
      st.billedEst++;
      st.billedBy[cpa.trigger.label] = (st.billedBy[cpa.trigger.label] || 0) + 1;
      if (!found) st.billedNoPhone++;
    }
    const last = human[human.length - 1];
    if (reply && !found && last && chatstate.isSeller(last)) st.lostAfterReply++;
  }
  const pct = (a, b = st.chats) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  // знаменатель когортной конверсии: зрелые чаты без телефона до ответа
  const cohortBase = Math.max(0, st.mature - st.leadsBeforeReply);
  return {
    cohortDays: COHORT_DAYS,
    chats: st.chats,
    mature: st.mature,
    immature: st.chats - st.mature,
    answered: st.answered,
    unanswered: st.unanswered,
    leads: st.leads,
    leads7d: st.leads7d,
    leadsBeforeReply: st.leadsBeforeReply,
    cohortBase,
    conversion: pct(st.leads7d, cohortBase),
    askedPhonePct: pct(st.askedPhone),
    medianFirstResponse: median(st.firstResponse),
    medianFirstResponseDay: median(st.firstResponseDay),
    medianFirstResponseNight: median(st.firstResponseNight),
    within5Pct: pct(st.within5, st.answered),
    within60Pct: pct(st.within60, st.answered),
    lostAfterReply: st.lostAfterReply,
    billedEst: st.billedEst,
    billedNoPhone: st.billedNoPhone,
    billedBy: Object.entries(st.billedBy).map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n),
    outgoing: st.outgoing,
    outgoingLeads: st.outgoingLeads,
    systemOnly: st.systemOnly,
    avgClientMsgs: st.chats ? Math.round((st.clientMsgs / st.chats) * 10) / 10 : 0,
    avgSellerMsgs: st.chats ? Math.round((st.sellerMsgs / st.chats) * 10) / 10 : 0,
    authors: Object.entries(st.authors).map(([id, n]) => ({ id, messages: n })).sort((a, b) => b.messages - a.messages),
    months: Object.entries(st.months).sort().map(([month, m]) => ({
      month, chats: m.chats, mature: m.mature, answered: m.answered, leads: m.leads,
      conversion: m.mature ? Math.round((m.leads / m.mature) * 1000) / 10 : null, medianFirstResponse: median(m.fr),
    })),
    totalMessages: db.prepare('SELECT COUNT(*) n FROM messages').get().n,
    totalChats: db.prepare('SELECT COUNT(*) n FROM chats').get().n,
    loadedChats: db.prepare('SELECT COUNT(*) n FROM chats WHERE history_loaded = 1').get().n,
  };
}

/** Пересчитать телефоны по всей базе новым распознаванием (номера с точками, разбитые на два сообщения). */
function recountLeads() {
  const ids = db.prepare('SELECT id FROM chats WHERE phone IS NULL').all().map((r) => r.id);
  let found = 0;
  for (const id of ids) {
    const msgs = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created ASC, rowid ASC').all(id);
    const f = chatstate.findPhone(msgs);
    if (f && engine.markLead(id, f.phone, 'пересчёт', { at: f.at || now(), silent: true })) found++;
  }
  logEvent('import', `Пересчёт телефонов: проверено чатов ${ids.length}, найдено новых номеров ${found}`);
  return { checked: ids.length, found };
}

// ---------- Выгрузка для анализа (формат как у avito-raw-export: одна строка — один диалог) ----------
const ROLE = { client: 'client', manager: 'seller', bot: 'bot', quick: 'bot', template: 'bot', system: 'avito' };

function* exportJsonl(from, to) {
  const chats = db.prepare('SELECT * FROM chats WHERE COALESCE(created, updated) BETWEEN ? AND ? ORDER BY created').all(from, to);
  const msgStmt = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created ASC, rowid ASC');
  for (const c of chats) {
    const messages = msgStmt.all(c.id).filter((m) => m.text).map((m) => ({
      at: new Date(m.created * 1000).toISOString(), role: ROLE[m.source] || (m.direction === 'in' ? 'client' : 'seller'), type: m.type, text: m.text,
    }));
    if (!messages.length) continue;
    yield JSON.stringify({
      chat_id: c.id, chat_type: c.chat_type, url: `https://www.avito.ru/profile/messenger/channel/${c.id}`,
      item: c.item_title ? { id: c.item_id, title: c.item_title, price: c.item_price, url: c.item_url } : null,
      client_name: c.client_name, phone: c.phone, lead_at: c.lead_at ? new Date(c.lead_at * 1000).toISOString() : null,
      messages,
    }) + '\n';
  }
}

// ---------- Прогон агента по реальному чату ----------
/** Точки ответа: последнее сообщение каждой серии сообщений клиента. */
function replyPoints(messages) {
  const points = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.source !== 'client' || !m.text || /^\[(Звонок|Пропущенный звонок|Сообщение удалено)\]/.test(m.text)) continue;
    const next = messages.slice(i + 1).find((x) => x.source !== 'system');
    if (next && next.source === 'client') continue; // клиент дописывает — ждём конца серии
    points.push(m);
  }
  return points;
}

/** Сгенерировать ответы агента на каждую реплику клиента, не отправляя их. */
/**
 * Конфигурации для прогона: [{versionId, model}]. Переданные, иначе из настроек compare_configs,
 * иначе список моделей compare_models с правилами из настроек, иначе основная модель.
 */
function resolveConfigs({ configs, models } = {}) {
  if (configs?.length) return configs;
  if (models?.length) return models.map((model) => ({ versionId: null, model }));
  try {
    const saved = JSON.parse(getSetting('compare_configs') || '[]');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch { /* ignore */ }
  const cm = agent.compareModels();
  return cm.length ? cm.map((model) => ({ versionId: null, model })) : [{ versionId: null, model: null }];
}

/** Сгенерировать ответы агента на каждую реплику клиента, не отправляя их. Прежние ответы не удаляются. */
async function replayChat(chatId, { maxTurns = 8, batch = null, models = null, configs = null } = {}) {
  const list = resolveConfigs({ configs, models });
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat) throw new Error('Чат не найден');
  const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created ASC, rowid ASC').all(chatId);
  const points = replyPoints(messages).slice(0, maxTurns);
  let tokens = 0;
  let errors = 0;
  for (const p of points) {
    const idx = messages.indexOf(p);
    const history = messages.slice(0, idx + 1);
    const ctx = {
      item: chat.item_title || chat.item_id ? { id: chat.item_id, title: chat.item_title, price: chat.item_price, url: chat.item_url } : null,
      phone: chatstate.findPhone(history)?.phone || null,
      history,
    };
    // все конфигурации отвечают на одно и то же сообщение одновременно
    const results = await Promise.allSettled(list.map((c) => agent.generateReply(ctx, { model: c.model || undefined, versionId: c.versionId || null })));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        tokens += r.value.usage?.total_tokens || 0;
        engine.saveRun(chatId, 'replay', p, r.value, { batch });
      } else {
        errors++;
        engine.saveRun(chatId, 'replay', p, { model: list[i].model || getSetting('openai_model'), reply: '' },
          { batch, versionId: list[i].versionId || null, comment: 'Ошибка: ' + r.reason.message.slice(0, 300) });
      }
    });
    if (errors && errors === results.length * (points.indexOf(p) + 1)) throw new Error(results[0].reason.message);
  }
  return { turns: points.length, tokens, configs: list.map((c) => agent.configLabel(agent.getVersion(c.versionId), c.model)), models: list.map((c) => c.model).filter(Boolean), errors };
}

function pickChats({ count = 10, onlyWithSeller = true, onlyLeads = false, order = 'recent', exclude = '' } = {}) {
  const where = ["EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.source = 'client')"];
  if (onlyWithSeller) where.push("EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.direction = 'out' AND m.source != 'system')");
  if (onlyLeads) where.push('c.phone IS NOT NULL');
  if (exclude === 'replayed') where.push("NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.chat_id = c.id AND r.kind = 'replay')");
  if (exclude === 'reviewed') where.push('NOT EXISTS (SELECT 1 FROM chat_reviews r WHERE r.chat_id = c.id)');
  const orderBy = order === 'random' ? 'RANDOM()' : 'COALESCE(c.last_at, c.updated) DESC';
  return db.prepare(`SELECT c.id FROM chats c WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ?`).all(Math.min(200, count)).map((r) => r.id);
}

function replayBatch(opts = {}) {
  const ids = pickChats({ ...opts, exclude: opts.skipDone ? 'replayed' : '' });
  if (!ids.length) throw new Error('Нет подходящих чатов. Сначала загрузите историю (Архив → «Загрузить всю историю»).');
  const batch = 'b' + now();
  return startJob('replay', async (job) => {
    job.total = ids.length;
    job.tokens = 0;
    for (const id of ids) {
      if (job.stop) break;
      try {
        const r = await replayChat(id, { maxTurns: Number(opts.maxTurns) || 4, batch, models: opts.models, configs: opts.configs });
        job.tokens += r.tokens;
      } catch (e) {
        job.errors++;
        logEvent('replay', e.message, id, 'error');
        if (/OpenAI|OpenRouter|ключ/.test(e.message) && job.errors >= 3) throw e;
      }
      job.done++;
    }
    job.note = job.stop ? 'Остановлено' : 'Готово';
    return { batch };
  });
}

// ---------- Разбор чатов нейросетью ----------
async function reviewChat(chatId) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat) throw new Error('Чат не найден');
  const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created ASC, rowid ASC').all(chatId);
  const { result, usage, model } = await agent.analyzeChat({ chat, messages });
  db.prepare(`INSERT INTO chat_reviews(chat_id, score, outcome, result, model, tokens, created) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET score = excluded.score, outcome = excluded.outcome, result = excluded.result, model = excluded.model, tokens = excluded.tokens, created = excluded.created`)
    .run(chatId, Number(result.score) || null, result.outcome || null, JSON.stringify(result), model, usage?.total_tokens || null, now());
  return { result, tokens: usage?.total_tokens || 0 };
}

async function buildReport(limit = 200) {
  const rows = db.prepare('SELECT * FROM chat_reviews ORDER BY created DESC LIMIT ?').all(limit);
  if (!rows.length) throw new Error('Нет разобранных чатов');
  const reviews = rows.map((r) => ({ chat_id: r.chat_id, result: JSON.parse(r.result || '{}') }));
  const { result, model } = await agent.summarizeReviews(reviews);
  const stats = {
    n: rows.length,
    avgScore: Math.round((rows.reduce((a, r) => a + (r.score || 0), 0) / rows.length) * 10) / 10,
    outcomes: rows.reduce((a, r) => { a[r.outcome || 'other'] = (a[r.outcome || 'other'] || 0) + 1; return a; }, {}),
  };
  const id = db.prepare('INSERT INTO reports(n_chats, result, model, created) VALUES(?,?,?,?)')
    .run(rows.length, JSON.stringify({ ...result, stats }), model, now()).lastInsertRowid;
  return { id: Number(id), ...result, stats };
}

function reviewBatch(opts = {}) {
  const ids = pickChats({ ...opts, exclude: 'reviewed' });
  if (!ids.length) throw new Error('Нет неразобранных чатов с перепиской. Загрузите историю или увеличьте выборку.');
  return startJob('review', async (job) => {
    job.total = ids.length;
    job.tokens = 0;
    for (const id of ids) {
      if (job.stop) break;
      try {
        job.tokens += (await reviewChat(id)).tokens;
      } catch (e) {
        job.errors++;
        logEvent('review', e.message, id, 'error');
        if (/OpenAI|OpenRouter|ключ/.test(e.message) && job.errors >= 3) throw e;
      }
      job.done++;
    }
    job.note = 'Собираю сводный отчёт…';
    const report = await buildReport();
    job.note = job.stop ? 'Остановлено, отчёт собран' : 'Готово';
    return { reportId: report.id };
  });
}

module.exports = {
  jobState, stopJob, startJob, importHistory, managerStats, recountLeads, exportJsonl, replayChat, replayBatch, replyPoints,
  reviewChat, reviewBatch, buildReport,
};
