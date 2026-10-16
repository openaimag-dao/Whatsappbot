import fs from 'node:fs';

export function loadCatalog(path) {
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  const products = new Map(data.products.map((p) => [p.id, p]));
  return {
    categories: data.categories,
    products,
    byCategory: (categoryId) => data.products.filter((p) => p.category === categoryId),
    category: (id) => data.categories.find((c) => c.id === id),
  };
}

export function formatPrice(amount, currency) {
  return `${amount.toLocaleString('ru-RU')} ${currency}`;
}
