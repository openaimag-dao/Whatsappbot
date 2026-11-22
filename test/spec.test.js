import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { SalesBot } from '../src/bot.js';
import { Store } from '../src/store.js';
import { loadCatalog } from '../src/catalog.js';
import { SpecReader, excelToText, convertQty } from '../src/spec.js';
import { extractMessages } from '../src/webhook.js';

const catalog = loadCatalog(new URL('../data/catalog.json', import.meta.url).pathname);
const shop = { name: 'Тест', currency: '₸', phone: '+7', hours: 'Пн–Пт', managerPhone: '70000000000' };
const PHONE = '77010001122';
const JPEG = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mime: 'image/jpeg', filename: '' };

// Позиции с фото из реальной заявки (часть)
const POSITIONS = [
  { name: 'Скоба СК-7-1А', query: 'Скоба СК-7-1А', codes: ['СК-7-1А'], qty: 42, unit: 'шт' },
  { name: 'Разъединитель наружной установки (РЛНД-10/400 У1)', query: 'Разъединитель РЛНД-10/400', codes: ['РЛНД-10/400 У1'], qty: 15, unit: 'шт' },
  { name: 'Кожух защитный для ответвительного зажима (SP15)', query: 'Кожух SP15', codes: ['SP15'], qty: 131, unit: 'шт' },
];

function setup({ spec, specBatchMs = 0, defer } = {}) {
  const sent = [];
  const channel = {
    text: async (to, body) => sent.push({ to, type: 'text', body }),
    buttons: async (to, body, buttons) => sent.push({ to, type: 'buttons', body, buttons }),
    list: async (to, body, _b, rows) => sent.push({ to, type: 'list', body, rows }),
    document: async (to, buffer, filename, caption) => sent.push({ to, type: 'document', filename, caption }),
    download: async () => ({ buffer: JPEG.buffer, mime: 'image/jpeg' }),
  };
  const store = new Store(null);
  const bot = new SalesBot({ channel, store, catalog, shop, spec, specBatchMs, defer, logger: { error() {} } });
  return { bot, store, sent, say: (m) => bot.handle({ from: PHONE, ...m }) };
}

// Подбор как у модели: точное совпадение по марке, иначе «нет».
const fakeSpec = (calls = []) => ({
  extract: async (files, text) => {
    calls.push({ files: files.length, text });
    return { positions: POSITIONS, note: '' };
  },
  match: async (positions) =>
    positions.map((p) => {
      const c = p.candidates.find((x) => p.codes.some((code) => x.title.includes(code.split(' ')[0])));
      return c ? { productId: c.id, kind: 'exact', comment: '' } : { productId: null, kind: 'none', comment: '' };
    }),
});

test('фото спецификации → позиции в заявке, ненайденные — «уточним у поставщиков»', async () => {
  const calls = [];
  const { store, sent, say } = setup({ spec: fakeSpec(calls) });
  await say({ media: [JPEG], text: 'Нужно КП' });
  assert.equal(calls[0].files, 1);
  assert.equal(calls[0].text, 'Нужно КП');
  const summary = sent.find((m) => /Разобрал спецификацию/.test(m.body));
  assert.ok(summary, 'итог разбора отправлен');
  assert.match(summary.body, /Скоба СК-7-1А — 42 шт/);
  assert.match(summary.body, /Уточним у поставщиков \(1\)/);
  assert.ok(sent.at(-1).buttons.some((b) => b.id === 'checkout'));

  const cart = store.session(PHONE).cart;
  assert.equal(Object.keys(cart).length, 3);
  const skoba = catalog.search('СК-7-1А').items[0];
  assert.equal(cart[skoba.id], 42);

  // Оформление: позиция без цены уходит в КП как «уточняем», найденные — с ценой
  await say({ replyId: 'checkout' });
  await say({ text: 'Ерлан, ТОО Энерго' });
  await say({ text: 'Шымкент' });
  await say({ replyId: 'no_comment' });
  await say({ replyId: 'confirm_order' });
  const order = store.data.orders[0];
  assert.equal(order.items.length, 3);
  assert.equal(order.items.find((i) => i.source === 'spec').title, POSITIONS[2].name);
});

