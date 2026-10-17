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

  markRead(messageId) {
    return this.#post({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }).catch(() => {});
  }
}
