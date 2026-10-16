import crypto from 'node:crypto';
import { formatPrice } from './catalog.js';
import { renderInvoice, renderKP, totals } from './documents.js';
import { money, round2, VAT_RATE } from './money.js';

const MENU_WORDS = ['меню', 'menu', 'start', 'старт', 'привет', 'здравствуйте', 'сәлем', 'салем', 'hi', 'hello', '/start'];
const MAX_HISTORY = 12;
const PAGE = 9; // 10-я строка списка WhatsApp — «Ещё ▶»

// Логика диалога. Не зависит от HTTP — принимает входящее сообщение и шлёт ответы через wa.
export class SalesBot {
  constructor({ wa, store, catalog, shop, assistant = null, ekt = null, company = null, docs = { renderKP, renderInvoice }, now = () => new Date(), logger = console }) {
    this.wa = wa;
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

    if (id === 'menu' || MENU_WORDS.includes(lower)) return this.mainMenu(from, s);
    if (id === 'catalog' || lower === 'каталог') return this.showCategories(from, s, 0);
    if (id === 'cart' || ['корзина', 'заявка'].includes(lower)) return this.showCart(from, s);
    if (id === 'manager' || lower === 'менеджер') return this.callManager(from, s);
    if (id === 'search') {
      s.state = 'idle';
      return this.wa.text(from, '🔎 Напишите название, марку или артикул. Например: «ВВГнг 3х2,5», «СИП-4 4х50», «автомат 25А», «изолятор ШФ-20».');
    }
    if (id === 'cart_clear') {
      s.cart = {};
      s.state = 'idle';
      return this.wa.buttons(from, 'Заявка очищена.', [
        { id: 'catalog', title: 'Каталог' },
        { id: 'menu', title: 'Меню' },
      ]);
    }
    if (id === 'checkout') return this.startCheckout(from, s);
    if (id === 'confirm_order') return this.confirmOrder(from, s);
    if (id === 'cancel_order') {
      s.state = 'idle';
      return this.wa.buttons(from, 'Отправка отменена. Позиции остались в заявке.', [
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
      return this.wa.text(from, 'Спасибо! В какой город доставить? (или напишите «самовывоз» — склад в Шымкенте)');
    }
    if (s.state === 'checkout_city' && text) {
      s.checkout.city = text.slice(0, 200);
      s.state = 'checkout_comment';
      return this.wa.buttons(from, 'Есть комментарий к заявке? (БИН для счёта, сроки, нужны сертификаты и т.п.) Напишите его или нажмите «Без комментария».', [
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
    return this.wa.buttons(
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
    return this.wa.list(to, '📦 Выберите раздел каталога:', 'Разделы', this.#paged(rows, offset, (o) => `cats:${o}`));
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
    if (!cat || !items.length) return this.wa.text(to, 'В этом разделе пока нет товаров.');
    const rows = this.#paged(items.map((p) => this.productRow(p)), offset, (o) => `cat:${categoryId}:${o}`);
    return this.wa.list(
      to,
      `*${cat.title}* — ${items.length} позиций.\nСовет: быстрее найти нужное можно поиском — просто напишите марку и сечение.`,
      'Товары',
      rows,
    );
  }

  showFound(to, s, offset) {
    const items = (s.lastSearch?.ids ?? []).map((id) => this.product(id)).filter(Boolean);
    if (!items.length) return this.wa.text(to, 'Напишите, что ищете, — я найду в каталоге.');
    const head = s.lastSearch.source === 'ekt'
      ? `В нашем каталоге «${s.lastSearch.query}» нет, но есть у партнёра-поставщика (${items.length}). Цены ниже рыночных:`
      : s.lastSearch.exact
      ? `🔎 По запросу «${s.lastSearch.query}» найдено: ${items.length}`
      : `Точного совпадения по «${s.lastSearch.query}» нет. Похожие позиции (${items.length}):`;
    return this.wa.list(to, head, 'Результаты', this.#paged(items.map((p) => this.productRow(p)), offset, (o) => `found:${o}`));
  }

  showProduct(to, s, productId) {
    const p = this.product(productId);
    if (!p) return this.wa.text(to, 'Товар не найден. Напишите «меню».');
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
    return this.wa.buttons(to, lines.filter((l) => l !== null).join('\n'), [
      { id: `add:${p.id}`, title: '➕ В заявку' },
      p.category ? { id: `cat:${p.category}:0`, title: '⬅️ К разделу' } : { id: 'found:0', title: '⬅️ К результатам' },
      { id: 'cart', title: '📝 Заявка' },
    ]);
  }

  askQuantity(to, s, productId) {
    const p = this.product(productId);
    if (!p) return this.wa.text(to, 'Товар не найден.');
    s.state = 'qty';
    s.pendingProduct = p.id;
    return this.wa.text(to, `Сколько нужно «${p.title}»? Напишите количество в ${p.unit} (например, ${p.unit === 'м' ? '150' : '10'}).`);
  }

  addToCart(to, s, text) {
    const p = this.product(s.pendingProduct);
    const qty = Number(text.replace(',', '.').match(/\d+(\.\d+)?/)?.[0]);
    if (!p) {
      s.state = 'idle';
      return this.mainMenu(to, s);
    }
    if (!qty || qty <= 0 || qty > 1e6) {
      return this.wa.text(to, `Не понял количество 🙂 Напишите число, например «${p.unit === 'м' ? '150' : '10'}».`);
    }
    s.cart[p.id] = (s.cart[p.id] || 0) + qty;
    s.state = 'idle';
    s.pendingProduct = null;
    return this.wa.buttons(
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
      return `${n + 1}. ${i.product.title}${i.product.sku ? ` [${i.product.sku}]` : ''} — ${i.qty} ${i.product.unit}${sum}`;
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
      return this.wa.buttons(to, 'Заявка пока пуста. Найдите товары в каталоге или напишите, что нужно.', [
        { id: 'catalog', title: '📦 Каталог' },
        { id: 'search', title: '🔎 Поиск' },
      ]);
    }
    await this.wa.buttons(to, `📝 *Заявка на КП:*\n${this.cartText(s)}`, [
      { id: 'checkout', title: 'Отправить заявку' },
      { id: 'search', title: '🔎 Добавить ещё' },
      { id: 'cart_clear', title: 'Очистить' },
    ]);
  }

  startCheckout(to, s) {
    if (!this.cartItems(s).length) return this.showCart(to, s);
    s.checkout = {};
    s.state = 'checkout_name';
    return this.wa.text(to, '📝 Оформляем заявку на коммерческое предложение.\nКак к вам обращаться? Укажите имя и компанию (ТОО/ИП), если покупаете для организации:');
  }

  showOrderSummary(to, s) {
    const c = s.checkout;
    return this.wa.buttons(
      to,
      `Проверьте заявку:\n\n${this.cartText(s)}\n\n👤 ${c.name}\n📍 ${c.city}\n📞 +${to}${c.comment ? `\n💬 ${c.comment}` : ''}`,
      [
        { id: 'confirm_order', title: '✅ Отправить' },
        { id: 'cancel_order', title: '❌ Отмена' },
      ],
    );
  }

  async confirmOrder(to, s) {
    if (s.state !== 'checkout_confirm' || !this.cartItems(s).length) return this.mainMenu(to, s);
    const order = this.store.createOrder({
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
      })),
      total: this.cartTotal(s),
      status: 'new',
    });
    const summary = this.cartText(s);
    s.cart = {};
    s.checkout = {};
    s.state = 'idle';
    const contact = `👤 ${order.name}\n📍 ${order.city}\n📞 +${to}${order.comment ? `\n💬 ${order.comment}` : ''}`;
    const priced = order.items.filter((i) => i.priceVat > 0);
    const risky = order.items.filter((i) => i.quote?.needsApproval);

    // Нечего считать автоматически (или нет реквизитов для документов) — как раньше, через менеджера.
    if (!priced.length || !this.company) {
      await this.wa.text(
        to,
        `🎉 Заявка *№${order.number}* принята!\nМенеджер проверит наличие и пришлёт коммерческое предложение в рабочее время (${this.shop.hours}).\n\nСрочно? Звоните: ${this.shop.phone}`,
      );
      return this.notifyManager(`🆕 Заявка на КП №${order.number}\n\n${summary}\n\n${contact}`);
    }

    // Прибыль по ценам ekt.kz ниже минимума — КП уходит только после подтверждения менеджера.
    if (risky.length) {
      order.status = 'awaiting_approval';
      await this.wa.text(
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
    await this.wa.document(order.phone, pdf, file, `Коммерческое предложение ${number} по заявке №${order.number}`);
    await this.wa.buttons(
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
    if (!order) return this.wa.text(to, `Заявка №${number} не найдена.`);
    if (order.status !== 'awaiting_approval') return this.wa.text(to, `Заявка №${number}: статус «${order.status}», подтверждение не требуется.`);
    await this.sendKP(order);
    return this.wa.text(to, `✅ КП по заявке №${number} отправлено клиенту.`);
  }

  askBuyer(to, s, number) {
    const order = this.store.order(number);
    if (!order || order.phone !== to || !order.kp) return this.wa.text(to, 'Не нашёл это предложение. Напишите «менеджер» — поможем.');
    s.state = 'invoice_buyer';
    s.invoiceOrder = number;
    return this.wa.text(
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
    await this.wa.document(to, pdf, file, `Счёт на оплату № ${number}`);
    await this.wa.text(
      to,
      `🧾 Счёт № ${number} на ${money(total)} ₸ отправлен.\nПри оплате укажите номер и дату счёта. После оплаты пришлите, пожалуйста, платёжку в этот чат — сразу запустим отгрузку.`,
    );
    await this.notifyManagerDoc(pdf, file, `Счёт ${number} → ${buyer.text} (+${to}), заявка №${order.number}`);
  }

  async callManager(to, s) {
    s.state = 'manager';
    await this.wa.text(
      to,
      `Передал ваш запрос менеджеру 👤 Он ответит в этом чате в рабочее время (${this.shop.hours}).\n` +
        `Можно сразу прислать спецификацию (Excel/PDF) или список позиций.\nТелефон: ${this.shop.phone}\n\nЧтобы вернуться к боту, напишите «меню».`,
    );
    await this.notifyManager(`📞 Клиент +${to}${s.profileName ? ` (${s.profileName})` : ''} просит связаться с менеджером.`);
  }

  async notifyManagerDoc(pdf, filename, caption) {
    if (!this.shop.managerPhone) return;
    try {
      await this.wa.document(this.shop.managerPhone, pdf, filename, caption);
    } catch (err) {
      this.log.error('Не удалось отправить документ менеджеру:', err.message);
    }
  }

  async notifyManager(text) {
    if (!this.shop.managerPhone) return;
    try {
      await this.wa.text(this.shop.managerPhone, text);
    } catch (err) {
      this.log.error('Не удалось уведомить менеджера:', err.message);
    }
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

    return this.wa.buttons(
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
    await this.wa.text(to, answer);
    return true;
  }
}
