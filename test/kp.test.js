import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SalesBot } from '../src/bot.js';
import { Store } from '../src/store.js';
import { loadCatalog } from '../src/catalog.js';
import { amountInWords, numberToWords, vatIncluded } from '../src/money.js';
import { matchEkt, parseEktSearch, priceFromEkt } from '../src/ekt.js';
import { config } from '../src/config.js';

const catalog = loadCatalog(new URL('../data/catalog.json', import.meta.url).pathname);
const shop = { name: 'Тест', currency: '₸', phone: '+7 700 000-00-00', hours: 'Пн–Пт', managerPhone: '70000000000' };
const ektItems = parseEktSearch(fs.readFileSync(new URL('./fixtures/ekt-search.md', import.meta.url), 'utf8'));
const pricing = { ektUndercut: 0.05, ektDiscount: 0.2, ektDiscountByCategory: {}, minMargin: 0.1 };
const PHONE = '77010001122';

test('сумма прописью и НДС как в счёте AIMAG', () => {
  assert.equal(amountInWords(34565700), 'Тридцать четыре миллиона пятьсот шестьдесят пять тысяч семьсот тенге 00 тиын');
  assert.equal(vatIncluded(34565700), 4767682.76);
  assert.equal(numberToWords(21002), 'двадцать одна тысяча два');
  assert.equal(numberToWords(1000000), 'один миллион');
  assert.equal(amountInWords(1277.5), 'Одна тысяча двести семьдесят семь тенге 50 тиын');
});

test('ekt.kz: разбор поиска, подбор и цена −5%', () => {
  assert.equal(ektItems.length, 9);
  const noPrice = ektItems.find((i) => i.title.startsWith('ВВГ нг LS 3х2,5'));
  assert.equal(noPrice.price, 0);
  assert.equal(noPrice.onOrder, true);

  const found = matchEkt('кабель ВВГнг 5х2,5', ektItems);
  assert.deepEqual(found.map((i) => i.price), [1344, 1407]);
  assert.equal(found[0].unit, 'м');

  const q = priceFromEkt(found[0], pricing);
  assert.equal(q.priceVat, 1277); // 1344 × 0.95
  assert.equal(q.margin, 0.19); // 1277 / (1344 × 0.8) − 1
  assert.equal(q.needsApproval, false);
  assert.equal(priceFromEkt(found[0], { ...pricing, ektDiscount: 0.1 }).needsApproval, true);
});

function setup({ discount = 0.2, sellers = null, store: givenStore = null, now = '2026-10-17T10:00:00' } = {}) {
  const sent = [];
  const channel = {
    text: async (to, body) => sent.push({ to, type: 'text', body }),
    buttons: async (to, body, buttons) => sent.push({ to, type: 'buttons', body, buttons }),
    list: async (to, body, button, rows) => sent.push({ to, type: 'list', body, rows }),
    document: async (to, pdf, filename, caption) => sent.push({ to, type: 'document', pdf, filename, caption }),
  };
  const ekt = {
    enabled: true,
    search: async (q) =>
      matchEkt(q, ektItems)
        .filter((i) => i.price > 0)
        .map((i) => ({ ...i, quote: priceFromEkt(i, { ...pricing, ektDiscount: discount }) })),
  };
  const store = givenStore ?? new Store(null);
  const company = { ...config.company, stampPath: '' };
  const bot = new SalesBot({ channel, store, catalog, shop, ekt, company, sellers, pricing, now: () => new Date(now), logger: { error() {} } });
  return { store, sent, say: (m, from = PHONE) => bot.handle({ from, ...m }) };
}

async function orderFromEkt(say, sent) {
  await say({ text: 'кабель ввгнг (а) 5х2,5 гост ekt' });
  const list = sent.at(-1);
  assert.equal(list.type, 'list');
  assert.match(list.body, /партнёра-поставщика/);
  const row = list.rows[0];
  await say({ replyId: row.id });
  await say({ replyId: `add:${row.id.slice(5)}` });
  await say({ text: '100' });
  await say({ replyId: 'checkout' });
  await say({ text: 'Ерлан, ТОО Тест' });
  await say({ text: 'Актобе' });
  await say({ replyId: 'no_comment' });
  await say({ replyId: 'confirm_order' });
}

