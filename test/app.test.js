import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';

function config(overrides = {}) {
  return {
    port: 0,
    whatsapp: { token: 't', phoneNumberId: '1', verifyToken: 'verify', appSecret: 'secret', apiVersion: 'v23.0' },
    shop: { name: 'AIMAG ELECTRIC', currency: '₸', phone: '+7', hours: 'Пн–Пт', managerPhone: '77000000000' },
    ai: { apiKey: '' },
    company: { name: 'ИП «AIMAG»', iin: '890922301639', director: 'Оразбаев Е. О.', address: 'Шымкент', phone: '+7', bank: 'Банк', bik: 'BIK', iik: 'KZ00', knp: '710', stampPath: '/nonexistent.png' },
    adminToken: '',
    simulatorEnabled: true,
    catalogPath: new URL('../data/catalog.json', import.meta.url).pathname,
    shopInfoPath: null,
    ...overrides,
  };
}

async function start(cfg, deps = {}) {
  const sent = [];
  const whatsapp = {
    text: async (to, body) => sent.push({ to, type: 'text', body }),
    buttons: async (to, body, buttons) => sent.push({ to, type: 'buttons', body, buttons }),
    list: async (to, body, _b, rows) => sent.push({ to, type: 'list', body, rows }),
    markRead: () => {},
  };
  const ctx = createApp(cfg, { store: new Store(null), whatsapp, assistant: null, ekt: null, ...deps });
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { ...ctx, sent, base, post, close: () => server.close() };
}

test('эмулятор: диалог и заявка, уведомление менеджеру остаётся в эмуляторе', async (t) => {
  const s = await start(config());
  t.after(s.close);
  const say = async (body) => (await s.post('/simulator/api/message', { user: 'u1', ...body })).json();

  let r = await say({ text: 'привет' });
  assert.equal(r.messages[0].type, 'buttons');
  r = await say({ text: 'ВВГнг 3х2,5' });
  const row = r.messages.at(-1).rows.find((x) => x.id.startsWith('prod:'));
  assert.ok(row.title.length <= 24, 'лимиты WhatsApp применяются и в эмуляторе');
  await say({ replyId: `add:${row.id.slice(5)}` });
  await say({ text: '100' });
  await say({ replyId: 'checkout' });
  await say({ text: 'Тест' });
  await say({ text: 'Шымкент' });
  await say({ replyId: 'no_comment' });
  r = await say({ replyId: 'confirm_order' });

  assert.ok(r.messages.some((m) => /Заявка|КП/.test(m.body ?? m.caption)));
  assert.ok(r.manager.length > 0, 'менеджер получил уведомление в эмуляторе');
  assert.equal(s.store.data.orders[0].channel, 'simulator');
  const doc = [...r.messages, ...r.manager].find((m) => m.type === 'document');
  assert.ok(doc, 'КП приходит PDF-документом');
  const pdf = await fetch(`${s.base}/simulator/files/${doc.fileId}`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal((await pdf.arrayBuffer()).byteLength, doc.size);
  assert.equal(s.sent.length, 0, 'в настоящий WhatsApp ничего не отправлено');
});

test('эмулятор закрыт токеном, если задан ADMIN_TOKEN', async (t) => {
  const s = await start(config({ adminToken: 'adm' }));
  t.after(s.close);
  assert.equal((await s.post('/simulator/api/message', { user: 'u1', text: 'привет' })).status, 403);
  assert.equal((await s.post('/simulator/api/message', { user: 'u1', text: 'привет' }, { 'X-Admin-Token': 'adm' })).status, 200);
  assert.equal((await fetch(`${s.base}/orders`)).status, 403);
  assert.equal((await fetch(`${s.base}/orders?token=adm`)).status, 200);
});

test('вебхук WhatsApp: проверка подписи и ответ клиенту', async (t) => {
  const s = await start(config());
  t.after(s.close);
  const body = {
    entry: [{ changes: [{ value: { messages: [{ id: 'wamid.1', from: '77011112233', type: 'text', text: { body: 'привет' } }] } }] }],
  };
  const raw = JSON.stringify(body);
  assert.equal((await s.post('/webhook', body, { 'X-Hub-Signature-256': 'sha256=bad' })).status, 401);
  const sig = `sha256=${crypto.createHmac('sha256', 'secret').update(raw).digest('hex')}`;
  assert.equal((await s.post('/webhook', body, { 'X-Hub-Signature-256': sig })).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.sent[0]?.to, '77011112233');
  // повторная доставка того же сообщения игнорируется
  await s.post('/webhook', body, { 'X-Hub-Signature-256': sig });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.sent.length, 1);

  const verify = await fetch(`${s.base}/webhook?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=42`);
  assert.equal(await verify.text(), '42');
});
