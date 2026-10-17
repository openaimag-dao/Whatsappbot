import crypto from 'node:crypto';
import { formatPrice } from './catalog.js';
import { renderInvoice, renderKP, totals } from './documents.js';
import { money, round2, VAT_RATE } from './money.js';
import { convertQty, excelToText } from './spec.js';

const MENU_WORDS = ['меню', 'menu', 'start', 'старт', 'привет', 'здравствуйте', 'сәлем', 'салем', 'hi', 'hello', '/start'];
const MAX_HISTORY = 12;
const PAGE = 9; // 10-я строка списка WhatsApp — «Ещё ▶»
const MAX_SPEC_FILES = 10;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Логика диалога. Не зависит от HTTP — принимает входящее сообщение и шлёт ответы через канал (WhatsApp, эмулятор…).
export class SalesBot {
  constructor({
    channel, store, catalog, shop, assistant = null, ekt = null, company = null, docs = { renderKP, renderInvoice },
    spec = null, specBatchMs = 0, defer = (_key, fn) => fn(), source = 'whatsapp', now = () => new Date(), logger = console,
  }) {
    this.channel = channel;
    this.spec = spec;
    // Клиент часто шлёт спецификацию несколькими фото подряд — ждём паузу и разбираем всё вместе.
    this.specBatchMs = specBatchMs;
    this.defer = defer;
    this.specTimers = new Map();
    this.source = source;
    this.ekt = ekt;
    this.company = company;
    this.docs = docs;
    this.now = now;
    this.store = store;
    this.catalog = catalog;
    this.shop = shop;
    this.assistant = assistant;
    this.log = logger;
  }

  // Товар из каталога aimag.kz или найденный на ekt.kz
  product(id) {
    return this.catalog.products.get(id) || this.store.external(id);
  }

  // Цена за единицу с НДС для КП и счёта
  priceVat(p) {
    return p.priceVat ?? round2(p.price * (1 + VAT_RATE));
  }

  price(p) {
    return p.price > 0 ? `${formatPrice(p.price, this.shop.currency)}/${p.unit}` : 'цена по запросу';
  }

  // msg: { from, name, text?, replyId? }
  async handle(msg) {
    const s = this.store.session(msg.from);
    if (msg.name) s.profileName = msg.name;
    try {
      await this.#route(s, msg);
    } finally {
      this.store.save();
    }
  }

  async #route(s, msg) {
    const { from } = msg;
    const text = (msg.text || '').trim();
    const lower = text.toLowerCase();
    const id = msg.replyId || '';

    // Менеджер подтверждает КП, ожидающее проверки: «ок 1023»
    if (from === this.shop.managerPhone) {
      const m = lower.match(/^(?:ок|ok|да|отправ\S*)\s*№?\s*(\d{3,})/);
      if (m) return this.approveOrder(from, Number(m[1]));
    }

    // Клиент общается с менеджером — бот молчит, пока не попросят меню.
    if (s.state === 'manager' && !MENU_WORDS.includes(lower) && id !== 'menu') return;

    // Фото, PDF или Excel — спецификация
    if (msg.media?.length) return this.receiveSpec(from, s, msg);
    if (msg.specReady) return this.processSpec(from, s);

    if (id === 'menu' || MENU_WORDS.includes(lower)) return this.mainMenu(from, s);
    if (id === 'catalog' || lower === 'каталог') return this.showCategories(from, s, 0);
    if (id === 'cart' || ['корзина', 'заявка'].includes(lower)) return this.showCart(from, s);
    if (id === 'manager' || lower === 'менеджер') return this.callManager(from, s);
    if (id === 'search') {
      s.state = 'idle';
      return this.channel.text(from, '🔎 Напишите название, марку или артикул. Например: «ВВГнг 3х2,5», «СИП-4 4х50», «автомат 25А», «изолятор ШФ-20».');
    }
    if (id === 'cart_clear') {
      s.cart = {};
      s.cartNotes = {};
      s.state = 'idle';
      return this.channel.buttons(from, 'Заявка очищена.', [
        { id: 'catalog', title: 'Каталог' },
        { id: 'menu', title: 'Меню' },
      ]);
    }
    if (id === 'checkout') return this.startCheckout(from, s);
    if (id === 'confirm_order') return this.confirmOrder(from, s);
    if (id === 'cancel_order') {
      s.state = 'idle';
      return this.channel.buttons(from, 'Отправка отменена. Позиции остались в заявке.', [
        { id: 'cart', title: 'Заявка' },
        { id: 'menu', title: 'Меню' },
      ]);
    }
    if (id.startsWith('agree:')) return this.askBuyer(from, s, Number(id.slice(6)));
    if (s.state === 'invoice_buyer' && text) return this.sendInvoice(from, s, text);
    if (id.startsWith('cats:')) return this.showCategories(from, s, Number(id.slice(5)) || 0);
    if (id.startsWith('cat:')) {
      const [, cat, offset] = id.split(':');
      return this.showProducts(from, s, cat, Number(offset) || 0);
    }
    if (id.startsWith('found:')) return this.showFound(from, s, Number(id.slice(6)) || 0);
    if (id.startsWith('prod:')) return this.showProduct(from, s, id.slice(5));
    if (id.startsWith('add:')) return this.askQuantity(from, s, id.slice(4));

