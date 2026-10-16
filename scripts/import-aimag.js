// Импорт каталога с сайта aimag.kz в data/catalog.json.
// Берёт ссылки на товары из sitemap.xml, с каждой страницы — разметку schema.org Product,
// единицу измерения и параметры. Запуск: npm run import
import fs from 'node:fs';

const BASE = process.env.SITE_URL || 'https://www.aimag.kz';
const OUT = process.argv[2] || new URL('../data/catalog.json', import.meta.url).pathname;
const CONCURRENCY = 4;
const UA = 'Mozilla/5.0 (compatible; AimagWhatsAppBot/1.0; catalog import)';

async function get(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (attempt >= 3) throw new Error(`${url}: ${err.message}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    return get(url, attempt + 1);
  }
}

const decode = (s) =>
  s.replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function textLines(html) {
  return decode(
    html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '\n'),
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function parseProduct(html, url) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => {
    try { return JSON.parse(m[1]); } catch { return null; }
  });
  const ld = blocks.find((b) => b?.['@type'] === 'Product');
  if (!ld) return null;
  const crumbs = blocks.find((b) => b?.['@type'] === 'BreadcrumbList')?.itemListElement ?? [];
  const catCrumb = crumbs.find((c) => /[?&]cat=/.test(c.item ?? ''));
  const categoryId = catCrumb ? new URL(catCrumb.item).searchParams.get('cat') : 'prochee';

  const lines = textLines(html);
  // Единица измерения: строки "948 ₸", "/", "м"
  let unit = 'шт';
  const pi = lines.findIndex((l) => /₸$/.test(l));
  if (pi >= 0 && lines[pi + 1] === '/' && lines[pi + 2] && lines[pi + 2].length <= 6) unit = lines[pi + 2];

  // Параметры товара: пары <dt>/<dd> из блока «Параметры товара» (и следующих за ним)
  const params = [];
  const from = html.indexOf('Параметры товара</h3>');
  if (from >= 0) {
    const to = html.indexOf('Похожие товары', from);
    const section = html.slice(from, to > 0 ? to : undefined);
    for (const m of section.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
      const key = decode(m[1].replace(/<[^>]+>/g, '')).trim();
      const value = decode(m[2].replace(/<[^>]+>/g, '')).trim();
      if (key && value && params.length < 8) params.push(`${key}: ${value}`);
    }
  }

  const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
  return {
    id: url.split('/').pop(),
    sku: ld.sku || '',
    title: ld.name,
    category: categoryId,
    categoryTitle: catCrumb?.name || ld.category || 'Прочее',
    brand: ld.brand?.name || '',
    price: Number(offer?.price) || 0,
    unit,
    inStock: /InStock/.test(offer?.availability ?? ''),
    params,
    url: ld.url || url,
    image: Array.isArray(ld.image) ? ld.image[0] : ld.image || '',
  };
}

async function main() {
  const sitemap = await get(`${BASE}/sitemap.xml`);
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1])
    .filter((u) => /\/catalog\/[^/?#]+$/.test(u));
  console.log(`Товаров в sitemap: ${urls.length}`);

  const products = [];
  const failed = [];
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        const p = parseProduct(await get(url), url);
        if (p) products.push(p);
        else failed.push(url);
      } catch (err) {
        failed.push(url);
        console.warn(err.message);
      }
      if ((products.length + failed.length) % 100 === 0) console.log(`…${products.length + failed.length}/${urls.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const order = new Map();
  for (const p of products) {
    if (!order.has(p.category)) order.set(p.category, { id: p.category, title: p.categoryTitle, count: 0 });
    order.get(p.category).count++;
  }
  const categories = [...order.values()].sort((a, b) => b.count - a.count).map(({ id, title }) => ({ id, title }));
  products.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title, 'ru', { numeric: true }));
  for (const p of products) delete p.categoryTitle;

  fs.writeFileSync(OUT, `${JSON.stringify({ source: BASE, importedAt: new Date().toISOString(), categories, products }, null, 1)}\n`);
  console.log(`Сохранено: ${products.length} товаров, ${categories.length} категорий → ${OUT}`);
  if (failed.length) console.log(`Не удалось разобрать ${failed.length} страниц:\n${failed.slice(0, 20).join('\n')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
