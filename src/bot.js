import { formatPrice } from './catalog.js';

const MENU_WORDS = ['меню', 'menu', 'start', 'старт', 'привет', 'здравствуйте', 'сәлем', 'салем', 'hi', 'hello', '/start'];
const MAX_HISTORY = 12;
const PAGE = 9; // 10-я строка списка WhatsApp — «Ещё ▶»

// Логика диалога. Не зависит от HTTP — принимает входящее сообщение и шлёт ответы через wa.
export class SalesBot {
  constructor({ wa, store, catalog, shop, assistant = null, logger = console }) {
    this.wa = wa;
    this.store = store;
    this.catalog = catalog;
    this.shop = shop;
    this.assistant = assistant;
    this.log = logger;
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
    const items = (s.lastSearch?.ids ?? []).map((id) => this.catalog.products.get(id)).filter(Boolean);
    if (!items.length) return this.wa.text(to, 'Напишите, что ищете, — я найду в каталоге.');
    const head = s.lastSearch.exact
      ? `🔎 По запросу «${s.lastSearch.query}» найдено: ${items.length}`
      : `Точного совпадения по «${s.lastSearch.query}» нет. Похожие позиции (${items.length}):`;
    return this.wa.list(to, head, 'Результаты', this.#paged(items.map((p) => this.productRow(p)), offset, (o) => `found:${o}`));
  }

  showProduct(to, s, productId) {
    const p = this.catalog.products.get(productId);
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
      p.url ? `\n${p.url}` : null,
    ];
    return this.wa.buttons(to, lines.filter((l) => l !== null).join('\n'), [
      { id: `add:${p.id}`, title: '➕ В заявку' },
      { id: `cat:${p.category}:0`, title: '⬅️ К разделу' },
      { id: 'cart', title: '📝 Заявка' },
    ]);
  }

  askQuantity(to, s, productId) {
    const p = this.catalog.products.get(productId);
    if (!p) return this.wa.text(to, 'Товар не найден.');
    s.state = 'qty';
    s.pendingProduct = p.id;
    return this.wa.text(to, `Сколько нужно «${p.title}»? Напишите количество в ${p.unit} (например, ${p.unit === 'м' ? '150' : '10'}).`);
  }

  addToCart(to, s, text) {
    const p = this.catalog.products.get(s.pendingProduct);
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
      .map(([id, qty]) => ({ product: this.catalog.products.get(id), qty }))
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
        unit: i.product.unit,
        qty: i.qty,
        url: i.product.url,
      })),
      total: this.cartTotal(s),
      status: 'new',
    });
    const summary = this.cartText(s);
    s.cart = {};
    s.checkout = {};
    s.state = 'idle';
    await this.wa.text(
      to,
      `🎉 Заявка *№${order.number}* принята!\nМенеджер проверит наличие и пришлёт коммерческое предложение в рабочее время (${this.shop.hours}).\n\nСрочно? Звоните: ${this.shop.phone}`,
    );
    await this.notifyManager(
      `🆕 Заявка на КП №${order.number}\n\n${summary}\n\n👤 ${order.name}\n📍 ${order.city}\n📞 +${to}${order.comment ? `\n💬 ${order.comment}` : ''}`,
    );
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
    const { items, exact } = this.catalog.search(text, 40);
    if (items.length) s.lastSearch = { query: text.slice(0, 60), ids: items.map((p) => p.id), exact };

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
