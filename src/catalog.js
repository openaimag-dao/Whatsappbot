import fs from 'node:fs';

// Нормализация для поиска: регистр, ё, «×/х/x», запятая в числах — «ВВГнг 3х2,5» ≈ «ввгнг 3x2.5».
export function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(\d)\s*[×хx*]\s*(?=\d)/g, '$1x')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/[«»"'()/\\,;:!?+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const STOP_WORDS = new Set(
  'а в и к на по с у о об от до для из за не ли же бы это есть нужен нужна нужно нужны надо хочу купить цена цену стоит сколько какой какая какие какую у вас ваш вам мне можно ли или шт м метр метров штук пожалуйста подскажите здравствуйте добрый день привет'.split(' '),
);

export function loadCatalog(path) {
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  const products = new Map(data.products.map((p) => [p.id, p]));
  const categories = data.categories.filter((c) => data.products.some((p) => p.category === c.id));
  const catTitle = Object.fromEntries(categories.map((c) => [c.id, c.title]));
  const index = data.products.map((p) => ({
    p,
    hay: ` ${normalize([p.title, p.sku, p.brand, catTitle[p.category], ...(p.params || [])].join(' '))} `,
    title: normalize(p.title),
  }));
  for (const item of index) item.compact = item.hay.replace(/\s+/g, '');

  return {
    categories,
    products,
    size: data.products.length,
    byCategory: (categoryId) => data.products.filter((p) => p.category === categoryId),
    category: (id) => categories.find((c) => c.id === id),

    // Поиск по названию, артикулу, бренду и параметрам.
    // exact=true — найдены товары со всеми словами запроса; иначе — самые похожие (большинство слов).
    search(query, limit = 20) {
      const tokens = [...new Set(normalize(query).split(' '))].filter(
        (t) => t && !STOP_WORDS.has(t) && (t.length > 1 || /\d/.test(t)),
      );
      if (!tokens.length) return { items: [], exact: false };
      const scored = [];
      for (const item of index) {
        let matched = 0;
        let words = 0;
        let score = 0;
        for (const t of tokens) {
          if (!item.hay.includes(t) && !item.compact.includes(t)) continue;
          matched += 1;
          if (/\D/.test(t)) words += 1;
          if (item.title.includes(t)) score += 2;
          if (item.hay.includes(` ${t} `)) score += 1;
        }
        if (!words) continue;
        scored.push({ p: item.p, matched, score: score + (item.p.inStock ? 0.5 : 0) });
      }
      if (!scored.length) return { items: [], exact: false };
      const best = Math.max(...scored.map((s) => s.matched));
      const exact = best === tokens.length;
      // Неточные совпадения показываем, только если совпало больше половины слов.
      if (!exact && (tokens.length < 2 || best * 2 <= tokens.length)) return { items: [], exact: false };
      const items = scored
        .filter((s) => s.matched === best)
        .sort((a, b) => b.score - a.score || a.p.title.length - b.p.title.length)
        .slice(0, limit)
        .map((s) => s.p);
      return { items, exact };
    },
  };
}

export function formatPrice(amount, currency) {
  return `${Math.round(amount).toLocaleString('ru-RU')} ${currency}`;
}
