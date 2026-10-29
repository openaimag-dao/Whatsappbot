import { limitBody, limitButtonLabel, limitButtons, limitRows, limitText } from './limits.js';

// Отправка сообщений через WhatsApp Cloud API.

export class WhatsAppClient {
  constructor({ token, phoneNumberId, apiVersion }) {
    this.url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    this.token = token;
  }

  #send(to, payload) {
    return this.#post({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload });
  }

  async #post(body) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  text(to, body) {
    return this.#send(to, { type: 'text', text: { body: limitText(body), preview_url: false } });
  }

  // buttons: [{ id, title }]
  buttons(to, body, buttons) {
    return this.#send(to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: limitBody(body) },
        action: {
          buttons: limitButtons(buttons).map((reply) => ({ type: 'reply', reply })),
        },
      },
    });
  }

  // rows: [{ id, title, description? }]
  list(to, body, buttonText, rows) {
    return this.#send(to, {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: limitBody(body) },
        action: {
          button: limitButtonLabel(buttonText),
          sections: [{ title: limitButtonLabel(buttonText), rows: limitRows(rows) }],
        },
      },
    });
  }

  // Загрузка файла в Cloud API → media id.
  async upload(buffer, filename, mime = 'application/pdf') {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([buffer], { type: mime }), filename);
    const res = await fetch(this.url.replace(/\/messages$/, '/media'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
    });
    if (!res.ok) throw new Error(`WhatsApp media ${res.status}: ${await res.text()}`);
    return (await res.json()).id;
  }

  // Отправка PDF (КП, счёт) документом.
  async document(to, buffer, filename, caption = '') {
    const id = await this.upload(buffer, filename);
    return this.#send(to, { type: 'document', document: { id, filename, ...(caption ? { caption: limitBody(caption) } : {}) } });
  }

  // Скачивание входящего файла (фото/документ спецификации) по media id.
  async download({ id }) {
    const base = this.url.replace(/\/[^/]+\/messages$/, '');
    const meta = await fetch(`${base}/${id}`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!meta.ok) throw new Error(`WhatsApp media ${meta.status}: ${await meta.text()}`);
    const { url, mime_type: mime } = await meta.json();
    const file = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!file.ok) throw new Error(`WhatsApp media download ${file.status}`);
    return { buffer: Buffer.from(await file.arrayBuffer()), mime };
  }

  markRead(messageId) {
    return this.#post({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }).catch(() => {});
  }
}