test('несколько фото подряд разбираются одной пачкой', async () => {
  const calls = [];
  const deferred = [];
  const { bot, sent, say } = setup({ spec: fakeSpec(calls), specBatchMs: 20, defer: (_k, fn) => deferred.push(fn()) });
  await say({ media: [JPEG] });
  await say({ media: [JPEG] });
  await say({ media: [JPEG] });
  assert.equal(sent.filter((m) => /разбираю спецификацию/.test(m.body)).length, 1, 'одно подтверждение');
  await new Promise((r) => setTimeout(r, 60));
  await Promise.all(deferred);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].files, 3);
  assert.equal(bot.specTimers.size, 0);
});

test('без ключа Claude спецификация уходит менеджеру', async () => {
  const { sent, say } = setup({ spec: null });
  await say({ media: [JPEG] });
  assert.ok(sent.some((m) => m.to === shop.managerPhone && /прислал спецификацию/.test(m.body)));
  assert.match(sent.find((m) => m.to === PHONE && /менеджеру/.test(m.body)).body, /Передал спецификацию/);
});

test('ошибка модели → спецификация уходит менеджеру, бот не падает', async () => {
  const { sent, say } = setup({ spec: { extract: async () => { throw new Error('overloaded'); } } });
  await say({ media: [JPEG] });
  assert.ok(sent.some((m) => m.to === shop.managerPhone && /overloaded/.test(m.body)));
});

test('неподдерживаемый формат — просим фото, PDF или Excel', async () => {
  const { sent, say } = setup({ spec: fakeSpec() });
  await say({ media: [{ buffer: Buffer.from('x'), mime: 'application/msword', filename: 'заявка.doc' }] });
  assert.match(sent.at(-1).body, /заявка\.doc/);
});

test('Excel превращается в текст таблицы', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Заявка');
  ws.addRow(['№', 'Наименование', 'Ед.', 'Кол-во']);
  ws.addRow([1, 'Скоба СК-7-1А', 'шт', 42]);
  const text = await excelToText(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.match(text, /Скоба СК-7-1А\tшт\t42/);
});

test('SpecReader: запрос к Claude и разбор структурированного ответа', async () => {
  const requests = [];
  const client = {
    beta: {
      messages: {
        create: async (req) => {
          requests.push(req);
          const body = requests.length === 1
            ? { positions: [{ name: 'Скоба СК-7-1А', query: 'Скоба СК-7-1А', codes: [], qty: 42, unit: 'шт' }], note: '' }
            : { matches: [{ position: 1, product_id: 'x1', kind: 'exact', comment: '' }] };
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] };
        },
      },
    },
  };
  const reader = new SpecReader({ model: 'claude-opus-5-5', client });
  const { positions } = await reader.extract([JPEG, { buffer: Buffer.from('%PDF'), mime: 'application/pdf' }], 'срочно');
  assert.equal(positions[0].qty, 42);
  const req = requests[0];
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.messages[0].content[0].type, 'image');
  assert.equal(req.messages[0].content[1].type, 'document');
  assert.match(req.messages[0].content.at(-1).text, /срочно/);

  const matches = await reader.match([{ name: 'Скоба', qty: 1, unit: 'шт', candidates: [{ id: 'x1', title: 'Скоба СК-7-1А', unit: 'шт' }] }]);
  assert.deepEqual(matches[0], { productId: 'x1', kind: 'exact', comment: '' });
  // id не из списка кандидатов не принимается
  requests.length = 1;
  client.beta.messages.create = async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"matches":[{"position":1,"product_id":"zzz","kind":"exact","comment":""}]}' }] });
  assert.equal((await reader.match([{ name: 'a', qty: 1, unit: 'шт', candidates: [{ id: 'x1', title: 'a', unit: 'шт' }] }]))[0].productId, null);
});

test('вебхук: фото и документ с подписью', () => {
  const body = { entry: [{ changes: [{ value: { messages: [
    { id: 'm1', from: '7701', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'КП пожалуйста' } },
    { id: 'm2', from: '7701', type: 'document', document: { id: 'MEDIA2', mime_type: 'application/pdf', filename: 'спец.pdf' } },
  ] } }] }] };
  const [a, b] = extractMessages(body);
  assert.deepEqual(a.media, [{ id: 'MEDIA1', mime: 'image/jpeg', filename: '' }]);
  assert.equal(a.text, 'КП пожалуйста');
  assert.equal(b.media[0].filename, 'спец.pdf');
});

test('перевод единиц', () => {
  assert.equal(convertQty(1.5, 'км', 'м'), 1500);
  assert.equal(convertQty(10, 'шт', 'шт'), 10);
});