test('ekt.kz → заявка → КП в PDF → «Согласен» → счёт', async () => {
  const { store, sent, say } = setup();
  await orderFromEkt(say, sent);

  const order = store.data.orders[0];
  assert.equal(order.status, 'kp_sent');
  assert.equal(order.kp.number, 'КП-1017-01');
  assert.equal(order.kp.total, 127700);
  const kp = sent.find((m) => m.type === 'document' && m.to === PHONE);
  assert.equal(kp.filename, 'КП-1017-01.pdf');
  assert.equal(kp.pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(sent.some((m) => m.type === 'document' && m.to === shop.managerPhone), 'КП уходит и менеджеру');
  const offer = sent.findLast((m) => m.to === PHONE && m.type === 'buttons');
  assert.match(offer.body, /127 700,00 ₸/);

  await say({ replyId: offer.buttons[0].id });
  assert.match(sent.at(-1).body, /реквизиты/);
  await say({ text: 'БИН 060340007296, ТОО «Тест», г. Актобе, ул. Бурабай, 139Б' });

  assert.equal(order.status, 'invoice_sent');
  assert.equal(order.invoice.number, '1017-01');
  assert.equal(order.buyer.text, 'БИН 060340007296, ТОО «Тест», г. Актобе, ул. Бурабай, 139Б');
  const inv = sent.findLast((m) => m.type === 'document' && m.to === PHONE);
  assert.equal(inv.filename, 'Счет_1017-01.pdf');
});

test('низкая прибыль: КП только после «ок <номер>» менеджера', async () => {
  const { store, sent, say } = setup({ discount: 0.1 });
  await orderFromEkt(say, sent);
  const order = store.data.orders[0];
  assert.equal(order.status, 'awaiting_approval');
  assert.ok(!sent.some((m) => m.type === 'document' && m.to === PHONE), 'клиенту КП ещё не уходит');
  assert.match(sent.findLast((m) => m.to === shop.managerPhone).body, new RegExp(`ок ${order.number}`));

  await say({ text: `ок ${order.number}` }, shop.managerPhone);
  assert.equal(order.status, 'kp_sent');
  assert.ok(sent.some((m) => m.type === 'document' && m.to === PHONE));
});

const BEREKE = { key: 'bereke', brand: 'BEREKE', tagline: '', name: 'ИП «Bereke»', idLabel: 'БИН', iin: '050404601141', director: 'Тест', address: 'Шымкент', phone: '+7 (705) 615-1717', bank: 'Банк', bik: 'BIK', iik: 'KZ00', knp: '710', stampPath: '' };

test('«береке <номер>»: КП перевыставляется от Bereke, счёт тоже от Bereke', async () => {
  const sellers = { aimag: { ...config.company, stampPath: '' }, bereke: BEREKE };
  const { store, sent, say } = setup({ sellers });
  await orderFromEkt(say, sent);
  const order = store.data.orders[0];
  assert.equal(order.seller, 'aimag');

  await say({ text: `береке ${order.number}` }, shop.managerPhone);
  assert.equal(order.seller, 'bereke');
  assert.equal(order.kp.seller, 'bereke');
  assert.equal(order.kp.number, 'КП-1017-02');
  assert.match(sent.findLast((m) => m.to === shop.managerPhone && m.type === 'text').body, /перевыставлено от ИП «Bereke»/);
  const kpPdf = sent.findLast((m) => m.type === 'document' && m.to === PHONE).pdf;
  assert.equal(kpPdf.subarray(0, 4).toString(), '%PDF');

  const offer = sent.findLast((m) => m.to === PHONE && m.type === 'buttons');
  await say({ replyId: offer.buttons[0].id });
  await say({ text: 'БИН 060340007296, ТОО «Тест», г. Актобе' });
  assert.equal(order.status, 'invoice_sent');
  await say({ text: `аймаг ${order.number}` }, shop.managerPhone);
  assert.equal(order.seller, 'bereke', 'после счёта продавец не меняется');
});

test('Bereke не настроена — понятный ответ менеджеру', async () => {
  const { store, sent, say } = setup();
  await orderFromEkt(say, sent);
  await say({ text: `береке ${store.data.orders[0].number}` }, shop.managerPhone);
  assert.match(sent.at(-1).body, /не заданы/);
});

test('память цен: вторая заявка получает цену из прошлого КП и пересчёт прибыли', async () => {
  const store = new Store(null);
  const first = setup({ store });
  await orderFromEkt(first.say, first.sent);
  const key = SalesBot.priceKey(store.data.orders[0].items[0]);
  assert.equal(store.quoted(key).priceVat, 1277);
  assert.equal(store.quoted(key).kp, 'КП-1017-01');

  // Цену в прошлом КП дали ниже — новая заявка должна получить её же, а прибыль пересчитаться.
  store.quoted(key, { ...store.quoted(key), priceVat: 1150 });
  const second = setup({ store, now: '2026-10-20T10:00:00' });
  await orderFromEkt((m, from = '77019998877') => second.say(m, from), second.sent);
  const order = store.data.orders[1];
  assert.equal(order.items[0].priceVat, 1150);
  assert.equal(order.items[0].priceFromKp.kp, 'КП-1017-01');
  assert.equal(order.items[0].quote.margin, 0.07); // 1150 / (1344 × 0.8) − 1
  assert.equal(order.status, 'awaiting_approval', 'прибыль ниже минимума — на подтверждение');
  assert.match(second.sent.findLast((m) => m.to === shop.managerPhone).body, /Цены из прошлых КП[\s\S]*КП-1017-01/);
});

test('память цен: старше PRICE_MEMORY_DAYS не используется', async () => {
  const store = new Store(null);
  const first = setup({ store });
  await orderFromEkt(first.say, first.sent);
  const key = SalesBot.priceKey(store.data.orders[0].items[0]);
  store.quoted(key, { ...store.quoted(key), priceVat: 1150 });
  const later = setup({ store, now: '2026-12-01T10:00:00' });
  await orderFromEkt((m, from = '77019998877') => later.say(m, from), later.sent);
  assert.equal(store.data.orders[1].items[0].priceVat, 1277);
});
