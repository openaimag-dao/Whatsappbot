// Лимиты интерактивных сообщений WhatsApp. Применяются во всех каналах,
// чтобы эмулятор показывал ровно то, что увидит клиент в WhatsApp.
export const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const limitText = (body) => cut(body, 4096);
export const limitBody = (body) => cut(body, 1024);
export const limitButtonLabel = (label) => cut(label, 20);

// До 3 кнопок, заголовок ≤ 20 символов.
export const limitButtons = (buttons) => buttons.slice(0, 3).map((b) => ({ id: b.id, title: cut(b.title, 20) }));

// До 10 строк, заголовок ≤ 24, описание ≤ 72.
export const limitRows = (rows) =>
  rows.slice(0, 10).map((r) => ({
    id: r.id,
    title: cut(r.title, 24),
    ...(r.description ? { description: cut(r.description, 72) } : {}),
  }));
