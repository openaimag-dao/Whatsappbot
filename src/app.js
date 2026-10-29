import express from 'express';
import { config as defaultConfig } from './config.js';
import { loadCatalog } from './catalog.js';
import { Store } from './store.js';
import { WhatsAppClient } from './channels/whatsapp.js';
import { SimulatorChannel } from './channels/simulator.js';
import { SalesAssistant } from './ai.js';
import { SalesBot } from './bot.js';
import { EktClient } from './ekt.js';
import { SpecReader } from './spec.js';
import { extractMessages, isValidSignature } from './webhook.js';

// Сборка приложения: общие каталог/хранилище/AI и по боту на каждый канал.
export function createApp(config = defaultConfig, deps = {}) {
  const catalog = deps.catalog ?? loadCatalog(config.catalogPath);
  const store = deps.store ?? new Store(config.dbPath);
  const assistant =
    deps.assistant !== undefined
      ? deps.assistant
      : config.ai.apiKey
        ? new SalesAssistant({ ...config.ai, shop: config.shop, catalog, shopInfoPath: config.shopInfoPath })
        : null;

  const ekt = deps.ekt !== undefined ? deps.ekt : new EktClient({ ...config.firecrawl, pricing: config.pricing });
  const spec = deps.spec !== undefined ? deps.spec : config.ai.apiKey ? new SpecReader(config.ai) : null;
  const common = { store, catalog, assistant, ekt, spec, company: config.company, ...(deps.botOptions ?? {}) };

  // Сообщения одного клиента обрабатываем строго по очереди.
  const queues = new Map();
  const enqueue = (key, task) => {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(task);
    const tail = next.catch((err) => console.error(`Ошибка обработки для ${key}:`, err));
    queues.set(key, tail);
    tail.finally(() => queues.get(key) === tail && queues.delete(key));
    return next;
  };

  const wa = deps.whatsapp ?? new WhatsAppClient(config.whatsapp);
  const bot = new SalesBot({ ...common, channel: wa, shop: config.shop, specBatchMs: config.specBatchMs ?? 0, defer: enqueue });

  // Эмулятор: уведомления «менеджеру» остаются внутри эмулятора, а не уходят в WhatsApp.
  const SIM_MANAGER = 'sim-manager';
  const sim = new SimulatorChannel();
  const simBot = new SalesBot({ ...common, channel: sim, shop: { ...config.shop, managerPhone: SIM_MANAGER }, source: 'simulator' });

  // Meta может доставить одно сообщение повторно — отбрасываем дубли.
  const seen = new Set();
  const isDuplicate = (id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > 5000) seen.delete(seen.values().next().value);
    return false;
  };

  const requireAdmin = (req, res, next) => {
    if (!config.adminToken) return next();
    const token = req.get('x-admin-token') || req.query.token;
    return token === config.adminToken ? next() : res.sendStatus(403);
  };

  const app = express();
  app.use(express.json({ limit: '30mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  app.get('/', (_req, res) =>
    res.send(`${config.shop.name} WhatsApp bot is running${config.simulatorEnabled ? ' — <a href="/simulator">эмулятор</a>' : ''}`),
  );

  // --- WhatsApp Cloud API ---
  app.get('/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && config.whatsapp.verifyToken && token === config.whatsapp.verifyToken) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  app.post('/webhook', (req, res) => {
    if (!isValidSignature(req.rawBody, req.get('x-hub-signature-256'), config.whatsapp.appSecret)) {
      return res.sendStatus(401);
    }
    res.sendStatus(200); // отвечаем сразу, иначе Meta будет повторять доставку
    for (const msg of extractMessages(req.body)) {
      if (isDuplicate(msg.id)) continue;
      wa.markRead?.(msg.id);
      enqueue(msg.from, () => bot.handle(msg));
    }
  });

  // --- Эмулятор чата (проверка бота без номера WhatsApp) ---
  if (config.simulatorEnabled) {
    const page = new URL('../public/simulator.html', import.meta.url).pathname;
    app.get('/simulator', (_req, res) => res.sendFile(page));
    app.get('/simulator/api/info', (_req, res) => res.json({ shop: config.shop.name, products: catalog.size, ai: Boolean(assistant), spec: Boolean(spec) }));

    const simUser = (req) => {
      const id = String(req.body?.user ?? '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
      return id ? `sim-${id}` : null;
    };

    // as: 'client' — пишет клиент; 'manager' — пишет менеджер (например, «ок 1023» для подтверждения КП).
    app.post('/simulator/api/message', requireAdmin, async (req, res) => {
      const user = simUser(req);
      if (!user) return res.status(400).json({ error: 'user required' });
      const { text, replyId, name, as } = req.body;
      const from = as === 'manager' ? SIM_MANAGER : user;
      // Файлы из эмулятора приходят base64 — сразу буфером, без скачивания из канала
      const media = (Array.isArray(req.body.files) ? req.body.files : []).slice(0, 10).map((f) => ({
        buffer: Buffer.from(String(f.data || ''), 'base64'),
        mime: String(f.mime || ''),
        filename: String(f.name || '').slice(0, 120),
      }));
      try {
        await enqueue(from, () =>
          simBot.handle({ from, name: name ? String(name).slice(0, 60) : undefined, text, replyId, ...(media.length ? { media } : {}) }),
        );
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ messages: sim.drain(user), manager: sim.drain(SIM_MANAGER) });
    });

    app.get('/simulator/files/:id', requireAdmin, (req, res) => {
      const file = sim.file(req.params.id);
      if (!file) return res.sendStatus(404);
      res.type('application/pdf');
      res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
      res.send(file.buffer);
    });

    app.post('/simulator/api/reset', requireAdmin, (req, res) => {
      const user = simUser(req);
      if (user) delete store.data.sessions[user];
      store.save();
      res.json({ ok: true });
    });
  }

  // Список заявок: GET /orders?token=<ADMIN_TOKEN>
  app.get('/orders', (req, res, next) => (config.adminToken ? next() : res.sendStatus(403)), requireAdmin, (_req, res) =>
    res.json(store.data.orders),
  );

  return { app, bot, simBot, sim, store, catalog, assistant, ekt, spec };
}
