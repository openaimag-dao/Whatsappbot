import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SalesBot } from '../src/bot.js';
import { Store } from '../src/store.js';
import { loadCatalog } from '../src/catalog.js';
import { extractMessages, isValidSignature } from '../src/webhook.js';

const catalog = loadCatalog(new URL('../data/catalog.json', import.meta.url).pathname);
const shop = { name: 'Тест', currency: '₸', phone: '+7 700 000-00-00', hours: 'Пн–Пт', managerPhone: '70000000000' };

function setup(assistant = null) {
  const sent = [];
  const wa = {
    text: async (to, body) => sent.push({ to, type: 'text', body }),
    buttons: async (to, body, buttons) => sent.push({ to, type: 'buttons', body, buttons }),
    list: async (to, body, button, rows) => sent.push({ to, type: 'list', body, rows }),
  };
  const store = new Store(null);
  const bot = new SalesBot({ wa, store, catalog, shop, assistant, logger: { error() {} } });
  return { bot, store, sent, say: (m) => bot.handle({ from: PHONE, ...m }) };
}

const PHONE = '77010001122';

test('сценарий: поиск → карточка → количество → заявка на КП', async () => {
  const { store, sent, say } = setup();
  await say({ text: 'Привет', name: 'Ерлан' });
  assert.match(sent.at(-1).body, /Ерлан/);

  await say({ text: 'ввгнг 3х2,5' });
  const list = sent.at(-1);
  assert.equal(list.type, 'list');
  const row = list.rows.find((r) => r.id.startsWith('prod:'));
  assert.ok(row, 'должен найтись кабель');
  const productId = row.id.slice(5);
  const product = catalog.products.get(productId);

  await say({ replyId: row.id });
  assert.ok(sent.at(-1).buttons.some((b) => b.id === `add:${productId}`));
  await say({ replyId: `add:${productId}` });
  await say({ text: 'сто' });
  assert.match(sent.at(-1).body, /Не понял/);
  await say({ text: '150 м' });
  assert.match(sent.at(-1).body, /150 м/);

  await say({ replyId: 'checkout' });
  await say({ text: 'Ерлан, ТОО Энерго' });
  await say({ text: 'Алматы' });
  await say({ replyId: 'no_comment' });
  assert.ok(sent.at(-1).buttons.some((b) => b.id === 'confirm_order'));
  await say({ replyId: 'confirm_order' });

  assert.equal(store.data.orders.length, 1);
  const order = store.data.orders[0];
  assert.equal(order.items[0].qty, 150);
  assert.equal(order.items[0].sku, product.sku);
  assert.equal(order.total, product.price * 150);
  assert.equal(order.city, 'Алматы');
  assert.ok(sent.some((m) => m.to === shop.managerPhone && /Заявка на КП/.test(m.body)));
  assert.deepEqual(store.session(PHONE).cart, {});
});

test('каталог: разделы и товары листаются по 9 + «Ещё»', async () => {
  const { sent, say } = setup();
  await say({ replyId: 'catalog' });
  let rows = sent.at(-1).rows;
  assert.ok(rows.length <= 10);
  if (catalog.categories.length > 9) assert.equal(rows.at(-1).id, 'cats:9');

  const big = catalog.categories.find((c) => catalog.byCategory(c.id).length > 20);
  await say({ replyId: `cat:${big.id}:0` });
  rows = sent.at(-1).rows;
  assert.equal(rows.length, 10);
  assert.equal(rows.at(-1).id, `cat:${big.id}:9`);
  await say({ replyId: `cat:${big.id}:9` });
  assert.equal(sent.at(-1).rows[0].id, `prod:${catalog.byCategory(big.id)[9].id}`);
  for (const r of sent.at(-1).rows) assert.ok(r.id.length <= 200);
});

test('подтверждение без оформления не создаёт заказ', async () => {
  const { store, say } = setup();
  const id = catalog.byCategory(catalog.categories[0].id)[0].id;
  await say({ replyId: `add:${id}` });
  await say({ text: '5' });
  await say({ replyId: 'confirm_order' });
  assert.equal(store.data.orders.length, 0);
});

test('ничего не найдено → предлагаем менеджера', async () => {
  const { sent, say } = setup();
  await say({ text: 'фывапролдж' });
  assert.ok(sent.at(-1).buttons.some((b) => b.id === 'manager'));
});

test('режим менеджера: бот молчит до команды «меню»', async () => {
  const { sent, say } = setup();
  await say({ replyId: 'manager' });
  const count = sent.length;
  await say({ text: 'Есть доставка в Актау?' });
  assert.equal(sent.length, count);
  await say({ text: 'меню' });
  assert.equal(sent.length, count + 1);
});

test('AI-консультант получает найденные товары, под ответом — список', async () => {
  const calls = [];
  const assistant = {
    userTurn: (text, found) => `${text}\n[${found.map((p) => p.title).join('; ')}]`,
    reply: async (h) => { calls.push(structuredClone(h)); return 'Для розетки берите 3×2,5'; },
  };
  const { sent, store, say } = setup(assistant);
  await say({ text: 'какой кабель ВВГ 3х2,5 взять на розетки?' });
  assert.match(calls[0][0].content, /ВВГ/);
  assert.equal(sent.at(-2).body, 'Для розетки берите 3×2,5');
  assert.equal(sent.at(-1).type, 'list');
  assert.equal(store.session(PHONE).history.length, 2);
});

test('ошибка AI не ломает историю', async () => {
  const assistant = { userTurn: (t) => t, reply: async () => { throw new Error('boom'); } };
  const { store, sent, say } = setup(assistant);
  await say({ text: 'есть доставка в Атырау?' });
  assert.equal(store.session(PHONE).history.length, 0);
  assert.ok(sent.at(-1).buttons.some((b) => b.id === 'manager'));
});

test('поиск понимает разные записи сечения и артикул', () => {
  const a = catalog.search('ВВГ нг 3x2.5').items.map((p) => p.id);
  const b = catalog.search('ввгнг 3*2,5').items.map((p) => p.id);
  assert.ok(a.length && b.length);
  assert.ok(b.every((id) => a.includes(id)) || a.every((id) => b.includes(id)));
  const any = [...catalog.products.values()].find((p) => p.sku && p.sku.length > 3);
  assert.equal(catalog.search(any.sku).items[0].sku, any.sku);
});

test('разбор вебхука и проверка подписи', () => {
  const body = {
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '7999', profile: { name: 'Олег' } }],
      messages: [
        { id: 'm1', from: '7999', type: 'text', text: { body: 'привет' } },
        { id: 'm2', from: '7999', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'cat:audio' } } },
      ],
    } }] }],
  };
  const msgs = extractMessages(body);
  assert.deepEqual(msgs[0], { id: 'm1', from: '7999', name: 'Олег', text: 'привет' });
  assert.equal(msgs[1].replyId, 'cat:audio');

  const raw = Buffer.from(JSON.stringify(body));
  const sig = `sha256=${crypto.createHmac('sha256', 'secret').update(raw).digest('hex')}`;
  assert.ok(isValidSignature(raw, sig, 'secret'));
  assert.ok(!isValidSignature(raw, 'sha256=bad', 'secret'));
});
