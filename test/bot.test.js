import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SalesBot } from '../src/bot.js';
import { Store } from '../src/store.js';
import { loadCatalog } from '../src/catalog.js';
import { extractMessages, isValidSignature } from '../src/webhook.js';

const catalog = loadCatalog(new URL('../data/catalog.json', import.meta.url).pathname);
const shop = { name: 'Тест', currency: '₽', managerPhone: '70000000000' };

function setup(assistant = null) {
  const sent = [];
  const wa = {
    text: async (to, body) => sent.push({ to, type: 'text', body }),
    buttons: async (to, body, buttons) => sent.push({ to, type: 'buttons', body, buttons }),
    list: async (to, body, button, rows) => sent.push({ to, type: 'list', body, rows }),
  };
  const store = new Store(null);
  const bot = new SalesBot({ wa, store, catalog, shop, assistant, logger: { error() {} } });
  return { bot, store, sent, say: (m) => bot.handle({ from: '79990001122', ...m }) };
}

test('полный сценарий: каталог → корзина → оформление заказа', async () => {
  const { store, sent, say } = setup();
  await say({ text: 'Привет', name: 'Анна' });
  assert.match(sent.at(-1).body, /Анна/);

  await say({ replyId: 'catalog' });
  assert.equal(sent.at(-1).type, 'list');
  await say({ replyId: 'cat:phones' });
  assert.ok(sent.at(-1).rows.some((r) => r.id === 'prod:p1'));
  await say({ replyId: 'add:p1' });
  await say({ replyId: 'add:p1' });
  await say({ replyId: 'add:c2' });
  assert.match(sent.at(-1).body, /50\s770/);

  await say({ replyId: 'checkout' });
  await say({ text: 'Анна Иванова' });
  await say({ text: 'Москва, ул. Ленина, 1' });
  assert.ok(sent.at(-1).buttons.some((b) => b.id === 'confirm_order'));
  await say({ replyId: 'confirm_order' });

  assert.equal(store.data.orders.length, 1);
  const order = store.data.orders[0];
  assert.equal(order.total, 50770);
  assert.equal(order.address, 'Москва, ул. Ленина, 1');
  assert.ok(sent.some((m) => m.to === shop.managerPhone && /Новый заказ/.test(m.body)));
  assert.deepEqual(store.session('79990001122').cart, {});
});

test('подтверждение без оформления не создаёт заказ', async () => {
  const { store, say } = setup();
  await say({ replyId: 'add:p2' });
  await say({ replyId: 'confirm_order' });
  assert.equal(store.data.orders.length, 0);
});

test('режим менеджера: бот молчит до команды «меню»', async () => {
  const { sent, say } = setup();
  await say({ replyId: 'manager' });
  const count = sent.length;
  await say({ text: 'Здравствуйте, есть доставка в Казань?' });
  assert.equal(sent.length, count);
  await say({ text: 'меню' });
  assert.equal(sent.length, count + 1);
});

test('свободный текст уходит AI-консультанту с историей', async () => {
  const calls = [];
  const assistant = { reply: async (h) => { calls.push(structuredClone(h)); return 'Рекомендую Nova X'; } };
  const { sent, store, say } = setup(assistant);
  await say({ text: 'Какой телефон с хорошей камерой?' });
  assert.equal(sent.at(-1).body, 'Рекомендую Nova X');
  assert.equal(calls[0][0].role, 'user');
  assert.equal(store.session('79990001122').history.length, 2);
});

test('ошибка AI не ломает историю', async () => {
  const assistant = { reply: async () => { throw new Error('boom'); } };
  const { store, sent, say } = setup(assistant);
  await say({ text: 'вопрос' });
  assert.equal(store.session('79990001122').history.length, 0);
  assert.ok(sent.at(-1).buttons.some((b) => b.id === 'manager'));
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
