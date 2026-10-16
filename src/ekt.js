// Поиск цен на ekt.kz (Электрокомплект).
// Результаты поиска на сайте подгружаются скриптом, поэтому страницу рендерим через Firecrawl
// и разбираем полученный markdown. Без FIRECRAWL_API_KEY поиск по ekt.kz выключен.
import { normalize, STOP_WORDS } from './catalog.js';
import { round2, VAT_RATE } from './money.js';

const CACHE_TTL = 60 * 60 * 1000;
// Общие слова, которых может не быть в названии на ekt.kz
const GENERIC = new Set(['кабель', 'провод', 'кабеля', 'провода', 'марки']);
const num = (s) => Number(String(s).replace(/[\s  ]/g, ''));

// Разбор markdown страницы поиска ekt.kz в список товаров.
export function parseEktSearch(markdown) {
  const items = [];
  const re = /\[\*\*(.+?)\*\*\]\((https:\/\/ekt\.kz\/catalog\/[^)\s]+)\)([\s\S]*?)(?=\[\*\*|$)/g;
  for (const m of markdown.matchAll(re)) {
    const [, rawTitle, url, body] = m;
    const price = body.match(/цена \(от\)\s*([\d\s  ]+)₸/);
    const shop = body.match(/цена в магазине\s*([\d\s  ]+)₸/);
    const code = body.match(/Код\s*товара\s*([^\s\\]+)/);
    const section = url.replace('https://ekt.kz/catalog/', '').split('/')[0];
    items.push({
      title: rawTitle.replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim(),
      url,
      section,
      code: code ? code[1] : '',
      price: price ? num(price[1]) : 0, // цена на сайте (интернет), с НДС
      shopPrice: shop ? num(shop[1]) : 0,
      onOrder: /\nПод заказ\s/.test(body) || !price,
      unit: section === 'kabel_provod' ? 'м' : 'шт',
    });
  }
  return items;
}

// Все слова запроса должны встретиться в названии товара на ekt.kz.
export function matchEkt(query, items) {
  const tokens = [...new Set(normalize(query).split(' '))].filter(
    (t) => (t.length > 1 || /\d/.test(t)) && !STOP_WORDS.has(t) && !GENERIC.has(t),
  );
  return items
    .map((it) => {
      const hay = ` ${normalize(it.title)} `;
      const compact = hay.replace(/\s+/g, '');
      const ok = tokens.length && tokens.every((t) => hay.includes(t) || compact.includes(t));
      return ok ? { it, extra: hay.length } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.it.onOrder) - Number(b.it.onOrder) || a.extra - b.extra)
    .map((x) => x.it);
}

// Цена для клиента по правилу «ekt.kz − 5%» и проверка прибыли.
export function priceFromEkt(item, pricing) {
  const discount = pricing.ektDiscountByCategory?.[item.section] ?? pricing.ektDiscount;
  const priceVat = Math.round(item.price * (1 - pricing.ektUndercut));
  const costVat = item.price * (1 - discount);
  const margin = round2(priceVat / costVat - 1);
  return {
    priceVat,
    price: round2(priceVat / (1 + VAT_RATE)), // без НДС — как в каталоге
    costVat: round2(costVat),
    margin,
    needsApproval: margin < pricing.minMargin,
  };
}

export class EktClient {
  constructor({ apiKey, apiUrl, pricing, fetchImpl = fetch, logger = console }) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this.pricing = pricing;
    this.fetch = fetchImpl;
    this.log = logger;
    this.cache = new Map();
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async #searchPage(query) {
    const key = normalize(query);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.items;
    const url = `https://ekt.kz/catalog/?q=${encodeURIComponent(query)}`;
    const res = await this.fetch(this.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, waitFor: 3000, maxAge: CACHE_TTL }),
    });
    if (!res.ok) throw new Error(`Firecrawl ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const items = parseEktSearch(json?.data?.markdown || '');
    this.cache.set(key, { at: Date.now(), items });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    return items;
  }

  // Товары ekt.kz по запросу с рассчитанной ценой AIMAG (только с ценой на сайте).
  async search(query, limit = 9) {
    if (!this.enabled) return [];
    try {
      const items = matchEkt(query, await this.#searchPage(query)).filter((it) => it.price > 0);
      return items.slice(0, limit).map((it) => ({ ...it, quote: priceFromEkt(it, this.pricing) }));
    } catch (err) {
      this.log.error('Поиск на ekt.kz не удался:', err.message);
      return [];
    }
  }
}
