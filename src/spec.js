import Anthropic from '@anthropic-ai/sdk';

// Разбор спецификаций клиента (фото, PDF, Excel) через Claude:
// 1) extract — прочитать документ и выписать позиции;
// 2) match — для каждой позиции выбрать товар из кандидатов, найденных поиском, или признать, что его нет.

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    positions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Наименование как в документе, без номера строки' },
          query: {
            type: 'string',
            description: 'Короткий поисковый запрос: тип изделия + марка/типоразмер, напр. «Скоба СК-7-1А», «Изолятор ШФ-20», «Провод СИП-3 1х70»',
          },
          codes: { type: 'array', items: { type: 'string' }, description: 'Марки и артикулы из наименования: «SD37», «РЛНД-10/400», «LUG50-95/14LVFIN»' },
          qty: { type: 'number' },
          unit: { type: 'string', description: 'шт, м, км, кг, компл и т.п.' },
        },
        required: ['name', 'query', 'codes', 'qty', 'unit'],
        additionalProperties: false,
      },
    },
    note: { type: 'string', description: 'Что не удалось прочитать или требует уточнения; пусто, если всё ясно' },
  },
  required: ['positions', 'note'],
  additionalProperties: false,
};

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          position: { type: 'integer', description: 'Номер позиции из запроса' },
          product_id: { type: 'string', description: 'id выбранного кандидата или пустая строка, если подходящего нет' },
          kind: { type: 'string', enum: ['exact', 'analog', 'none'] },
          comment: { type: 'string', description: 'Коротко: почему аналог или чего не хватает; пусто для точного совпадения' },
        },
        required: ['position', 'product_id', 'kind', 'comment'],
        additionalProperties: false,
      },
    },
  },
  required: ['matches'],
  additionalProperties: false,
};

const EXTRACT_SYSTEM = [
  'Ты — инженер отдела снабжения электротехнической компании в Казахстане. Тебе присылают заявки и спецификации:',
  'фото таблиц (часто под углом, с рукописными пометками), PDF, выгрузки Excel.',
  'Выпиши ВСЕ позиции к закупке. Не пропускай строки, даже если их много или часть обрезана — тогда выпиши то, что читается, и отметь в note.',
  'Наименование переноси дословно (исправляя только явные ошибки распознавания). Марку/артикул в скобках сохрани в codes.',
  'Латиница и кириллица в марках часто путаются (СД/CD, ШФ/IF) — в query пиши так, как принято в российских и казахстанских каталогах.',
  'Количество — число; единицу бери из колонки «Ед.» (шт, м, км, кг, компл). Не выдумывай позиции и количества.',
  'Повторяющиеся на разных фото строки (одинаковое наименование и количество) выписывай один раз.',
].join('\n');

const MATCH_SYSTEM = [
  'Ты подбираешь товары из каталога под позиции спецификации клиента.',
  'Для каждой позиции дан список кандидатов из поиска. Выбери один товар или ни одного.',
  'exact — та же марка/типоразмер (допустимы разные написания: СИП-3 1х70 = SIP-3 1×70, ШФ-20Г = ШФ20Г).',
  'analog — другая марка или производитель, но тот же тип и те же ключевые параметры (сечение, напряжение, ток, типоразмер). В comment укажи, чем отличается.',
  'none — если ключевые параметры отличаются или кандидаты другого типа. Лучше none, чем неверный товар: позицию уточнит поставщик.',
  'Верни ровно по одной записи на каждую позицию.',
].join('\n');

const MIME_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export class SpecReader {
  constructor({ apiKey, model, client }) {
    this.client = client ?? new Anthropic({ apiKey });
    this.model = model;
  }

  async #json(system, content, schema) {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content }],
    });
    if (response.stop_reason === 'refusal') throw new Error('Модель отказалась обрабатывать документ');
    if (response.stop_reason === 'max_tokens') throw new Error('Документ слишком большой для одного запроса');
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return JSON.parse(text);
  }

  // files: [{ buffer, mime, filename }]; text — подпись клиента или текст из Excel.
  async extract(files, text = '') {
    const content = [];
    for (const f of files) {
      if (MIME_IMAGE.has(f.mime)) {
        content.push({ type: 'image', source: { type: 'base64', media_type: f.mime, data: f.buffer.toString('base64') } });
      } else if (f.mime === 'application/pdf') {
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } });
      } else if (f.text) {
        content.push({ type: 'text', text: `Файл «${f.filename}» (таблица, столбцы разделены табуляцией):\n${f.text}` });
      }
    }
    content.push({ type: 'text', text: `Выпиши позиции заявки.${text ? `\nСообщение клиента: ${text}` : ''}` });
    const result = await this.#json(EXTRACT_SYSTEM, content, EXTRACT_SCHEMA);
    return {
      positions: result.positions.filter((p) => p.name && p.qty > 0),
      note: result.note,
    };
  }

  // positions: [{ name, qty, unit, candidates: [{ id, title, sku, brand, price, unit, source }] }]
  async match(positions) {
    const blocks = positions.map((p, i) => {
      const cands = p.candidates.length
        ? p.candidates
            .map((c) => `   - id=${c.id} | ${c.title}${c.sku ? ` | арт. ${c.sku}` : ''}${c.brand ? ` | ${c.brand}` : ''} | ${c.unit}`)
            .join('\n')
        : '   (кандидатов нет)';
      return `${i + 1}. ${p.name} — ${p.qty} ${p.unit}\n${cands}`;
    });
    const result = await this.#json(MATCH_SYSTEM, [{ type: 'text', text: blocks.join('\n\n') }], MATCH_SCHEMA);
    const byPosition = new Map(result.matches.map((m) => [m.position, m]));
    return positions.map((p, i) => {
      const m = byPosition.get(i + 1);
      const ok = m && m.kind !== 'none' && p.candidates.some((c) => c.id === m.product_id);
      return ok ? { productId: m.product_id, kind: m.kind, comment: m.comment } : { productId: null, kind: 'none', comment: m?.comment ?? '' };
    });
  }
}

// Excel → текст для модели (первые листы, до 400 строк).
export async function excelToText(buffer) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];
  wb.eachSheet((sheet) => {
    if (out.length > 400) return;
    out.push(`# Лист «${sheet.name}»`);
    sheet.eachRow((row) => {
      if (out.length > 400) return;
      const cells = row.values.slice(1).map((v) => {
        if (v == null) return '';
        if (typeof v === 'object') return v.result ?? v.text ?? v.richText?.map((r) => r.text).join('') ?? '';
        return String(v);
      });
      if (cells.some((c) => c.trim())) out.push(cells.join('\t'));
    });
  });
  return out.join('\n');
}

// Конвертация количества в единицу товара (км → м и т.п.).
export function convertQty(qty, from, to) {
  const f = String(from || '').toLowerCase().replace('.', '');
  const t = String(to || '').toLowerCase().replace('.', '');
  if (f === t) return qty;
  if (f === 'км' && t === 'м') return qty * 1000;
  if (f === 'м' && t === 'км') return qty / 1000;
  if (f === 'т' && t === 'кг') return qty * 1000;
  return qty;
}
