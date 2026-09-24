// Расходы Авито на целевые действия: загрузка фактических списаний (API CPA, только чтение)
// и отчёт: что стоило денег, на каком сообщении сработало, что можно опротестовать.
const { db, logEvent } = require('./db');
const avito = require('./avito');
const chatstate = require('./chatstate');

const now = () => Math.floor(Date.now() / 1000);
const toTs = (s) => (s ? Math.floor(Date.parse(s) / 1000) || null : null);

const upsert = db.prepare(`
INSERT INTO cpa_actions(id, kind, chat_id, message_id, message, contact_type, target_type, price, status, arbitrage,
  buyer_id, buyer_phone, item_id, item_title, duration, created, raw, synced_at)
VALUES(:id, :kind, :chat_id, :message_id, :message, :contact_type, :target_type, :price, :status, :arbitrage,
  :buyer_id, :buyer_phone, :item_id, :item_title, :duration, :created, :raw, :synced_at)
ON CONFLICT(id) DO UPDATE SET status = excluded.status, arbitrage = excluded.arbitrage, price = excluded.price, raw = excluded.raw, synced_at = excluded.synced_at
`);

/** Загрузить списания с даты (по умолчанию 60 дней). job — объект фоновой задачи для прогресса. */
async function importCpa({ days = 60, calls = true } = {}, job = {}) {
  const from = new Date(Date.now() - days * 86400_000).toISOString().replace(/\.\d+Z$/, 'Z');
  job.note = 'Загружаю целевые чаты…';
  const chats = await avito.cpaChats(from);
  for (const x of chats) {
    const c = x.chat || {};
    upsert.run({
      id: 'chat:' + c.actionId, kind: 'chat', chat_id: c.channelId || null, message_id: c.messageId || null, message: c.message || null,
      contact_type: c.contactType || null, target_type: c.targetChatType || null, price: c.pricePenny ?? null, status: c.status || null,
      arbitrage: x.isArbitrageAvailable ? 1 : 0, buyer_id: x.buyer?.buyerId ?? null, buyer_phone: null,
      item_id: x.item?.itemId ?? null, item_title: x.item?.title || null, duration: null, created: toTs(c.date), raw: JSON.stringify(x), synced_at: now(),
    });
  }
  job.done = chats.length;
  let callList = [];
  let callsError = null;
  if (calls) {
    job.note = 'Загружаю целевые звонки (Авито отдаёт 100 звонков в минуту)…';
    try {
      callList = await avito.cpaCalls(from, { onWait: (n) => { job.note = `Звонков загружено ${n}, жду минуту (ограничение Авито)…`; } });
    } catch (e) {
      callsError = e.message;
    }
    for (const c of callList) {
      upsert.run({
        id: 'call:' + c.id, kind: 'call', chat_id: null, message_id: null, message: null, contact_type: null,
        target_type: c.groupTitle || null, price: c.price ?? null, status: String(c.statusId ?? ''),
        arbitrage: c.isArbitrageAvailable ? 1 : 0, buyer_id: null, buyer_phone: chatstate.normalizePhone(c.buyerPhone || '') || c.buyerPhone || null,
        item_id: c.itemId ?? null, item_title: null, duration: c.duration ?? null, created: toTs(c.startTime || c.createTime), raw: JSON.stringify(c), synced_at: now(),
      });
    }
  }
  let balance = null;
  try { balance = (await avito.cpaBalance()).balance ?? null; } catch { /* лимит 1 запрос в минуту — не критично */ }
  logEvent('cpa', `Списания Авито загружены за ${days} дн.: чатов ${chats.length}, звонков ${callList.length}${callsError ? ' (звонки: ' + callsError + ')' : ''}`);
  job.note = callsError ? 'Чаты загружены, звонки — ошибка: ' + callsError : 'Готово';
  return { chats: chats.length, calls: callList.length, callsError, balance };
}

const CALL_STATUS = { 0: 'целевой', 1: 'на модерации', 2: 'целевой после модерации', 3: 'нецелевой после модерации' };

/** Отчёт по списаниям за период. */
function report(from, to) {
  const rows = db.prepare('SELECT * FROM cpa_actions WHERE created BETWEEN ? AND ? ORDER BY created DESC').all(from, to);
  const chats = rows.filter((r) => r.kind === 'chat');
  const calls = rows.filter((r) => r.kind === 'call');
  const sum = (list) => list.reduce((a, r) => a + (r.price || 0), 0);
  const group = (list, key) => Object.entries(list.reduce((a, r) => { const k = r[key] || '—'; (a[k] ||= []).push(r); return a; }, {}))
    .map(([k, l]) => ({ key: k, n: l.length, sum: sum(l) })).sort((a, b) => b.n - a.n);

  const chatRow = db.prepare('SELECT id, phone, client_name, item_title FROM chats WHERE id = ?');
  const msgsOf = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created ASC, rowid ASC');
  let inDb = 0, withPhone = 0, estAgree = 0, bySide = { клиент: 0, продавец: 0, 'не найдено': 0 };
  const noPhone = [];
  for (const r of chats) {
    const c = r.chat_id ? chatRow.get(r.chat_id) : null;
    if (!c) continue;
    inDb++;
    const msgs = msgsOf.all(c.id);
    const found = c.phone || chatstate.findPhone(msgs)?.phone;
    if (found) withPhone++;
    else noPhone.push({ id: r.id, chat_id: c.id, client_name: c.client_name, item_title: c.item_title, price: r.price, target_type: r.target_type, message: r.message, created: r.created, arbitrage: r.arbitrage });
    if (chatstate.cpaState(msgs).billed) estAgree++;
    const m = r.message_id ? msgs.find((x) => x.id === r.message_id) : null;
    bySide[m ? (m.direction === 'in' ? 'клиент' : 'продавец') : 'не найдено']++;
  }

  // звонок и чат одного покупателя с разницей меньше 30 дней — можно опротестовать (п. 3.5), срок жалобы 7 дней (п. 3.9)
  const contest = [];
  for (const r of chats) {
    const c = r.chat_id ? chatRow.get(r.chat_id) : null;
    if (!c?.phone) continue;
    const call = calls.find((x) => x.buyer_phone === c.phone && Math.abs((x.created || 0) - (r.created || 0)) < 30 * 86400);
    if (call) {
      contest.push({ id: r.id, chat_id: c.id, client_name: c.client_name, phone: c.phone, chat_price: r.price, call_price: call.price,
        chat_at: r.created, call_at: call.created, arbitrage: r.arbitrage, deadlinePassed: now() - (r.created || 0) > 7 * 86400 });
    }
  }

  return {
    chats: { n: chats.length, sum: sum(chats), byTarget: group(chats, 'target_type'), byContact: group(chats, 'contact_type'), byStatus: group(chats, 'status') },
    calls: { n: calls.length, sum: sum(calls), byStatus: group(calls.map((c) => ({ ...c, st: CALL_STATUS[c.status] || c.status })), 'st'),
      avgDuration: calls.length ? Math.round(calls.reduce((a, c) => a + (c.duration || 0), 0) / calls.length) : null },
    total: sum(rows),
    inDb, withPhone, noPhoneCount: inDb - withPhone,
    costPerPhone: withPhone ? Math.round(sum(chats) / withPhone) : null,
    estimateAgreement: inDb ? Math.round((estAgree / inDb) * 100) : null,
    triggerSide: bySide,
    noPhone: noPhone.slice(0, 100),
    contest,
    lastSync: db.prepare('SELECT MAX(synced_at) t FROM cpa_actions').get().t,
  };
}

module.exports = { importCpa, report };
