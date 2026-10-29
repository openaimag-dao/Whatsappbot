import fs from 'node:fs';
import path from 'node:path';

// Простое хранилище в JSON-файле: сессии клиентов и заказы.
// Для большой нагрузки замените на Redis/PostgreSQL, сохранив интерфейс.
export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { sessions: {}, orders: [], lastOrderNumber: 1000 };
    if (filePath && fs.existsSync(filePath)) {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
    }
  }

  session(phone) {
    if (!this.data.sessions[phone]) {
      this.data.sessions[phone] = { state: 'idle', cart: {}, history: [], checkout: {} };
    }
    return this.data.sessions[phone];
  }

  createOrder(order) {
    this.data.lastOrderNumber += 1;
    const saved = { number: this.data.lastOrderNumber, createdAt: new Date().toISOString(), ...order };
    this.data.orders.push(saved);
    return saved;
  }

  // Номер документа на дату: next('kp', date) → '01', '02'… (свой счётчик на каждый день)
  next(kind, date) {
    const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    this.data.counters ??= {};
    const key = `${kind}-${date.getFullYear()}${mmdd}`;
    this.data.counters[key] = (this.data.counters[key] || 0) + 1;
    return { mmdd, nn: String(this.data.counters[key]).padStart(2, '0') };
  }

  order(number) {
    return this.data.orders.find((o) => o.number === Number(number));
  }

  // Товары не из каталога (найденные на ekt.kz) — чтобы их можно было положить в заявку.
  external(id, product) {
    this.data.external ??= {};
    if (product) this.data.external[id] = product;
    return this.data.external[id];
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
