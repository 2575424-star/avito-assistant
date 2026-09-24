// Состояние чата по переписке: телефон клиента, направление чата и признаки
// целевого (платного) чата по правилам Авито (п. 3.1, категория «Новые автомобили»).
// Сообщения: [{id, direction:'in'|'out', source:'client'|'manager'|'bot'|'quick'|'template'|'system', type, text, created}]

// ---------- Телефон ----------
// Номер ищем как непрерывный кусок из цифр и разделителей (пробел, дефис, тире, точка,
// скобки, подчёркивание), в котором 10–11 цифр: клиенты пишут группами 3-3-2-2, 3-2-2-3, слитно и т.д.
const PHONE_RUN_RE = /\+?[\d(][\d\s\-–—.()_]{8,22}\d/g;
const MONEY_RE = /₽|руб|р\.|тыс|млн|\bт\.?р\b|%/i;

function normalizePhone(raw) {
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 10 && d[0] === '9') d = '7' + d;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length !== 11 || d[0] !== '7' || d[1] !== '9') return null; // только мобильные РФ
  return '+' + d;
}

function phoneInText(text) {
  const t = String(text || '');
  let m;
  PHONE_RUN_RE.lastIndex = 0;
  while ((m = PHONE_RUN_RE.exec(t))) {
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 6);
    if (MONEY_RE.test(after)) continue; // «2 450 000 руб» — не телефон
    const p = normalizePhone(m[0]);
    if (p) return p;
  }
  return null;
}

const isClient = (m) => m.direction === 'in' && m.source !== 'system' && m.type !== 'system';
const isSeller = (m) => m.direction === 'out' && m.source !== 'system' && m.type !== 'system';
const isHuman = (m) => (isClient(m) || isSeller(m)) && String(m.text || '').trim() && !/^\[Сообщение удалено\]$/.test(m.text);

/**
 * Первый телефон клиента в переписке. Учитывает номер, разбитый на два соседних
 * сообщения клиента («8 915 123» + «45 67»), но не склеивает суммы и цены.
 * @returns {{phone, messageIds, at}|null}
 */
function findPhone(messages) {
  const list = messages.filter(isClient);
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const p = phoneInText(m.text);
    if (p) return { phone: p, messageIds: [m.id], at: m.created };
    const next = list[i + 1];
    if (!next) continue;
    // соседние сообщения клиента без ответа продавца между ними
    const between = messages.slice(messages.indexOf(m) + 1, messages.indexOf(next)).some(isSeller);
    if (between || MONEY_RE.test(m.text) || MONEY_RE.test(next.text)) continue;
    const a = String(m.text).replace(/\D/g, '');
    const b = String(next.text).replace(/\D/g, '');
    // каждая часть — в основном цифры, вместе 10–11 цифр
    const mostlyDigits = (t) => String(t).replace(/[\s\-–—.()+]/g, '').length <= String(t).replace(/\D/g, '').length + 25;
    if (a.length >= 3 && b.length >= 2 && a.length + b.length >= 10 && a.length + b.length <= 11 && mostlyDigits(m.text) && mostlyDigits(next.text)) {
      const joined = normalizePhone(a + b);
      if (joined) return { phone: joined, messageIds: [m.id, next.id], at: next.created };
    }
  }
  return null;
}

// ---------- Направление ----------
/** Кто начал живую переписку: 'incoming' (клиент), 'outgoing' (продавец), 'system' (только уведомления Авито). */
function direction(messages) {
  const first = messages.find(isHuman);
  if (!first) return 'system';
  return isClient(first) ? 'incoming' : 'outgoing';
}

// ---------- Признаки целевого чата (п. 3.1) ----------
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const MESSENGER_RE = /(t\.me|wa\.me|telegram\.me|vk\.com|ok\.ru)\/\S+|(^|\s)@[a-z0-9_]{4,}/i;
const ADDRESS_RE = /\b(ул\.|улица|проспект|пр-т|пр\.|шоссе|переулок|пер\.|бульвар|набережная)\s*[А-ЯЁA-Z0-9]|\bадрес\b[^?]{0,15}:|находимся (по адресу|на|в)\b/i;
const HOURS_RE = /(работаем|часы работы|режим работы|график работы|открыты)[^.?!]{0,40}(\d{1,2}[:.]?\d{0,2}|ежедневно|без выходных|круглосуточно)|\bс\s?\d{1,2}([:.]\d{2})?\s?до\s?\d{1,2}([:.]\d{2})?\b/i;
const LINK_RE = /(https?:\/\/|www\.)(?!(www\.|m\.)?avito\.ru)\S+/i;
const PREPAY_RE = /предоплат|задат(о|к)|внести аванс|авансом|оплатить заранее/i;

const TRIGGER_RU = {
  contact: 'контакт в чате',
  address: 'адрес или часы работы',
  turns: '5 реплик',
  link: 'ссылка не на Авито',
  media: 'файл или фото',
  prepay: 'разговор о предоплате',
};

/**
 * Оценка платности чата по тексту. Настоящий факт списания — в журнале CPA Авито.
 * @returns {{turns, billed, trigger:{kind,label,messageId,at}|null, clientTurns}}
 */
function cpaState(messages) {
  let turns = 0;
  let clientTurns = 0;
  let prev = null;
  let trigger = null;
  const hit = (kind, m) => { if (!trigger) trigger = { kind, label: TRIGGER_RU[kind], messageId: m.id, at: m.created }; };
  for (const m of messages) {
    if (!isHuman(m)) continue;
    const side = isClient(m) ? 'client' : 'seller';
    if (side !== prev) { turns++; if (side === 'client') clientTurns++; prev = side; }
    const t = String(m.text || '');
    if (phoneInText(t) || EMAIL_RE.test(t) || MESSENGER_RE.test(t)) hit('contact', m);
    else if (ADDRESS_RE.test(t) || HOURS_RE.test(t)) hit('address', m);
    else if (side === 'seller' && LINK_RE.test(t)) hit('link', m);
    else if (side === 'seller' && (m.type === 'image' || m.type === 'file')) hit('media', m);
    else if (PREPAY_RE.test(t)) hit('prepay', m);
    else if (turns >= 5) hit('turns', m);
  }
  // номер, разбитый на два сообщения, — тоже контакт
  if (!trigger) {
    const p = findPhone(messages);
    if (p) trigger = { kind: 'contact', label: TRIGGER_RU.contact, messageId: p.messageIds[p.messageIds.length - 1], at: p.at };
  }
  return { turns, clientTurns, billed: Boolean(trigger), trigger };
}

/** Текст для промпта агента: сколько реплик и платный ли уже чат. */
function cpaPromptLine(state) {
  if (state.billed) {
    return `СОСТОЯНИЕ ЧАТА: реплик ${state.turns}; чат уже платный (${state.trigger.label}) — дальнейшая переписка денег не стоит, отвечай свободно и доводи до контакта.`;
  }
  const left = Math.max(0, 5 - state.turns);
  return `СОСТОЯНИЕ ЧАТА: реплик ${state.turns}, чат ещё не платный. Твой ответ станет репликой №${state.turns + 1}${left <= 1 ? ' — на 5-й реплике чат станет платным' : ''}. Не отправляй сам адрес, часы работы, ссылки и контакты, если клиент о них не спросил.${state.clientTurns >= 2 ? ' Пора предложить конкретный шаг и попросить номер телефона.' : ''}`;
}

module.exports = { normalizePhone, phoneInText, findPhone, direction, cpaState, cpaPromptLine, TRIGGER_RU, isClient, isSeller, isHuman };
