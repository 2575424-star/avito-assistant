// Мок Авито API и OpenAI для локальной проверки без реальных ключей.
// Запуск: node test/mock-server.js  (порт MOCK_PORT, по умолчанию 4000)
const http = require('node:http');

const PORT = Number(process.env.MOCK_PORT || 4000);
const UID = 111;
const BASE_TS = Math.floor(Date.now() / 1000) - 40 * 86400;
const CHAT_LIST_CAP = 200; // имитация ограничения глубины списка чатов

const ITEMS = [
  { id: 9001, title: 'Haval Jolion 1.5 AMT, 2025', price: 2199000, status: 'active', url: 'https://avito.ru/9001', address: 'Воронеж', category: { id: 9, name: 'Автомобили' } },
  { id: 9002, title: 'Chery Tiggo 7 Pro Max, 2025', price: 2890000, status: 'active', url: 'https://avito.ru/9002', address: 'Воронеж', category: { id: 9, name: 'Автомобили' } },
  { id: 9003, title: 'Geely Coolray, 2024', price: 2350000, status: 'old', url: 'https://avito.ru/9003', address: 'Воронеж', category: { id: 9, name: 'Автомобили' } },
];

const FEED = `<?xml version="1.0" encoding="utf-8"?>
<Ads formatVersion="3" target="Avito.ru">
  <Ad><Id>A-1</Id><Category>Автомобили</Category><Make>Haval</Make><Model>Jolion</Model><Year>2025</Year><Kilometrage>0</Kilometrage>
    <Price>2199000</Price><VIN>LGWEF4A5XRH000001</VIN><Color>Белый</Color><Transmission>Робот</Transmission><DriveType>Передний</DriveType>
    <Complectation><Option>Климат-контроль</Option><Option>Камера заднего вида</Option></Complectation>
    <Description><![CDATA[<p>Новый Haval Jolion в наличии.</p><ul><li>Кредит от 4,9%</li><li>Трейд-ин</li></ul>]]></Description>
    <Images><Image url="https://img/1.jpg"/></Images></Ad>
  <Ad><Id>A-2</Id><Category>Автомобили</Category><Make>Chery</Make><Model>Tiggo 7 Pro Max</Model><Year>2025</Year><Kilometrage>0</Kilometrage>
    <Price>2890000</Price><Availability>В пути</Availability><VIN>LVVDB21B0RD000002</VIN><Description>Полный привод &amp; панорама</Description></Ad>
  <Ad><Id>A-3</Id><Category>Автомобили</Category><Make>Changan</Make><Model>CS55</Model><Year>2025</Year><Price>2500000</Price></Ad>
</Ads>`;
const FEED_MAP = { 'A-1': 9001, 'A-2': 9002 };

// 260 чатов; у первых трёх длинная история (150 сообщений) для проверки пагинации
const CHATS = [];
for (let i = 0; i < 260; i++) {
  const item = ITEMS[i % ITEMS.length];
  const created = BASE_TS + i * 3000;
  const msgs = [];
  const n = i < 3 ? 150 : 4;
  for (let k = 0; k < n; k++) {
    const fromClient = k % 2 === 0;
    let text = fromClient ? `Здравствуйте, ${item.title} ещё в продаже? (${k})` : 'Добрый день! Да, в наличии. Оставьте номер, менеджер перезвонит.';
    if (fromClient && k === 2 && i % 5 === 0) text = 'Мой номер 8 (915) 123-45-' + String(10 + (i % 80)).padStart(2, '0');
    msgs.push({
      id: `m-${i}-${k}`, author_id: fromClient ? 5000 + i : UID, direction: fromClient ? 'in' : 'out', type: 'text',
      content: { text }, created: created + k * 400,
    });
  }
  CHATS.push({
    id: `u2i-chat-${i}`, created, updated: msgs[msgs.length - 1].created,
    context: { type: 'item', value: { id: item.id, title: item.title, price_string: item.price.toLocaleString('ru-RU') + ' ₽', url: item.url } },
    users: [{ id: UID, name: 'Платон Авто' }, { id: 5000 + i, name: `Покупатель ${i}` }],
    messages: msgs,
  });
}

const counters = { send: 0, read: 0, openai: 0, telegram: 0, keys: {}, responses: 0 };

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function body(req) {
  return new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)); });
}

