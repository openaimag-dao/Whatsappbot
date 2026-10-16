import Anthropic from '@anthropic-ai/sdk';
import { formatPrice } from './catalog.js';

// AI-консультант: отвечает на свободные вопросы клиентов, опираясь только на каталог.
export class SalesAssistant {
  constructor({ apiKey, model, shop, catalog }) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    const lines = [...catalog.products.values()].map(
      (p) => `- [${p.id}] ${p.title} — ${formatPrice(p.price, shop.currency)} (${catalog.category(p.category)?.title ?? p.category}): ${p.description}`,
    );
    this.system = [
      `Ты — вежливый консультант-продавец магазина «${shop.name}» в WhatsApp.`,
      'Помогай подобрать товар, отвечай коротко (до 600 символов), по-русски, без markdown-разметки, кроме *жирного* в стиле WhatsApp.',
      'Говори только о товарах из каталога ниже, цены не выдумывай и скидок не обещай.',
      'Если вопрос о доставке, оплате, гарантии или наличии, на который нет ответа в каталоге, предложи связаться с менеджером (кнопка «Менеджер» в меню).',
      'Чтобы купить, клиент пишет «меню» и выбирает «Каталог», или «корзина» — чтобы оформить заказ. Напоминай об этом, когда клиент готов к покупке.',
      '',
      'Каталог:',
      ...lines,
    ].join('\n');
  }

  async reply(history) {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
      messages: history,
    });
    if (response.stop_reason === 'refusal') return null;
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return text || null;
  }
}
