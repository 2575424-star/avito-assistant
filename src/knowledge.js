// База знаний агента: записи (вопрос-ответ, условия, возражения, примеры) и карточки автомобилей
// из Авито API и XML-фида автозагрузки.
const { db, getSetting, setSetting, logEvent } = require('./db');
const avito = require('./avito');

const now = () => Math.floor(Date.now() / 1000);

const KB_CATEGORIES = {
  faq: 'Вопрос — ответ',
  company: 'Условия и факты',
  objections: 'Возражения',
  rules: 'Правила и запреты',
  example: 'Пример ответа',
};

// ---------- Поиск по базе ----------
// Без эмбеддингов: слова длиннее 3 букв, обрезанные до 5 символов (грубый стемминг для русского).
function stems(text) {
  return new Set(
    String(text || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/)
      .filter((w) => w.length > 3).map((w) => w.slice(0, 5)),
  );
}

function score(entryStems, query) {
  let n = 0;
  for (const s of query) if (entryStems.has(s)) n++;
  return n;
}

/**
 * Выбрать записи базы знаний для промпта.
 * Если вся база влезает в бюджет — отдаём всю; иначе самые близкие к вопросу клиента.
 */
function selectKb(queryText) {
  const budget = Number(getSetting('kb_budget_chars') || 16000);
  const rows = db.prepare('SELECT * FROM kb WHERE enabled = 1 ORDER BY category, id').all();
  const size = (r) => (r.title || '').length + r.content.length + 20;
  const total = rows.reduce((a, r) => a + size(r), 0);
  if (total <= budget) return rows;
  const q = stems(queryText);
  const ranked = rows
    .map((r) => ({ r, s: score(stems((r.title || '') + ' ' + r.content), q) + (r.category === 'rules' ? 100 : 0) }))
    .sort((a, b) => b.s - a.s);
  const out = [];
  let used = 0;
  for (const { r } of ranked) {
    if (used + size(r) > budget) continue;
    out.push(r);
    used += size(r);
  }
  return out;
}

function kbPromptSections(queryText) {
  const rows = selectKb(queryText);
  const by = (c) => rows.filter((r) => r.category === c);
  const parts = [];
  const facts = [...by('company'), ...by('faq')];
  if (facts.length) {
    parts.push('БАЗА ЗНАНИЙ (факты компании; отвечай по ним, не выдумывай то, чего здесь нет):\n' +
      facts.map((r) => (r.category === 'faq' ? `— Вопрос: ${r.title}\n  Ответ: ${r.content}` : `— ${r.title ? r.title + ': ' : ''}${r.content}`)).join('\n'));
  }
  if (by('rules').length) parts.push('ДОПОЛНИТЕЛЬНЫЕ ПРАВИЛА:\n' + by('rules').map((r) => `— ${r.title ? r.title + ': ' : ''}${r.content}`).join('\n'));
  if (by('objections').length) {
    parts.push('КАК ОТРАБАТЫВАТЬ ВОЗРАЖЕНИЯ:\n' + by('objections').map((r) => `— Клиент: ${r.title}\n  Как отвечать: ${r.content}`).join('\n'));
  }
  if (by('example').length) {
    parts.push('ПРИМЕРЫ ПРАВИЛЬНЫХ ОТВЕТОВ (перенимай тон и тактику, факты бери только из базы и объявления):\n' +
      by('example').map((r) => `— Клиент: ${r.title}\n  Ответ: ${r.content}`).join('\n'));
  }
  return { text: parts.join('\n\n'), ids: rows.map((r) => r.id) };
}

// ---------- Автомобили ----------
const fmtPrice = (p) => (p ? Number(p).toLocaleString('ru-RU') + ' ₽' : '');

const STATUS_RU = { active: 'в продаже', old: 'снято с публикации', removed: 'удалено', blocked: 'заблокировано', rejected: 'отклонено' };

// Поля фида, которые не нужны агенту
const SKIP_PARAMS = new Set(['Id', 'AvitoId', 'Images', 'Videos', 'VideoURL', 'ContactPhone', 'ManagerName', 'AllowEmail', 'ContactMethod',
  'DateBegin', 'DateEnd', 'ListingFee', 'AdStatus', 'AvitoDateEnd', 'Description', 'Title', 'Price', 'Address', 'Category', 'VIN',
  'Year', 'Kilometrage', 'Latitude', 'Longitude', 'CompanyName', 'EMail', 'InternetCalls', 'CallsDevices']);