function openaiReply(messages) {
  const system = messages[0]?.content || '';
  const user = messages[messages.length - 1]?.content || '';
  if (system.includes('Составь сводный отчёт')) {
    return {
      overview: 'Продавцы отвечают быстро, но редко просят телефон.',
      top_questions: [{ question: 'Актуально ли объявление', count: 10 }, { question: 'Есть ли кредит', count: 4 }],
      mistakes: [{ mistake: 'Не просят телефон', count: 6, fix: 'В каждом втором ответе предлагать созвониться' }],
      good_practices: ['Быстрый первый ответ'],
      rules: '- Всегда предлагай оставить номер\n- Не называй ставку кредита без менеджера',
      faq: [{ q: 'Есть ли трейд-ин?', a: 'Да, принимаем автомобиль в зачёт, оценка бесплатно.' }],
    };
  }
  if (system.includes('Разбираешь переписку')) {
    return {
      summary: 'Клиент спросил про наличие, продавец ответил.', questions: ['Актуально ли объявление'], outcome: /номер \d/.test(user) ? 'phone' : 'lost',
      score: 6, speed: 'Отвечает за 7 минут', mistakes: ['Не уточнил удобное время звонка'], good: ['Вежливо'],
      better_reply: { client: 'ещё в продаже?', reply: 'Да, в наличии! Удобно, если менеджер перезвонит через 10 минут?' },
      faq: [{ q: 'Машина в наличии?', a: 'Да, автомобиль в наличии в салоне.' }],
    };
  }
  const hasKb = system.includes('БАЗА ЗНАНИЙ');
  const vin = (system.match(/VIN: (\w+)/) || [])[1];
  return {
    reply: `Здравствуйте! Да, автомобиль в наличии${vin ? ' (VIN ' + vin + ')' : ''}.${hasKb ? ' Трейд-ин возможен.' : ''} Оставите номер?`,
    phone: null, handoff: false, skip: false,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const raw = await body(req);

  if (p === '/__counters') return json(res, 200, counters);
  if (p === '/feed.xml') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(FEED); }

  // ---- OpenAI ----
  // ---- OpenAI Responses API (модели «Лаборатории») ----
  if (p === '/v1/responses') {
    counters.openai++; counters.responses++;
    const b = JSON.parse(raw || '{}');
    counters.keys[b.model] = req.headers.authorization;
    if (b.model === 'broken-model') return json(res, 404, { error: { message: 'The model does not exist' } });
    if (b.model === 'no-responses-model') return json(res, 404, { error: { message: 'Unknown url /v1/responses' } });
    const sys = b.instructions || '';
    const last = (b.input || []).filter((m) => m.role === 'user').pop()?.content || '';
    const reply = {
      reply: `${(b.input || []).some((m) => m.role === 'assistant') ? '' : 'Здравствуйте, меня зовут Ярослав, менеджер отдела продаж. '}Ответ ${b.model} на «${String(last).slice(0, 40)}»${/ПРОВОДНИК/.test(sys) ? ' (проводник)' : ''}.`,
      phone: null, handoff: false, skip: /Больше не пишите/.test(last),
    };
    return json(res, 200, { model: b.model, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(reply) }] }],
      usage: { input_tokens: 5000, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 120 } } });
  }

  if (p === '/v1/chat/completions') {
    counters.openai++;
    const b = JSON.parse(raw || '{}');
    counters.keys[b.model] = req.headers.authorization;
    if (b.model === 'bad-model') return json(res, 404, { error: { message: 'model not found' } });
    // модель без JSON-режима: 400 на response_format, без него — отвечает
    if (b.model === 'vendor/no-json' && b.response_format) return json(res, 400, { error: { message: 'response_format is not supported' } });
    if (b.model === 'vendor/no-json') return json(res, 200, { choices: [{ message: { content: 'Вот ответ: ' + JSON.stringify({ reply: 'Ответ без JSON-режима', phone: null, handoff: false, skip: false }) } }], usage: { total_tokens: 900 } });
    return json(res, 200, { model: b.model, choices: [{ message: { content: JSON.stringify(openaiReply(b.messages || [])) } }], usage: { total_tokens: 1234 } });
  }

  // ---- Авито ----
  if (p === '/token') return json(res, 200, { access_token: 'mock-token', expires_in: 86400 });
  if (req.headers.authorization !== 'Bearer mock-token') return json(res, 401, { error: 'unauthorized' });
  if (p === '/core/v1/accounts/self') return json(res, 200, { id: UID, name: 'Платон Авто (мок)' });

  // ---- CPA: фактические списания ----
  if (p.startsWith('/cpa/')) {
    if (!req.headers['x-source']) return json(res, 400, { error: { message: 'X-Source required' } });
    if (p === '/cpa/v3/balanceInfo') return json(res, 200, { balance: 1234500 });
    const b = JSON.parse(raw || '{}');
    if (p === '/cpa/v2/chatsByTime') {
      // платные: чаты с телефоном (каждый 5-й) и длинные чаты 1 и 2
      const billed = CHATS.filter((c, i) => i % 5 === 0 || i === 1 || i === 2).map((c) => {
        const i = Number(c.id.split('-').pop());
        const phone = i % 5 === 0;
        const m = phone ? c.messages[2] : c.messages[4];
        return { buyer: { buyerId: 5000 + i, name: `Покупатель ${i}` },
          chat: { actionId: 70000 + i, channelId: c.id, contactType: phone ? 'phone' : 'other', date: new Date(m.created * 1000).toISOString(),
            message: m.content.text, messageId: m.id, pricePenny: 45000, status: 'active', targetChatType: phone ? 'Контакты' : 'Переключения' },
          isArbitrageAvailable: true, item: { itemId: c.context.value.id, title: c.context.value.title } };
      });
      return json(res, 200, { chats: billed.slice(b.offset || 0, (b.offset || 0) + (b.limit || 100)) });
    }
    if (p === '/cpa/v2/callsByTime') {
      const c0 = CHATS[0];
      return json(res, 200, { calls: [{ id: 555, buyerPhone: '+79151234510', createTime: new Date((c0.created + 3600) * 1000).toISOString(),
        startTime: new Date((c0.created + 3600) * 1000).toISOString(), duration: 95, price: 60000, statusId: 0, itemId: c0.context.value.id, isArbitrageAvailable: true }] });
    }
  }

  if (p === '/core/v1/items') {
    const per = Number(url.searchParams.get('per_page') || 25);
    const page = Number(url.searchParams.get('page') || 1);
    return json(res, 200, { meta: { page, per_page: per }, resources: ITEMS.slice((page - 1) * per, page * per) });
  }
  if (p === '/autoload/v2/profile') {
    return json(res, 200, { autoload_enabled: true, feeds_data: [{ feed_name: 'main', feed_url: `http://127.0.0.1:${PORT}/feed.xml` }] });
  }
  if (p === '/autoload/v2/items/avito_ids') {
    const ids = (url.searchParams.get('query') || '').split(/[,|]/);
    return json(res, 200, { items: ids.map((id) => ({ ad_id: id, avito_id: FEED_MAP[id] || null })) });
  }

  let m = p.match(/^\/messenger\/v2\/accounts\/(\d+)\/chats$/);
  if (m) {
    const limit = Number(url.searchParams.get('limit') || 100);
    const offset = Number(url.searchParams.get('offset') || 0);
    const itemIds = url.searchParams.get('item_ids');
    let list = CHATS;
    if (itemIds) {
      // как у настоящего Авито может быть: несколько ID через запятую не принимаются
      if (itemIds.includes(',')) return json(res, 400, { error: { message: 'Bad Request' } });
      const set = new Set(itemIds.split(',').map(Number));
      list = CHATS.filter((c) => set.has(c.context.value.id));
    } else if (offset >= CHAT_LIST_CAP) {
      return json(res, 400, { error: { message: 'offset too large' } });
    }
    const sorted = [...list].sort((a, b) => b.updated - a.updated);
    return json(res, 200, { chats: sorted.slice(offset, offset + limit).map(({ messages, ...c }) => ({ ...c, last_message: messages[messages.length - 1] })) });
  }
  m = p.match(/^\/messenger\/v2\/accounts\/(\d+)\/chats\/([^/]+)$/);
  if (m) {
    const c = CHATS.find((x) => x.id === decodeURIComponent(m[2]));
    if (!c) return json(res, 404, { error: 'not found' });
    const { messages, ...rest } = c;
    return json(res, 200, rest);
  }
  m = p.match(/^\/messenger\/v3\/accounts\/(\d+)\/chats\/([^/]+)\/messages\/$/);
  if (m) {
    const c = CHATS.find((x) => x.id === decodeURIComponent(m[2]));
    if (!c) return json(res, 404, { error: 'not found' });
    const limit = Number(url.searchParams.get('limit') || 100);
    const offset = Number(url.searchParams.get('offset') || 0);
    const newestFirst = [...c.messages].reverse();
    return json(res, 200, newestFirst.slice(offset, offset + limit));
  }
  if (/\/messages$/.test(p) && req.method === 'POST') { counters.send++; return json(res, 200, { id: 'sent-' + Date.now(), created: Math.floor(Date.now() / 1000) }); }
  if (/\/read$/.test(p) && req.method === 'POST') { counters.read++; return json(res, 200, { ok: true }); }
  return json(res, 404, { error: 'mock: not found ' + p });
});

server.listen(PORT, () => console.log('mock Avito/OpenAI on ' + PORT));
module.exports = server;
