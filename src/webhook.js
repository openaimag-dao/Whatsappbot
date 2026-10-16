import crypto from 'node:crypto';

// Проверка подписи X-Hub-Signature-256 (HMAC-SHA256 тела запроса ключом App Secret).
export function isValidSignature(rawBody, header, appSecret) {
  if (!appSecret) return true;
  if (!header || !rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Достаёт входящие сообщения из payload вебхука в упрощённом виде.
export function extractMessages(body) {
  const result = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const names = Object.fromEntries((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages ?? []) {
        const msg = { id: m.id, from: m.from, name: names[m.from] };
        if (m.type === 'text') msg.text = m.text?.body;
        else if (m.type === 'interactive') {
          msg.replyId = m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id;
        } else if (m.type === 'button') {
          msg.text = m.button?.text;
        }
        result.push(msg);
      }
    }
  }
  return result;
}