const PARAM_RU = {
  Make: 'Марка', Model: 'Модель', Modification: 'Модификация', Generation: 'Поколение', BodyType: 'Кузов', Doors: 'Дверей',
  Color: 'Цвет', FuelType: 'Двигатель', EngineSize: 'Объём', Power: 'Мощность, л.с.', Transmission: 'Коробка', DriveType: 'Привод',
  WheelType: 'Руль', Condition: 'Состояние', Owners: 'Владельцев', PTS: 'ПТС', Complectation: 'Комплектация', Accident: 'ДТП',
  Availability: 'Наличие', Trim: 'Комплектация', Kilometrage: 'Пробег', Year: 'Год', TechnicalPassport: 'ПТС',
};

function itemCard(it) {
  if (!it) return '';
  const lines = [`Название: ${it.title || ''}`];
  if (it.price) lines.push(`Цена: ${fmtPrice(it.price)}`);
  if (it.status && it.status !== 'active') lines.push(`Статус: ${STATUS_RU[it.status] || it.status}`);
  if (it.year) lines.push(`Год: ${it.year}`);
  if (it.mileage) lines.push(`Пробег: ${it.mileage} км`);
  if (it.vin) lines.push(`VIN: ${it.vin}`);
  let params = {};
  try { params = JSON.parse(it.params || '{}'); } catch { /* ignore */ }
  for (const [k, v] of Object.entries(params)) {
    if (SKIP_PARAMS.has(k) || !v || String(v).length > 400) continue;
    lines.push(`${PARAM_RU[k] || k}: ${v}`);
  }
  if (it.address) lines.push(`Адрес: ${it.address}`);
  if (it.url) lines.push(`Ссылка: ${it.url}`);
  if (it.description) lines.push(`Описание из объявления:\n${it.description.slice(0, 3000)}`);
  return lines.join('\n');
}

function getItem(avitoId) {
  if (!avitoId) return null;
  return db.prepare('SELECT * FROM items WHERE avito_id = ?').get(Number(avitoId)) || null;
}

/** Короткий список других машин в продаже — чтобы агент мог предложить альтернативу. */
function stockList(excludeKey, limit = 60) {
  const rows = db.prepare("SELECT * FROM items WHERE (status = 'active' OR status IS NULL) AND key != ? ORDER BY price LIMIT ?").all(excludeKey || '', limit);
  return rows.map((r) => `— ${r.title}${r.price ? ', ' + fmtPrice(r.price) : ''}${r.year && !String(r.title).includes(r.year) ? ', ' + r.year : ''}`).join('\n');
}

function itemsStats() {
  return db.prepare(`SELECT COUNT(*) total, SUM(status = 'active') active, SUM(description IS NOT NULL AND description != '') with_desc,
    SUM(source LIKE '%feed%') from_feed FROM items`).get();
}

const upsertItem = db.prepare(`
INSERT INTO items(key, avito_id, ad_id, title, price, url, status, address, category, vin, year, mileage, description, params, source, updated)
VALUES(:key, :avito_id, :ad_id, :title, :price, :url, :status, :address, :category, :vin, :year, :mileage, :description, :params, :source, :updated)
ON CONFLICT(key) DO UPDATE SET
  avito_id = COALESCE(excluded.avito_id, items.avito_id),
  ad_id = COALESCE(excluded.ad_id, items.ad_id),
  -- название и цену из Авито API фид не перетирает: они «живые», фид может отставать
  title = CASE WHEN excluded.source = 'feed' THEN COALESCE(items.title, excluded.title) ELSE COALESCE(excluded.title, items.title) END,
  price = CASE WHEN excluded.source = 'feed' THEN COALESCE(items.price, excluded.price) ELSE COALESCE(excluded.price, items.price) END,
  url = COALESCE(excluded.url, items.url),
  status = COALESCE(excluded.status, items.status),
  address = COALESCE(excluded.address, items.address),
  category = COALESCE(excluded.category, items.category),
  vin = COALESCE(excluded.vin, items.vin),
  year = COALESCE(excluded.year, items.year),
  mileage = COALESCE(excluded.mileage, items.mileage),
  description = COALESCE(excluded.description, items.description),
  params = COALESCE(excluded.params, items.params),
  source = CASE WHEN items.source IS NULL OR items.source = excluded.source THEN excluded.source
                WHEN instr(items.source, excluded.source) > 0 THEN items.source
                ELSE items.source || '+' || excluded.source END,
  updated = excluded.updated
`);

const EMPTY_ITEM = { avito_id: null, ad_id: null, title: null, price: null, url: null, status: null, address: null, category: null, vin: null, year: null, mileage: null, description: null, params: null };

/** Загрузить объявления кабинета через Avito API. */
async function importItemsFromApi() {
  const list = await avito.getItems();
  for (const r of list) {
    upsertItem.run({
      ...EMPTY_ITEM,
      key: String(r.id), avito_id: r.id, title: r.title || null, price: r.price ?? null, url: r.url || null,
      status: r.status || null, address: r.address || null, category: r.category?.name || null, source: 'api', updated: now(),
    });
  }
  logEvent('kb', `Загружено объявлений из Авито: ${list.length}`);
  return { count: list.length };
}

