import { limitBody, limitButtonLabel, limitButtons, limitRows, limitText } from './limits.js';

// Канал-эмулятор: вместо отправки в WhatsApp складывает исходящие сообщения в очереди по получателям.
// Интерфейс тот же, что у WhatsAppClient, — бот не знает, с каким каналом работает.
export class SimulatorChannel {
  constructor() {
    this.outbox = new Map();
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

  // Забрать накопленные сообщения для получателя.
  drain(to) {
    const messages = this.outbox.get(to) ?? [];
    this.outbox.delete(to);
    return messages;
  }
}
