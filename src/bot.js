import { formatPrice } from './catalog.js';

const MENU_WORDS = ['меню', 'menu', 'start', 'старт', 'привет', 'здравствуйте', 'hi', 'hello', '/start'];
const MAX_HISTORY = 12;

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

  price(amount) {
    return formatPrice(amount, this.shop.currency);
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
    if (id === 'catalog' || lower === 'каталог') return this.showCategories(from, s);
    if (id === 'cart' || lower === 'корзина') return this.showCart(from, s);
    if (id === 'manager' || lower === 'менеджер') return this.callManager(from, s);
    if (id === 'cart_clear') {
      s.cart = {};
      return this.wa.buttons(from, 'Корзина очищена.', [
        { id: 'catalog', title: 'Каталог' },
        { id: 'menu', title: 'Меню' },
      ]);
    }
    if (id === 'checkout') return this.startCheckout(from, s);
    if (id === 'confirm_order') return this.confirmOrder(from, s);
    if (id === 'cancel_order') {
      s.state = 'idle';
      return this.wa.buttons(from, 'Оформление отменено. Товары остались в корзине.', [
        { id: 'cart', title: 'Корзина' },
        { id: 'menu', title: 'Меню' },
      ]);
    }
    if (id.startsWith('cat:')) return this.showProducts(from, s, id.slice(4));
    if (id.startsWith('prod:')) return this.showProduct(from, s, id.slice(5));
    if (id.startsWith('add:')) return this.addToCart(from, s, id.slice(4));
    if (id.startsWith('del:')) return this.removeFromCart(from, s, id.slice(4));

    if (s.state === 'checkout_name' && text) {
      s.checkout.name = text.slice(0, 100);
      s.state = 'checkout_address';
      return this.wa.text(from, 'Спасибо! Теперь укажите адрес доставки (город, улица, дом, квартира):');
    }
    if (s.state === 'checkout_address' && text) {
      s.checkout.address = text.slice(0, 300);
      s.state = 'checkout_confirm';
      return this.showOrderSummary(from, s);
    }

    if (text) return this.freeText(from, s, text);
    return this.mainMenu(from, s);
  }

  mainMenu(to, s) {
    s.state = 'idle';
    const hello = s.profileName ? `Здравствуйте, ${s.profileName}!` : 'Здравствуйте!';
    const ai = this.assistant ? '\n\nИли просто напишите вопрос — я помогу подобрать товар.' : '';
    return this.wa.buttons(to, `${hello} Это «${this.shop.name}». Чем могу помочь?${ai}`, [
      { id: 'catalog', title: '🛍 Каталог' },
      { id: 'cart', title: `🛒 Корзина${this.cartCount(s) ? ` (${this.cartCount(s)})` : ''}` },
      { id: 'manager', title: '👤 Менеджер' },
    ]);
  }

  showCategories(to, s) {
    s.state = 'idle';
    return this.wa.list(
      to,
      'Выберите категорию:',
      'Категории',
      this.catalog.categories.map((c) => ({
        id: `cat:${c.id}`,
        title: c.title,
        description: `${this.catalog.byCategory(c.id).length} товаров`,
      })),
    );
  }

  showProducts(to, s, categoryId) {
    const cat = this.catalog.category(categoryId);
    const items = this.catalog.byCategory(categoryId);
    if (!cat || !items.length) return this.wa.text(to, 'В этой категории пока нет товаров.');
    return this.wa.list(
      to,
      `*${cat.title}*\nВыберите товар:`,
      'Товары',
      items.map((p) => ({ id: `prod:${p.id}`, title: p.title, description: `${this.price(p.price)} · ${p.description}` })),
    );
  }

  showProduct(to, s, productId) {
    const p = this.catalog.products.get(productId);
    if (!p) return this.wa.text(to, 'Товар не найден. Напишите «меню».');
    return this.wa.buttons(to, `*${p.title}*\n${p.description}\n\nЦена: *${this.price(p.price)}*`, [
      { id: `add:${p.id}`, title: '➕ В корзину' },
      { id: `cat:${p.category}`, title: '⬅️ Назад' },
      { id: 'cart', title: '🛒 Корзина' },
    ]);
  }

  addToCart(to, s, productId) {
    const p = this.catalog.products.get(productId);
    if (!p) return this.wa.text(to, 'Товар не найден.');
    s.cart[p.id] = (s.cart[p.id] || 0) + 1;
    return this.wa.buttons(to, `✅ «${p.title}» в корзине (${s.cart[p.id]} шт.).\nИтого: ${this.price(this.cartTotal(s))}`, [
      { id: 'checkout', title: 'Оформить заказ' },
      { id: 'catalog', title: 'Продолжить покупки' },
      { id: 'cart', title: 'Корзина' },
    ]);
  }

  removeFromCart(to, s, productId) {
    delete s.cart[productId];
    return this.showCart(to, s);
  }

  cartItems(s) {
    return Object.entries(s.cart)
      .map(([id, qty]) => ({ product: this.catalog.products.get(id), qty }))
      .filter((i) => i.product && i.qty > 0);
  }

  cartCount(s) {
    return this.cartItems(s).reduce((n, i) => n + i.qty, 0);
  }

  cartTotal(s) {
    return this.cartItems(s).reduce((sum, i) => sum + i.product.price * i.qty, 0);
  }

  cartText(s) {
    const lines = this.cartItems(s).map(
      (i, n) => `${n + 1}. ${i.product.title} × ${i.qty} = ${this.price(i.product.price * i.qty)}`,
    );
    return `${lines.join('\n')}\n\n*Итого: ${this.price(this.cartTotal(s))}*`;
  }

  async showCart(to, s) {
    s.state = 'idle';
    const items = this.cartItems(s);
    if (!items.length) {
      return this.wa.buttons(to, 'Корзина пуста.', [
        { id: 'catalog', title: '🛍 Каталог' },
        { id: 'menu', title: 'Меню' },
      ]);
    }
    await this.wa.buttons(to, `🛒 *Ваша корзина:*\n${this.cartText(s)}`, [
      { id: 'checkout', title: 'Оформить заказ' },
      { id: 'catalog', title: 'Добавить ещё' },
      { id: 'cart_clear', title: 'Очистить' },
    ]);
  }

  startCheckout(to, s) {
    if (!this.cartItems(s).length) return this.showCart(to, s);
    s.checkout = {};
    s.state = 'checkout_name';
    return this.wa.text(to, 'Оформляем заказ 📝\nКак к вам обращаться? Напишите имя и фамилию:');
  }

  showOrderSummary(to, s) {
    return this.wa.buttons(
      to,
      `Проверьте заказ:\n\n${this.cartText(s)}\n\n👤 ${s.checkout.name}\n📍 ${s.checkout.address}\n📞 +${to}`,
      [
        { id: 'confirm_order', title: '✅ Подтвердить' },
        { id: 'cancel_order', title: '❌ Отмена' },
      ],
    );
  }

  async confirmOrder(to, s) {
    if (s.state !== 'checkout_confirm' || !this.cartItems(s).length) return this.mainMenu(to, s);
    const order = this.store.createOrder({
      phone: to,
      name: s.checkout.name,
      address: s.checkout.address,
      items: this.cartItems(s).map((i) => ({ id: i.product.id, title: i.product.title, price: i.product.price, qty: i.qty })),
      total: this.cartTotal(s),
      status: 'new',
    });
    const summary = this.cartText(s);
    s.cart = {};
    s.checkout = {};
    s.state = 'idle';
    await this.wa.text(
      to,
      `🎉 Заказ *№${order.number}* принят!\nМенеджер свяжется с вами для подтверждения доставки и оплаты.\n\nСпасибо за покупку!`,
    );
    await this.notifyManager(
      `🆕 Новый заказ №${order.number}\n\n${summary}\n\n👤 ${order.name}\n📍 ${order.address}\n📞 +${to}`,
    );
  }

  async callManager(to, s) {
    s.state = 'manager';
    await this.wa.text(
      to,
      'Передал ваш запрос менеджеру 👤 Он ответит в этом чате в ближайшее время.\nЧтобы вернуться к боту, напишите «меню».',
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

  async freeText(to, s, text) {
    if (!this.assistant) {
      return this.wa.buttons(to, 'Я пока понимаю только кнопки 🙂 Выберите действие:', [
        { id: 'catalog', title: '🛍 Каталог' },
        { id: 'cart', title: '🛒 Корзина' },
        { id: 'manager', title: '👤 Менеджер' },
      ]);
    }
    s.history.push({ role: 'user', content: text.slice(0, 2000) });
    let answer = null;
    try {
      answer = await this.assistant.reply(s.history);
    } catch (err) {
      this.log.error('Ошибка AI-консультанта:', err.message);
    }
    if (!answer) {
      s.history.pop();
      return this.wa.buttons(to, 'Не смог ответить на этот вопрос. Могу позвать менеджера:', [
        { id: 'manager', title: '👤 Менеджер' },
        { id: 'catalog', title: '🛍 Каталог' },
      ]);
    }
    s.history.push({ role: 'assistant', content: answer });
    // Храним последние сообщения парами, история всегда начинается с реплики клиента.
    if (s.history.length > MAX_HISTORY) s.history = s.history.slice(-MAX_HISTORY);
    return this.wa.text(to, answer);
  }
}
