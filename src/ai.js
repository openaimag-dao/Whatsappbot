import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { formatPrice } from './catalog.js';

// AI-консультант: отвечает на вопросы клиентов, опираясь на информацию о компании
// и на товары, найденные поиском по каталогу под конкретный вопрос.
export class SalesAssistant {
  constructor({ apiKey, model, shop, catalog, shopInfoPath }) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.shop = shop;
    const info = shopInfoPath && fs.existsSync(shopInfoPath) ? fs.readFileSync(shopInfoPath, 'utf8') : '';
    this.system = [
      `Ты — консультант отдела продаж компании «${shop.name}» в WhatsApp. Клиенты — в основном компании (ТОО, ИП) и монтажники.`,
      'Отвечай кратко (до 600 символов), на языке клиента (русский или казахский), без markdown, можно *жирный* в стиле WhatsApp.',
      'Помогай подобрать позиции, объясняй разницу между марками кабеля, сечениями и т.п. Если клиент называет мощность или ток — можешь сориентировать по сечению, но советуй проверить расчётом.',
      'О товарах говори только то, что есть в блоке «Найдено в каталоге» в сообщении клиента; цены и наличие не выдумывай. Цены указаны без НДС.',
      'Если подходящих товаров нет в найденном — скажи, что многое поставляем под заказ, и предложи менеджера (кнопка «Менеджер» в меню).',
      'Не обещай скидки, сроки и стоимость доставки — это сообщает менеджер в коммерческом предложении.',
      'Под твоим ответом бот сам покажет список найденных товаров: клиент выбирает позицию → «В заявку» → указывает количество → «Отправить заявку». Подсказывай этот путь, когда клиент готов купить. Ссылки и артикулы перечислять не нужно.',
      `Каталог: ${catalog.size} позиций, разделы: ${catalog.categories.map((c) => c.title).join(', ')}.`,
      '',
      info,
    ].join('\n');
  }

  // Текст реплики клиента вместе с результатами поиска — сохраняется в истории как есть.
  userTurn(text, found) {
    const list = found.length
      ? found
          .map((p) => {
            const price = p.price > 0 ? `${formatPrice(p.price, this.shop.currency)}/${p.unit}` : 'цена по запросу';
            const params = p.params?.length ? `; ${p.params.join(', ')}` : '';
            return `- ${p.title} (арт. ${p.sku || '—'}${p.brand ? `, ${p.brand}` : ''}) — ${price}, ${p.inStock ? 'в наличии' : 'под заказ'}${params}`;
          })
          .join('\n')
      : '(по словам из сообщения ничего не найдено)';
    return `${text}\n\n<Найдено в каталоге>\n${list}\n</Найдено в каталоге>`;
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
