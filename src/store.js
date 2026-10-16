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

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