// ---------- XML-фид автозагрузки ----------
function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c.replace(/</g, '\u0001').replace(/>/g, '\u0002'))
    .replace(/&lt;/g, '\u0001').replace(/&gt;/g, '\u0002')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/** HTML-описание → обычный текст. */
function htmlToText(s) {
  return String(s)
    .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/** Разобрать фид формата автозагрузки Авито: <Ads><Ad><Id/>…</Ad></Ads>. */
function parseFeed(xml) {
  const ads = [];
  const adRe = /<Ad(?:\s[^>]*)?>([\s\S]*?)<\/Ad>/g;
  let m;
  while ((m = adRe.exec(xml))) {
    const body = m[1];
    const fields = {};
    const fieldRe = /<([A-Za-z][\w]*)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/\1>)/g;
    let f;
    while ((f = fieldRe.exec(body))) {
      const [, tag, inner] = f;
      if (inner === undefined) continue;
      let value;
      if (/<[A-Za-z]/.test(inner.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ''))) {
        // вложенные элементы (опции, комплектация) → список через запятую
        value = [...inner.matchAll(/>([^<]+)</g)].map((x) => decodeXml(x[1]).trim()).filter(Boolean).join(', ');
      } else {
        value = decodeXml(inner).trim();
      }
      value = value.replace(/\u0001/g, '<').replace(/\u0002/g, '>');
      if (value) fields[tag] = fields[tag] ? fields[tag] + ', ' + value : value;
    }
    if (fields.Id) ads.push(fields);
  }
  return ads;
}

function feedTitle(f) {
  if (f.Title) return f.Title;
  const name = [f.Make, f.Model, f.Modification].filter(Boolean).join(' ');
  return [name, f.Year].filter(Boolean).join(', ') || `Объявление ${f.Id}`;
}

async function fetchFeedUrl() {
  const profile = await avito.getAutoloadProfile();
  const feeds = profile.feeds_data || [];
  return feeds.map((x) => x.feed_url).filter(Boolean);
}

/** Загрузить XML-фид (URL из настроек или из профиля автозагрузки Авито). */
async function importFeed(url) {
  let urls = url ? [url] : (getSetting('feed_url') ? [getSetting('feed_url')] : []);
  if (!urls.length) {
    urls = await fetchFeedUrl();
    if (!urls.length) throw new Error('URL фида не задан, и в профиле автозагрузки Авито фидов нет');
    setSetting('feed_url', urls[0]);
  }
  let total = 0, mapped = 0;
  for (const u of urls) {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`Фид ${u} не загрузился: HTTP ${res.status}`);
    const ads = parseFeed(await res.text());
    const idMap = {};
    for (const a of ads) if (a.AvitoId && /^\d+$/.test(a.AvitoId)) idMap[a.Id] = Number(a.AvitoId);
    const need = ads.filter((a) => !idMap[a.Id]).map((a) => a.Id);
    if (need.length && avito.isConfigured()) {
      try { Object.assign(idMap, await avito.avitoIdsByAdIds(need)); } catch (e) { logEvent('kb', 'Не удалось сопоставить Id фида с Авито: ' + e.message, null, 'warn'); }
    }
    for (const a of ads) {
      const avitoId = idMap[a.Id] || null;
      if (avitoId) {
        // в базе могла лежать запись из фида без avito_id — сливаем
        db.prepare('DELETE FROM items WHERE key = ?').run('feed:' + a.Id);
        mapped++;
      }
      const price = Number(String(a.Price || '').replace(/\D/g, '')) || null;
      upsertItem.run({
        ...EMPTY_ITEM,
        key: avitoId ? String(avitoId) : 'feed:' + a.Id,
        avito_id: avitoId, ad_id: a.Id, title: feedTitle(a), price,
        address: a.Address || null, category: a.Category || null, vin: a.VIN || null, year: a.Year || null,
        mileage: a.Kilometrage || null, description: a.Description ? htmlToText(a.Description) : null,
        params: JSON.stringify(a), source: 'feed', updated: now(),
      });
    }
    total += ads.length;
  }
  logEvent('kb', `Фид загружен: объявлений ${total}, сопоставлено с Авито ${mapped}`);
  return { count: total, mapped, url: urls.join(', ') };
}

module.exports = {
  KB_CATEGORIES, selectKb, kbPromptSections, itemCard, getItem, stockList, itemsStats,
  importItemsFromApi, importFeed, parseFeed, htmlToText, fetchFeedUrl, fmtPrice,
};
