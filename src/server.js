import express from 'express';
import { config } from './config.js';
import { loadCatalog } from './catalog.js';
import { Store } from './store.js';
import { WhatsAppClient } from './whatsapp.js';
import { SalesAssistant } from './ai.js';
import { SalesBot } from './bot.js';
import { extractMessages, isValidSignature } from './webhook.js';

const catalog = loadCatalog(config.catalogPath);
const store = new Store(config.dbPath);
const wa = new WhatsAppClient(config.whatsapp);
const assistant = config.ai.apiKey
  ? new SalesAssistant({ ...config.ai, shop: config.shop, catalog, shopInfoPath: config.shopInfoPath })
  : null;
const bot = new SalesBot({ wa, store, catalog, shop: config.shop, assistant });

// Meta может доставить одно сообщение повторно — отбрасываем дубли.
const seen = new Set();
function isDuplicate(id) {
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  return false;
}

// Сообщения одного клиента обрабатываем строго по очереди.
const queues = new Map();
function enqueue(phone, task) {
  const prev = queues.get(phone) ?? Promise.resolve();
  const next = prev.then(task).catch((err) => console.error(`Ошибка обработки для ${phone}:`, err));
  queues.set(phone, next);
  next.finally(() => queues.get(phone) === next && queues.delete(phone));
}

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/', (_req, res) => res.send('WhatsApp sales bot is running'));

// Подтверждение вебхука в Meta for Developers.
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (!isValidSignature(req.rawBody, req.get('x-hub-signature-256'), config.whatsapp.appSecret)) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // отвечаем сразу, иначе Meta будет повторять доставку
  for (const msg of extractMessages(req.body)) {
    if (isDuplicate(msg.id)) continue;
    wa.markRead(msg.id);
    enqueue(msg.from, () => bot.handle(msg));
  }
});

// Список заказов для менеджера: GET /orders?token=<WHATSAPP_VERIFY_TOKEN>
app.get('/orders', (req, res) => {
  if (!config.whatsapp.verifyToken || req.query.token !== config.whatsapp.verifyToken) return res.sendStatus(403);
  res.json(store.data.orders);
});

app.listen(config.port, () => {
  console.log(`Бот «${config.shop.name}» (${catalog.size} товаров) слушает порт ${config.port}. AI-консультант: ${assistant ? 'включён' : 'выключен'}`);
  if (!config.whatsapp.token || !config.whatsapp.phoneNumberId) {
    console.warn('⚠️  Не заданы WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID — отправка сообщений работать не будет.');
  }
});
