// Отправка сообщений через WhatsApp Cloud API.
// Лимиты Meta: до 3 кнопок (заголовок ≤ 20 симв.), список ≤ 10 строк (заголовок ≤ 24, описание ≤ 72).

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

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
    return this.#send(to, { type: 'text', text: { body: cut(body, 4096), preview_url: false } });
  }

  // buttons: [{ id, title }]
  buttons(to, body, buttons) {
    return this.#send(to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: cut(body, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: cut(b.title, 20) } })),
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
        body: { text: cut(body, 1024) },
        action: {
          button: cut(buttonText, 20),
          sections: [
            {
              title: cut(buttonText, 24),
              rows: rows.slice(0, 10).map((r) => ({
                id: r.id,
                title: cut(r.title, 24),
                ...(r.description ? { description: cut(r.description, 72) } : {}),
              })),
            },
          ],
        },
      },
    });
  }

  markRead(messageId) {
    return this.#post({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }).catch(() => {});
  }
}