    if (s.state === 'qty' && text) return this.addToCart(from, s, text);
    if (s.state === 'checkout_name' && text) {
      s.checkout.name = text.slice(0, 150);
      s.state = 'checkout_city';
      return this.channel.text(from, 'Спасибо! В какой город доставить? (или напишите «самовывоз» — склад в Шымкенте)');
    }
    if (s.state === 'checkout_city' && text) {
      s.checkout.city = text.slice(0, 200);
      s.state = 'checkout_comment';
      return this.channel.buttons(from, 'Есть комментарий к заявке? (БИН для счёта, сроки, нужны сертификаты и т.п.) Напишите его или нажмите «Без комментария».', [
        { id: 'no_comment', title: 'Без комментария' },
      ]);
    }
    if (s.state === 'checkout_comment' && (text || id === 'no_comment')) {
      s.checkout.comment = id === 'no_comment' ? '' : text.slice(0, 500);
      s.state = 'checkout_confirm';
      return this.showOrderSummary(from, s);
    }

    if (text) return this.freeText(from, s, text);
    return this.mainMenu(from, s);
  }

  mainMenu(to, s) {
    s.state = 'idle';
    const hello = s.profileName ? `Здравствуйте, ${s.profileName}!` : 'Здравствуйте!';
    const count = this.cartItems(s).length;
    return this.channel.buttons(
      to,
      `${hello} Это *${this.shop.name}* — электротехника для бизнеса с доставкой по Казахстану.\n\n` +
        `В каталоге ${(Math.floor(this.catalog.size / 100) * 100).toLocaleString('ru-RU')}+ позиций: кабель и провод, СИП, арматура, изоляторы, автоматы, трансформаторы.\n\n` +
        '🔎 Просто напишите, что ищете (например, «ВВГнг 3х2,5»), или выберите действие:',
      [
        { id: 'catalog', title: '📦 Каталог' },
        { id: 'cart', title: count ? `📝 Заявка (${count})` : '📝 Заявка на КП' },
        { id: 'manager', title: '👤 Менеджер' },
      ],
    );
  }

  // Строки списка с пагинацией: до 9 элементов + «Ещё ▶».
  #paged(rows, offset, moreId) {
    const page = rows.slice(offset, offset + PAGE);
    if (offset + PAGE < rows.length) {
      page.push({ id: moreId(offset + PAGE), title: 'Ещё ▶', description: `Показаны ${offset + 1}–${offset + PAGE} из ${rows.length}` });
    }
    return page;
  }

  showCategories(to, s, offset) {
    s.state = 'idle';
    const rows = this.catalog.categories.map((c) => ({
      id: `cat:${c.id}:0`,
      title: c.title,
      description: `${this.catalog.byCategory(c.id).length} позиций`,
    }));
    return this.channel.list(to, '📦 Выберите раздел каталога:', 'Разделы', this.#paged(rows, offset, (o) => `cats:${o}`));
  }

  productRow(p) {
    return {
      id: `prod:${p.id}`,
      title: p.title,
      // Заголовок строки обрезается WhatsApp до 24 символов — хвост названия переносим в описание.
      description: `${p.title.length > 24 ? `…${p.title.slice(23)} · ` : ''}${this.price(p)}${p.inStock ? '' : ' · под заказ'}`,
    };
  }

  showProducts(to, s, categoryId, offset) {
    const cat = this.catalog.category(categoryId);
    const items = this.catalog.byCategory(categoryId);
    if (!cat || !items.length) return this.channel.text(to, 'В этом разделе пока нет товаров.');
    const rows = this.#paged(items.map((p) => this.productRow(p)), offset, (o) => `cat:${categoryId}:${o}`);
    return this.channel.list(
      to,
      `*${cat.title}* — ${items.length} позиций.\nСовет: быстрее найти нужное можно поиском — просто напишите марку и сечение.`,
      'Товары',
      rows,
    );
  }

  showFound(to, s, offset) {
    const items = (s.lastSearch?.ids ?? []).map((id) => this.product(id)).filter(Boolean);
    if (!items.length) return this.channel.text(to, 'Напишите, что ищете, — я найду в каталоге.');
    const head = s.lastSearch.source === 'ekt'
      ? `В нашем каталоге «${s.lastSearch.query}» нет, но есть у партнёра-поставщика (${items.length}). Цены ниже рыночных:`
      : s.lastSearch.exact
      ? `🔎 По запросу «${s.lastSearch.query}» найдено: ${items.length}`
      : `Точного совпадения по «${s.lastSearch.query}» нет. Похожие позиции (${items.length}):`;
    return this.channel.list(to, head, 'Результаты', this.#paged(items.map((p) => this.productRow(p)), offset, (o) => `found:${o}`));
  }

  showProduct(to, s, productId) {
    const p = this.product(productId);
    if (!p) return this.channel.text(to, 'Товар не найден. Напишите «меню».');
    const lines = [
      `*${p.title}*`,
      p.brand ? `Производитель: ${p.brand}` : null,
      p.sku ? `Артикул: ${p.sku}` : null,
      ...(p.params || []),
      '',
      p.price > 0 ? `Цена: *${this.price(p)}* (без НДС)` : 'Цена: по запросу',
      p.inStock ? '✅ В наличии' : '🕒 Под заказ',
      p.unit === 'м' ? 'Режем по метражу. От 100 м — цена ниже, пришлём в КП.' : null,
      p.url && p.source !== 'ekt' ? `\n${p.url}` : null,
    ];
    return this.channel.buttons(to, lines.filter((l) => l !== null).join('\n'), [
      { id: `add:${p.id}`, title: '➕ В заявку' },
      p.category ? { id: `cat:${p.category}:0`, title: '⬅️ К разделу' } : { id: 'found:0', title: '⬅️ К результатам' },
      { id: 'cart', title: '📝 Заявка' },
    ]);
  }

  askQuantity(to, s, productId) {
    const p = this.product(productId);
    if (!p) return this.channel.text(to, 'Товар не найден.');
    s.state = 'qty';
    s.pendingProduct = p.id;
    return this.channel.text(to, `Сколько нужно «${p.title}»? Напишите количество в ${p.unit} (например, ${p.unit === 'м' ? '150' : '10'}).`);
  }

  addToCart(to, s, text) {
    const p = this.product(s.pendingProduct);
    const qty = Number(text.replace(',', '.').match(/\d+(\.\d+)?/)?.[0]);
    if (!p) {
      s.state = 'idle';
      return this.mainMenu(to, s);
    }
    if (!qty || qty <= 0 || qty > 1e6) {
      return this.channel.text(to, `Не понял количество 🙂 Напишите число, например «${p.unit === 'м' ? '150' : '10'}».`);
    }
    s.cart[p.id] = (s.cart[p.id] || 0) + qty;
    s.state = 'idle';
    s.pendingProduct = null;
    return this.channel.buttons(
      to,
      `✅ Добавлено: «${p.title}» — ${s.cart[p.id]} ${p.unit}.\nВ заявке позиций: ${this.cartItems(s).length}. Ориентировочно: ${formatPrice(this.cartTotal(s), this.shop.currency)} без НДС.`,
      [
        { id: 'checkout', title: 'Отправить заявку' },
        { id: 'search', title: '🔎 Найти ещё' },
        { id: 'cart', title: '📝 Заявка' },
      ],
    );
  }

  cartItems(s) {
    return Object.entries(s.cart)
      .map(([id, qty]) => ({ product: this.product(id), qty }))
      .filter((i) => i.product && i.qty > 0);
  }

  cartTotal(s) {
    return this.cartItems(s).reduce((sum, i) => sum + i.product.price * i.qty, 0);
  }

  cartText(s) {
    const items = this.cartItems(s);
    const lines = items.map((i, n) => {
      const sum = i.product.price > 0 ? ` = ${formatPrice(i.product.price * i.qty, this.shop.currency)}` : ' (цена по запросу)';
      const note = s.cartNotes?.[i.product.id] ? ` (${s.cartNotes[i.product.id]})` : '';
      return `${n + 1}. ${i.product.title}${i.product.sku ? ` [${i.product.sku}]` : ''} — ${i.qty} ${i.product.unit}${sum}${note}`;
    });
    const unpriced = items.some((i) => !(i.product.price > 0));
    return (
      `${lines.join('\n')}\n\n*Ориентировочно: ${formatPrice(this.cartTotal(s), this.shop.currency)}* без НДС` +
      `${unpriced ? ' (без позиций по запросу)' : ''}\nТочную цену, наличие и доставку пришлём в КП.`
    );
  }

  async showCart(to, s) {
    s.state = 'idle';
    if (!this.cartItems(s).length) {
      return this.channel.buttons(to, 'Заявка пока пуста. Найдите товары в каталоге или напишите, что нужно.', [
        { id: 'catalog', title: '📦 Каталог' },
        { id: 'search', title: '🔎 Поиск' },
      ]);
    }
    await this.buttonsLong(to, `📝 *Заявка на КП:*\n${this.cartText(s)}`, [
      { id: 'checkout', title: 'Отправить заявку' },
      { id: 'search', title: '🔎 Добавить ещё' },
      { id: 'cart_clear', title: 'Очистить' },
    ]);
  }

  startCheckout(to, s) {
    if (!this.cartItems(s).length) return this.showCart(to, s);
    s.checkout = {};
    s.state = 'checkout_name';
    return this.channel.text(to, '📝 Оформляем заявку на коммерческое предложение.\nКак к вам обращаться? Укажите имя и компанию (ТОО/ИП), если покупаете для организации:');
  }

  showOrderSummary(to, s) {
    const c = s.checkout;
    return this.buttonsLong(
      to,
      `Проверьте заявку:\n\n${this.cartText(s)}\n\n👤 ${c.name}\n📍 ${c.city}\n📞 +${to}${c.comment ? `\n💬 ${c.comment}` : ''}`,
      [
        { id: 'confirm_order', title: '✅ Отправить' },
        { id: 'cancel_order', title: '❌ Отмена' },
      ],
      'Всё верно? Отправляем заявку?',
    );
  }

  async confirmOrder(to, s) {
    if (s.state !== 'checkout_confirm' || !this.cartItems(s).length) return this.mainMenu(to, s);
    const order = this.store.createOrder({
      channel: this.source,
      phone: to,
      name: s.checkout.name,
      city: s.checkout.city,
      comment: s.checkout.comment,
      items: this.cartItems(s).map((i) => ({
        id: i.product.id,
        sku: i.product.sku,
        title: i.product.title,
        price: i.product.price,
        priceVat: i.product.price > 0 ? this.priceVat(i.product) : 0,
        unit: i.product.unit,
        qty: i.qty,
        inStock: Boolean(i.product.inStock),
        source: i.product.source || 'catalog',
        url: i.product.url,
        ...(i.product.quote ? { quote: i.product.quote } : {}),
        ...(s.cartNotes?.[i.product.id] ? { note: s.cartNotes[i.product.id] } : {}),
      })),
      total: this.cartTotal(s),
      status: 'new',
    });
    const summary = this.cartText(s);
    s.cart = {};
    s.cartNotes = {};
    s.checkout = {};
    s.state = 'idle';
    const contact = `👤 ${order.name}\n📍 ${order.city}\n📞 +${to}${order.comment ? `\n💬 ${order.comment}` : ''}`;
    const priced = order.items.filter((i) => i.priceVat > 0);
    const risky = order.items.filter((i) => i.quote?.needsApproval);

    // Нечего считать автоматически (или нет реквизитов для документов) — как раньше, через менеджера.
    if (!priced.length || !this.company) {
      await this.channel.text(
        to,
        `🎉 Заявка *№${order.number}* принята!\nМенеджер проверит наличие и пришлёт коммерческое предложение в рабочее время (${this.shop.hours}).\n\nСрочно? Звоните: ${this.shop.phone}`,
      );
      return this.notifyManager(`🆕 Заявка на КП №${order.number}\n\n${summary}\n\n${contact}`);
    }

    // Прибыль по ценам ekt.kz ниже минимума — КП уходит только после подтверждения менеджера.
    if (risky.length) {
      order.status = 'awaiting_approval';
      await this.channel.text(
        to,
        `🎉 Заявка *№${order.number}* принята! Проверяем цены и наличие — коммерческое предложение пришлём в течение рабочего дня (${this.shop.hours}).`,
      );
      const lines = risky.map((i) => `• ${i.title}: ${money(i.priceVat)} ₸ с НДС, прибыль ${Math.round(i.quote.margin * 100)}%`).join('\n');
      return this.notifyManager(
        `🆕 Заявка на КП №${order.number} ждёт проверки\n\n${summary}\n\n${contact}\n\n⚠️ Прибыль ниже минимума:\n${lines}\n\nОтветьте «ок ${order.number}», чтобы отправить КП клиенту.`,
      );
    }

    await this.notifyManager(`🆕 Заявка на КП №${order.number}\n\n${summary}\n\n${contact}\n\nКП отправлено клиенту автоматически.`);
    return this.sendKP(order);
  }

  // Строки документа из позиций заявки (только с ценой).
  docLines(order) {
    return order.items
      .filter((i) => i.priceVat > 0)
      .map((i) => ({
        title: i.title,
        code: i.sku || '',
        qty: i.qty,
        unit: i.unit,
        priceVat: i.priceVat,
        status: i.inStock ? 'stock' : 'order',
        leadTime: i.inStock ? '' : 'срок уточним',
      }));
  }

  async sendKP(order) {
    const date = this.now();
    const { mmdd, nn } = this.store.next('kp', date);
    const number = `КП-${mmdd}-${nn}`;
    const lines = this.docLines(order);
    const pending = order.items.filter((i) => !(i.priceVat > 0)).map((i) => `${i.title} — ${i.qty} ${i.unit}`);
    const pdf = await this.docs.renderKP(
      {
        number,
        date,
        validUntil: new Date(date.getTime() + 7 * 24 * 3600 * 1000),
        buyer: { name: order.name, address: order.city, phone: `+${order.phone}` },
        lines,
        pending,
      },
      this.company,
    );
    const { total } = totals(lines);
    order.kp = { number, date: date.toISOString(), total };
    order.status = 'kp_sent';
    const file = `${number}.pdf`;
    await this.channel.document(order.phone, pdf, file, `Коммерческое предложение ${number} по заявке №${order.number}`);
    await this.channel.buttons(
      order.phone,
      `📄 Коммерческое предложение *${number}* на сумму *${money(total)} ₸* (с НДС ${Math.round(VAT_RATE * 100)}%). Действует 7 дней.` +
        (pending.length ? `\n\nПо позициям без цены (${pending.length}) уточняем у поставщиков и дополним сегодня.` : '') +
        '\n\nВсё устраивает? Нажмите «Согласен» — пришлём счёт на оплату.',
      [
        { id: `agree:${order.number}`, title: '✅ Согласен' },
        { id: 'manager', title: '👤 Менеджер' },
      ],
    );
    await this.notifyManagerDoc(pdf, file, `${number} → +${order.phone} (заявка №${order.number})`);
  }

  async approveOrder(to, number) {
    const order = this.store.order(number);
    if (!order) return this.channel.text(to, `Заявка №${number} не найдена.`);
    if (order.status !== 'awaiting_approval') return this.channel.text(to, `Заявка №${number}: статус «${order.status}», подтверждение не требуется.`);
    await this.sendKP(order);
    return this.channel.text(to, `✅ КП по заявке №${number} отправлено клиенту.`);
  }

  askBuyer(to, s, number) {
    const order = this.store.order(number);
    if (!order || order.phone !== to || !order.kp) return this.channel.text(to, 'Не нашёл это предложение. Напишите «менеджер» — поможем.');
    s.state = 'invoice_buyer';
    s.invoiceOrder = number;
    return this.channel.text(
      to,
      '🧾 Отлично! Для счёта пришлите реквизиты покупателя одним сообщением:\n*БИН/ИИН, название, адрес*\n\nНапример: «060340007296, ТОО «Энерго», г. Актобе, ул. Бурабай, 139Б».\nЕсли покупаете как физлицо — напишите ФИО и ИИН.',
    );
  }

  async sendInvoice(to, s, text) {
    const order = this.store.order(s.invoiceOrder);
    s.state = 'idle';
    if (!order) return this.mainMenu(to, s);
    const bin = text.match(/(?<!\d)\d{12}(?!\d)/)?.[0];
    const rest = text
      .replace(bin || '\u0000', '')
      .replace(/(^|[\s,;])(БИН|ИИН)(?=[\s:№,]|$)[:\s№]*/gi, '$1')
      .replace(/^[\s,;:.-]+|[\s,;:-]+$/g, '')
      .replace(/\s*,\s*(,\s*)+/g, ', ')
      .slice(0, 300);
    const buyer = { bin, text: bin ? `БИН ${bin}, ${rest}` : rest };
    const date = this.now();
    const { mmdd, nn } = this.store.next('invoice', date);
    const number = `${mmdd}-${nn}`;
    const lines = this.docLines(order);
    const pdf = await this.docs.renderInvoice({ number, date, buyer, lines }, this.company);
    const { total } = totals(lines);
    order.buyer = buyer;
    order.invoice = { number, date: date.toISOString(), total };
    order.status = 'invoice_sent';
    const file = `Счет_${number}.pdf`;
    await this.channel.document(to, pdf, file, `Счёт на оплату № ${number}`);
    await this.channel.text(
      to,
      `🧾 Счёт № ${number} на ${money(total)} ₸ отправлен.\nПри оплате укажите номер и дату счёта. После оплаты пришлите, пожалуйста, платёжку в этот чат — сразу запустим отгрузку.`,
    );
    await this.notifyManagerDoc(pdf, file, `Счёт ${number} → ${buyer.text} (+${to}), заявка №${order.number}`);
  }

  async callManager(to, s) {
    s.state = 'manager';
    await this.channel.text(
      to,
      `Передал ваш запрос менеджеру 👤 Он ответит в этом чате в рабочее время (${this.shop.hours}).\n` +
        `Можно сразу прислать спецификацию (Excel/PDF) или список позиций.\nТелефон: ${this.shop.phone}\n\nЧтобы вернуться к боту, напишите «меню».`,
    );
    await this.notifyManager(`📞 Клиент +${to}${s.profileName ? ` (${s.profileName})` : ''} просит связаться с менеджером.`);
  }

  async notifyManagerDoc(pdf, filename, caption) {
    if (!this.shop.managerPhone) return;
    try {
      await this.channel.document(this.shop.managerPhone, pdf, filename, caption);
    } catch (err) {
      this.log.error('Не удалось отправить документ менеджеру:', err.message);
    }
  }

  async notifyManager(text) {
    if (!this.shop.managerPhone) return;
    try {
      await this.channel.text(this.shop.managerPhone, text);
    } catch (err) {
      this.log.error('Не удалось уведомить менеджера:', err.message);
    }
  }

  // Кнопки WhatsApp допускают до 1024 символов текста — длинный текст уходит отдельным сообщением.
  async buttonsLong(to, text, buttons, short = 'Выберите действие:') {
    if (text.length <= 1024) return this.channel.buttons(to, text, buttons);
    await this.channel.text(to, text);
    return this.channel.buttons(to, short, buttons);
  }

  // --- Спецификации: фото / PDF / Excel ---

  async receiveSpec(to, s, msg) {
    s.specInbox ??= [];
    for (const m of msg.media) if (s.specInbox.length < MAX_SPEC_FILES) s.specInbox.push(m);
    if (msg.text) s.specCaption = [s.specCaption, msg.text].filter(Boolean).join('\n');
    if (s.state.startsWith('checkout') || s.state === 'qty') s.state = 'idle';

    if (this.specBatchMs > 0) {
      // Первое фото — сразу подтверждаем получение, остальные молча добавляем в пачку.
      if (!this.specTimers.has(to)) await this.channel.text(to, '📄 Получил, разбираю спецификацию… Если фото несколько — присылайте все, я подожду пару секунд.');
      clearTimeout(this.specTimers.get(to));
      this.specTimers.set(
        to,
        setTimeout(() => {
          this.specTimers.delete(to);
          this.defer(to, () => this.handle({ from: to, specReady: true }));
        }, this.specBatchMs),
      );
      return;
    }
    await this.channel.text(to, '📄 Получил, разбираю спецификацию…');
    return this.processSpec(to, s);
  }

  async processSpec(to, s) {
    const inbox = s.specInbox ?? [];
    const caption = s.specCaption ?? '';
    s.specInbox = [];
    s.specCaption = '';
    if (!inbox.length) return;

    const fallback = async (reason) => {
      if (reason) this.log.error('Разбор спецификации:', reason);
      await this.channel.text(
        to,
        `Спасибо! Передал спецификацию менеджеру — он посчитает и пришлёт КП в рабочее время (${this.shop.hours}).\nСрочно? Звоните: ${this.shop.phone}`,
      );
      await this.notifyManager(`📄 Клиент +${to}${s.profileName ? ` (${s.profileName})` : ''} прислал спецификацию (${inbox.length} файл.)${caption ? `:\n${caption}` : ''}\nАвтоматически разобрать не удалось${reason ? `: ${reason}` : ''}. Посмотрите в чате с клиентом.`);
    };
    if (!this.spec) return fallback();

    let files;
    try {
      files = await Promise.all(inbox.map((m) => this.loadMedia(m)));
    } catch (err) {
      return fallback(`не удалось скачать файл: ${err.message}`);
    }
    const unsupported = files.filter((f) => !f.supported);
    files = files.filter((f) => f.supported);
    if (!files.length) {
      return this.channel.text(to, `Этот формат не умею читать (${unsupported.map((f) => f.filename || f.mime).join(', ')}). Пришлите фото, PDF или Excel (.xlsx).`);
    }

    let extracted;
    try {
      extracted = await this.spec.extract(files, caption);
    } catch (err) {
      return fallback(err.message);
    }
    if (!extracted.positions.length) return fallback('позиции не найдены');

    const positions = await this.findCandidates(extracted.positions);
    let matches;
    try {
      matches = await this.spec.match(positions);
    } catch (err) {
      this.log.error('Подбор позиций:', err.message);
      matches = positions.map(() => ({ productId: null, kind: 'none', comment: '' }));
    }

    s.cartNotes ??= {};
    const found = [];
    const missing = [];
    positions.forEach((p, i) => {
      const m = matches[i];
      const product = m.productId && this.product(m.productId);
      if (product) {
        const qty = convertQty(p.qty, p.unit, product.unit);
        s.cart[product.id] = (s.cart[product.id] || 0) + qty;
        if (m.kind === 'analog') s.cartNotes[product.id] = `аналог для «${p.name}»${m.comment ? `: ${m.comment}` : ''}`;
        found.push({ p, product, qty, kind: m.kind });
      } else {
        // Позиция без цены: остаётся в заявке, уточняем у поставщиков.
        const id = `spec-${crypto.createHash('sha1').update(`${p.name}|${p.unit}`).digest('hex').slice(0, 10)}`;
        this.store.external(id, { id, source: 'spec', title: p.name, sku: p.codes?.[0] || '', unit: p.unit || 'шт', price: 0, inStock: false, params: [] });
        s.cart[id] = (s.cart[id] || 0) + p.qty;
        missing.push({ p, comment: m.comment });
      }
    });

    const priced = found.filter((f) => f.product.price > 0);
    const sum = priced.reduce((acc, f) => acc + f.product.price * f.qty, 0);
    const foundLines = found.map(
      (f) => `✅ ${f.product.title} — ${f.qty} ${f.product.unit}${f.product.price > 0 ? `, ${this.price(f.product)}` : ', цена по запросу'}${f.kind === 'analog' ? ' (аналог)' : ''}`,
    );
    const missingLines = missing.map((m) => `🔎 ${m.p.name} — ${m.p.qty} ${m.p.unit}`);
    const text =
      `📋 Разобрал спецификацию: *${positions.length}* поз.\n\n` +
      (found.length ? `*Есть у нас (${found.length}):*\n${foundLines.join('\n')}\n\n` : '') +
      (missing.length ? `*Уточним у поставщиков (${missing.length}):*\n${missingLines.join('\n')}\n\n` : '') +
      (sum > 0 ? `Ориентировочно по найденным: *${formatPrice(sum, this.shop.currency)}* без НДС.\n` : '') +
      (extracted.note ? `\n⚠️ ${extracted.note}\n` : '') +
      '\nВсё верно? Нажмите «Получить КП» — пришлём коммерческое предложение' +
      (missing.length ? ', а остальные позиции дополним после ответа поставщиков.' : '.');
    await this.buttonsLong(to, text, [
      { id: 'checkout', title: '📄 Получить КП' },
      { id: 'cart', title: '📝 Заявка' },
      { id: 'manager', title: '👤 Менеджер' },
    ], 'Всё верно? Нажмите «Получить КП».');
  }

  // Файл из сообщения: из канала (WhatsApp media id) или уже переданный буфер (эмулятор).
  async loadMedia(m) {
    const file = m.buffer ? { ...m } : { ...m, ...(await this.channel.download(m)) };
    file.mime = (file.mime || '').split(';')[0].trim();
    if (file.mime === XLSX || /\.xlsx$/i.test(file.filename || '')) {
      file.text = await excelToText(file.buffer);
      file.supported = true;
    } else {
      // Лимиты Claude: изображение до 5 МБ, PDF до 32 МБ
      const limit = file.mime === 'application/pdf' ? 32 : 5;
      file.supported = (file.mime.startsWith('image/') || file.mime === 'application/pdf') && file.buffer.length <= limit * 1024 * 1024;
    }
    return file;
  }

  // Кандидаты из каталога (и ekt.kz, если в каталоге пусто) для каждой позиции.
  async findCandidates(positions) {
    return Promise.all(
      positions.map(async (p) => {
        const seen = new Map();
        for (const q of [p.query, ...(p.codes || []), p.name]) {
          if (!q) continue;
          for (const item of this.catalog.search(q, 6).items) if (!seen.has(item.id)) seen.set(item.id, item);
          if (seen.size >= 8) break;
        }
        if (!seen.size && this.ekt?.enabled) {
          try {
            for (const it of await this.ekt.search(p.query, 5)) {
              const item = this.saveEkt(it);
              seen.set(item.id, item);
            }
          } catch (err) {
            this.log.error('ekt.kz:', err.message);
          }
        }
        const candidates = [...seen.values()].slice(0, 8).map((c) => ({
          id: c.id, title: c.title, sku: c.sku, brand: c.brand, price: c.price, unit: c.unit, source: c.source || 'catalog',
        }));
        return { ...p, candidates };
      }),
    );
  }

  // Свободный текст: поиск по каталогу + (если включён) ответ AI-консультанта.
  async freeText(to, s, text) {
    let { items, exact } = this.catalog.search(text, 40);
    let source = 'catalog';
    // Нет в каталоге — ищем на ekt.kz (цена −5%).
    if (!items.length && this.ekt?.enabled) {
      items = (await this.ekt.search(text)).map((it) => this.saveEkt(it));
      exact = true;
      source = 'ekt';
    }
    if (items.length) s.lastSearch = { query: text.slice(0, 60), ids: items.map((p) => p.id), exact, source };

    if (this.assistant) {
      const answered = await this.#askAssistant(to, s, text, items);
      if (items.length) await this.showFound(to, s, 0);
      if (answered || items.length) return;
    } else if (items.length) {
      return this.showFound(to, s, 0);
    }

    return this.channel.buttons(
      to,
      `По запросу «${text.slice(0, 60)}» ничего не нашёл в каталоге 🤔\nМногие позиции поставляем под заказ — менеджер уточнит наличие и цену. Или попробуйте написать иначе (марка, сечение, артикул).`,
      [
        { id: 'manager', title: '👤 Менеджер' },
        { id: 'catalog', title: '📦 Каталог' },
      ],
    );
  }

  saveEkt(it) {
    const id = `ekt-${crypto.createHash('sha1').update(it.url).digest('hex').slice(0, 10)}`;
    return this.store.external(id, {
      id,
      source: 'ekt',
      title: it.title,
      sku: '',
      unit: it.unit,
      price: it.quote.price,
      priceVat: it.quote.priceVat,
      inStock: true,
      url: it.url,
      params: [],
      quote: it.quote,
      supplierCode: it.code,
      sitePrice: it.price,
    });
  }

  async #askAssistant(to, s, text, found) {
    const content = this.assistant.userTurn ? this.assistant.userTurn(text.slice(0, 2000), found.slice(0, 15)) : text.slice(0, 2000);
    s.history.push({ role: 'user', content });
    let answer = null;
    try {
      answer = await this.assistant.reply(s.history);
    } catch (err) {
      this.log.error('Ошибка AI-консультанта:', err.message);
    }
    if (!answer) {
      s.history.pop();
      return false;
    }
    s.history.push({ role: 'assistant', content: answer });
    // Храним последние сообщения парами, история всегда начинается с реплики клиента.
    if (s.history.length > MAX_HISTORY) s.history = s.history.slice(-MAX_HISTORY);
    await this.channel.text(to, answer);
    return true;
  }
}
