import crypto from 'node:crypto';
import { limitBody, limitButtonLabel, limitButtons, limitRows, limitText } from './limits.js';

// Канал-эмулятор: вместо отправки в WhatsApp складывает исходящие сообщения в очереди по получателям.
// Интерфейс тот же, что у WhatsAppClient, — бот не знает, с каким каналом работает.
export class SimulatorChannel {
  constructor({ maxFiles = 200 } = {}) {
    this.outbox = new Map();
    this.files = new Map(); // id → { buffer, filename } — PDF КП и счетов для скачивания из эмулятора
    this.maxFiles = maxFiles;
  }

  #push(to, message) {
    if (!this.outbox.has(to)) this.outbox.set(to, []);
    this.outbox.get(to).push({ ...message, at: new Date().toISOString() });
  }

  async text(to, body) {
    this.#push(to, { type: 'text', body: limitText(body) });
  }

  async buttons(to, body, buttons) {
    this.#push(to, { type: 'buttons', body: limitBody(body), buttons: limitButtons(buttons) });
  }

  async list(to, body, buttonText, rows) {
    this.#push(to, { type: 'list', body: limitBody(body), buttonText: limitButtonLabel(buttonText), rows: limitRows(rows) });
  }

  async document(to, buffer, filename, caption = '') {
    const id = crypto.randomUUID();
    this.files.set(id, { buffer, filename });
    if (this.files.size > this.maxFiles) this.files.delete(this.files.keys().next().value);
    this.#push(to, { type: 'document', fileId: id, filename, caption: limitBody(caption), size: buffer.length });
  }

  file(id) {
    return this.files.get(id);
  }

  // Забрать накопленные сообщения для получателя.
  drain(to) {
    const messages = this.outbox.get(to) ?? [];
    this.outbox.delete(to);
    return messages;
  }
}
