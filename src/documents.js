// PDF коммерческого предложения и счёта на оплату (pdfkit, кириллица — DejaVu).
import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { amountInWords, money, qty, round2, vatIncluded, VAT_RATE } from './money.js';

const FONT_R = new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url).pathname;
const FONT_B = new URL('../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url).pathname;

const NAVY = '#1f3a8a';
const INK = '#1d2433';
const LINE = '#dfe3ec';
const OK = ['#e3f4e8', '#1d7a3a'];
const ORDER = ['#fff2d6', '#9a6500'];

const PAGE_BOTTOM = 790;
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export const longDate = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} г.`;

// Итоги по строкам [{ qty, priceVat }] — цены с НДС, НДС «в том числе».
export function totals(lines) {
  const total = round2(lines.reduce((s, l) => s + round2(l.qty * l.priceVat), 0));
  const vat = vatIncluded(total);
  return { total, vat, net: round2(total - vat) };
}

function newDoc() {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Producer: 'AIMAG', Creator: 'AIMAG КП-бот' } });
  doc.registerFont('R', FONT_R);
  doc.registerFont('B', FONT_B);
  doc.font('R').fillColor(INK);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  return { doc, done };
}

// Таблица с переносом длинных названий и переходом на новую страницу.
// cols: [{ title, width, align }], rows: [[cell | { text, pill: [bg, fg] }]]
function table(doc, x, y, cols, rows, { border = false, headFill = NAVY, headColor = '#fff', size = 8.5, zebra = true } = {}) {
  const padX = 4;
  const padY = 5;
  const totalW = cols.reduce((s, c) => s + c.width, 0);
  const cellText = (c) => (typeof c === 'object' && c !== null ? c.text : String(c ?? ''));

  const header = () => {
    doc.font('B').fontSize(size);
    const h = Math.max(...cols.map((c) => doc.heightOfString(c.title, { width: c.width - padX * 2 }))) + padY * 2;
    if (headFill) doc.rect(x, y, totalW, h).fill(headFill);
    let cx = x;
    for (const c of cols) {
      doc.fillColor(headFill ? headColor : INK).text(c.title, cx + padX, y + padY, { width: c.width - padX * 2, align: c.align || 'left' });
      if (border) doc.rect(cx, y, c.width, h).lineWidth(0.7).stroke(INK);
      cx += c.width;
    }
    y += h;
  };

  header();
  rows.forEach((row, i) => {
    doc.font('R').fontSize(size);
    const h = Math.max(...row.map((c, j) => doc.heightOfString(cellText(c), { width: cols[j].width - padX * 2 }))) + padY * 2;
    if (y + h > PAGE_BOTTOM) {
      doc.addPage();
      y = 40;
      header();
      doc.font('R').fontSize(size);
    }
    if (zebra && !border && i % 2 === 1) doc.rect(x, y, totalW, h).fill('#fafbfd');
    let cx = x;
    row.forEach((c, j) => {
      const col = cols[j];
      const text = cellText(c);
      if (c && typeof c === 'object' && c.pill) {
        doc.fontSize(size - 1);
        const w = Math.min(doc.widthOfString(text) + 8, col.width - 4);
        const px = cx + (col.width - w) / 2;
        doc.roundedRect(px, y + padY - 1.5, w, doc.currentLineHeight() + 3, 3).fill(c.pill[0]);
        doc.fillColor(c.pill[1]).text(text, px, y + padY, { width: w, align: 'center', lineBreak: false });
        doc.fontSize(size);
      } else {
        doc.fillColor(INK).text(text, cx + padX, y + padY, { width: col.width - padX * 2, align: col.align || 'left' });
      }
      if (border) doc.rect(cx, y, col.width, h).lineWidth(0.7).stroke(INK);
      cx += col.width;
    });
    if (!border) doc.moveTo(x, y + h).lineTo(x + totalW, y + h).lineWidth(0.6).stroke(LINE);
    y += h;
  });
  return y;
}

const idLabel = (company) => company.idLabel || 'ИИН';

function stamp(doc, company, x, y, width = 150) {
  if (company.stampPath && fs.existsSync(company.stampPath)) {
    doc.image(company.stampPath, x, y, { width });
  }
}

// Коммерческое предложение — фирменный стиль AIMAG ELECTRIC (эталон КП-261017-03, шаблон в Google Drive).
// Тёмная шапка #121D2B с янтарной полосой #FFB300, реквизиты в две колонки, плашка «Кому», янтарная плашка «Итого».
// Для Bereke шапка AIMAG ELECTRIC остаётся, а название, реквизиты, подпись и печать — Bereke.
// kp: { number, date, validUntil, buyer: { name, bin?, address?, phone? }, lines: [{ title, qty, unit, priceVat, status: 'stock'|'order', leadTime? }], pending?: [...] }
const K = { dark: '#121D2B', amber: '#FFB300', zebra: '#F6F8FA', to: '#FFF8E6', line: '#E3E8EE', grey: '#4A5B6E', foot: '#8A96A5', head: '#D6DDE6' };
const FONT_I = {
  R: new URL('../assets/fonts/Inter-Regular.ttf', import.meta.url).pathname,
  S: new URL('../assets/fonts/Inter-SemiBold.ttf', import.meta.url).pathname,
  B: new URL('../assets/fonts/Inter-Bold.ttf', import.meta.url).pathname,
  I: new URL('../assets/fonts/Inter-Italic.ttf', import.meta.url).pathname,
};
const shortDate = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
const plainName = (n) => String(n || '').replace(/[«»"]/g, '');

export async function renderKP(kp, company) {
  const { doc, done } = newDoc();
  for (const [k, f] of Object.entries(FONT_I)) doc.registerFont(`I${k}`, f);
  const L = 40;
  const W = 515;
  const seller = plainName(company.name);
  let page = 1;
  const footer = () => {
    // Нижнее поле страницы 40pt — снимаем его на время футера, иначе pdfkit начнёт новую страницу.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('IR').fontSize(7).fillColor(K.foot).text(`AIMAG ELECTRIC · www.aimag.kz · ${company.phone} · стр. ${page}`, L, 812, { width: W, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
  };
  const newPage = () => {
    footer();
    doc.addPage();
    page += 1;
    return 40;
  };

  // Шапка AIMAG ELECTRIC
  doc.roundedRect(L, 34, W, 60, 5).fill(K.dark);
  doc.rect(L, 91, W, 3).fill(K.amber);
  doc.roundedRect(L + 14, 46, 32, 32, 6).fill(K.amber);
  doc.font('IB').fontSize(21).fillColor(K.dark).text('A', L + 14, 50.5, { width: 32, align: 'center' });
  doc.font('IB').fontSize(20).fillColor('#fff').text('AIMAG', L + 56, 45);
  doc.font('IS').fontSize(9).fillColor(K.amber).text('ELECTRIC', L + 57, 68, { characterSpacing: 3 });
  doc.font('IR').fontSize(8).fillColor(K.head).text(
    `Электротехника для промышленных проектов\nг. Шымкент · доставка по всему Казахстану\n${company.phone} · www.aimag.kz`,
    L + 250, 46, { width: W - 264, align: 'right', lineGap: 1.6 },
  );

  // Реквизиты продавца в две колонки
  let y = 104;
  doc.font('IB').fontSize(8).fillColor(K.dark).text(seller, L, y, { continued: true })
    .font('IR').fillColor(K.grey).text(` · ${idLabel(company)} ${company.iin} · плательщик НДС`);
  if (company.director) doc.font('IR').fontSize(8).fillColor(K.grey).text(`Руководитель: ${company.director}`, L, doc.y + 1.5);
  const leftBottom = doc.y;
  doc.font('IR').fontSize(8).fillColor(K.grey).text(`${company.bank} · БИК ${company.bik}\nИИК ${company.iik}`, L + 260, y, { width: W - 260, align: 'right', lineGap: 1.5 });
  y = Math.max(leftBottom, doc.y) + 12;

  doc.font('IB').fontSize(19).fillColor(K.dark).text('Коммерческое предложение', L, y);
  doc.font('IR').fontSize(9.5).fillColor(K.grey).text(`№ ${kp.number} от ${shortDate(kp.date)} · действительно до ${shortDate(kp.validUntil)}`, L, doc.y + 1);
  y = doc.y + 9;

  // Плашка «Кому»
  const buyer = [kp.buyer.name, kp.buyer.bin ? `БИН ${kp.buyer.bin}` : null, kp.buyer.address].filter(Boolean).join(', ');
  const intro = `${seller} предлагает поставку электротехнической продукции по вашей заявке.`;
  doc.font('IR').fontSize(9);
  const toH = doc.heightOfString(`Кому: ${buyer}`, { width: W - 24 }) + doc.heightOfString(intro, { width: W - 24 }) + 14;
  doc.rect(L, y, W, toH).fill(K.to);
  doc.rect(L, y, 3, toH).fill(K.amber);
  doc.font('IB').fontSize(9).fillColor(K.dark).text('Кому: ', L + 12, y + 7, { continued: true, width: W - 24 }).font('IR').text(buyer);
  doc.font('IR').fontSize(9).text(intro, L + 12, doc.y + 1, { width: W - 24 });
  y += toH + 10;

  // Таблица позиций
  const cols = [
    { title: '№', width: 22, align: 'center' },
    { title: 'Наименование', width: 185 },
    { title: 'Ед.', width: 30, align: 'center' },
    { title: 'Кол-во', width: 48, align: 'right' },
    { title: 'Цена с НДС, ₸', width: 78, align: 'right' },
    { title: 'Сумма с НДС, ₸', width: 82, align: 'right' },
    { title: 'Наличие', width: 70, align: 'center' },
  ];
  const padX = 5;
  const head = () => {
    doc.font('IS').fontSize(8);
    const h = 20;
    doc.rect(L, y, W, h).fill(K.dark);
    let cx = L;
    for (const c of cols) {
      doc.fillColor('#fff').text(c.title, cx + padX, y + 6, { width: c.width - padX * 2, align: c.align || 'left', lineBreak: false });
      cx += c.width;
    }
    y += h;
  };
  head();
  kp.lines.forEach((l, i) => {
    const cells = [String(i + 1), l.title, l.unit, qty(l.qty), money(l.priceVat), money(round2(l.qty * l.priceVat))];
    doc.font('IR').fontSize(8);
    const h = Math.max(...cells.map((c, j) => doc.heightOfString(c, { width: cols[j].width - padX * 2 }))) + 9;
    if (y + h > PAGE_BOTTOM) {
      y = newPage();
      head();
    }
    if (i % 2 === 1) doc.rect(L, y, W, h).fill(K.zebra);
    let cx = L;
    cells.forEach((c, j) => {
      doc.font('IR').fontSize(8).fillColor(K.dark).text(c, cx + padX, y + 4.5, { width: cols[j].width - padX * 2, align: cols[j].align || 'left' });
      cx += cols[j].width;
    });
    const stock = l.status === 'stock';
    const label = stock ? 'в наличии' : `под заказ${l.leadTime ? `, ${l.leadTime}` : ''}`;
    const [bg, fg] = stock ? OK : ORDER;
    doc.font('IS').fontSize(6.8);
    const pw = cols[6].width - 6;
    const ph = doc.heightOfString(label, { width: pw - 6 }) + 4;
    doc.roundedRect(cx + 3, y + (h - ph) / 2, pw, ph, 3).fill(bg);
    doc.fillColor(fg).text(label, cx + 6, y + (h - ph) / 2 + 2, { width: pw - 6, align: 'center' });
    doc.moveTo(L, y + h).lineTo(L + W, y + h).lineWidth(0.6).stroke(K.line);
    y += h;
  });

  // Итого
  const t = totals(kp.lines);
  if (y + 90 > PAGE_BOTTOM) y = newPage();
  y += 8;
  const bw = 230;
  doc.rect(L + W - bw, y, bw, 22).fill(K.amber);
  doc.font('IB').fontSize(10.5).fillColor(K.dark).text('Итого с НДС:', L + W - bw + 10, y + 5.5).text(`${money(t.total)} ₸`, L + W - bw + 10, y + 5.5, { width: bw - 20, align: 'right' });
  y += 28;
  doc.font('IR').fontSize(8.5).fillColor(K.dark).text(`Сумма без НДС: ${money(t.net)} · в том числе НДС ${Math.round(VAT_RATE * 100)}%: ${money(t.vat)}`, L, y, { width: W, align: 'right' });
  y = doc.y + 6;
  doc.font('II').fontSize(8.5).fillColor(K.grey).text(`Сумма прописью: ${amountInWords(t.total)}, в т.ч. НДС ${Math.round(VAT_RATE * 100)}%.`, L, y, { width: W });
  y = doc.y + 8;

  if (kp.pending?.length) {
    doc.font('IS').fontSize(8.5).fillColor(ORDER[1]).text('Уточняем у поставщиков и дополним предложение:', L, y, { width: W });
    doc.font('IR').fillColor(K.dark).text(kp.pending.map((p) => `• ${p}`).join('\n'), L, doc.y + 2, { width: W });
    y = doc.y + 8;
  }

  // Условия поставки
  const terms = [
    `Цены в тенге с учётом НДС ${Math.round(VAT_RATE * 100)}%. Предложение действительно 7 календарных дней.`,
    'Оплата: 100% предоплата за позиции под заказ; позиции в наличии — по счёту.',
    'Срок поставки: со склада в Шымкенте — 1–3 рабочих дня по Казахстану; позиции под заказ — срок подтверждается при оплате.',
    'Документы: счёт на оплату, накладная, ЭСФ, сертификаты соответствия.',
  ];
  doc.font('IR').fontSize(8.5);
  const termsH = terms.reduce((sum, x) => sum + doc.heightOfString(`•  ${x}`, { width: W - 10 }) + 2, 0) + 20;
  if (y + termsH + 110 > PAGE_BOTTOM) y = newPage();
  doc.font('IB').fontSize(10.5).fillColor(K.dark).text('Условия поставки', L, y);
  y = doc.y + 3;
  for (const x of terms) {
    doc.font('IR').fontSize(8.5).fillColor(K.dark).text(`•  ${x}`, L + 4, y, { width: W - 10, lineGap: 1 });
    y = doc.y + 2;
  }
  y += 16;

  // Подпись и печать
  const role = `Руководитель ${seller}`;
  doc.font('IR').fontSize(9.5).fillColor(K.dark).text(role, L, y + 40);
  const lx = L + doc.widthOfString(role) + 14;
  doc.moveTo(lx, y + 52).lineTo(L + 360, y + 52).lineWidth(0.8).stroke(K.dark);
  if (company.director) doc.text(company.director, L + 372, y + 40);
  stamp(doc, company, lx + 10, y - 4, 125);

  footer();
  doc.end();
  return done;
}

// Счёт на оплату — стандартная форма 1С «Счет на оплату покупателю» (как у AIMAG из 1С), одинаковая для всех продавцов.
// inv: { number, date, buyer: { text }, contract?, lines: [{ title, code?, qty, unit, priceVat }] }
export async function renderInvoice(inv, company) {
  const { doc, done } = newDoc();
  const L = 40;
  const W = 515;

  doc.font('B').fontSize(8).fillColor(INK).text(
    'Внимание! Оплата данного счета означает согласие с условиями поставки товара. Уведомление об оплате обязательно, в противном случае не гарантируется наличие товара на складе. Товар отпускается по факту прихода денег на р/с Поставщика, самовывозом, при наличии доверенности и документов удостоверяющих личность.',
    L, 40, { width: W, align: 'center' },
  );

  doc.font('B').fontSize(10.5).text('Образец платежного поручения', L, 92);
  // Сетка 2×3
  const gy = 110;
  const c = [L, L + 285, L + 425, L + W];
  const rh = 46;
  doc.lineWidth(0.7).strokeColor(INK);
  doc.rect(L, gy, W, rh * 2).stroke();
  doc.moveTo(L, gy + rh).lineTo(L + W, gy + rh).stroke();
  doc.moveTo(c[1], gy).lineTo(c[1], gy + rh * 2).stroke();
  doc.moveTo(c[2], gy).lineTo(c[2], gy + rh * 2).stroke();
  const cell = (text, x, y, w, opts = {}) => doc.font(opts.bold ? 'B' : 'R').fontSize(opts.size || 8.5).fillColor(INK).text(text, x + 5, y + 5, { width: w - 10, align: opts.align || 'left' });
  cell(`Бенефициар:\n${company.name}\nБИН: ${company.iin}`, c[0], gy, c[1] - c[0]);
  cell('ИИК', c[1], gy, c[2] - c[1], { bold: true, align: 'center' });
  cell(company.iik, c[1], gy + 20, c[2] - c[1], { bold: true, align: 'center' });
  cell('КБе', c[2], gy, c[3] - c[2], { bold: true, align: 'center' });
  cell(company.kbe || '—', c[2], gy + 20, c[3] - c[2], { bold: true, align: 'center' });
  cell(`Банк бенефициара:\n${company.bank}`, c[0], gy + rh, c[1] - c[0]);
  cell(`БИК\n${company.bik}`, c[1], gy + rh, c[2] - c[1], { bold: true, align: 'center' });
  cell(`Код назначения\nплатежа ${company.knp}`, c[2], gy + rh, c[3] - c[2], { bold: true, align: 'center', size: 8 });

  let y = gy + rh * 2 + 18;
  doc.font('B').fontSize(14).fillColor(INK).text(`Счет на оплату № ${inv.number} от ${longDate(inv.date)}`, L, y);
  y = doc.y + 6;
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(1.2).stroke(INK);
  y += 10;

  const party = (label, text) => {
    doc.font('R').fontSize(9).fillColor(INK).text(label, L, y);
    doc.font('B').fontSize(9).text(text, L + 85, y, { width: W - 85 });
    y = doc.y + 8;
  };
  party('Поставщик:', `БИН / ИИН ${company.iin}, ${company.name}`);
  party('Покупатель:', inv.buyer.text);
  party('Договор:', inv.contract || 'Без договора');

  y = table(
    doc,
    L,
    y + 4,
    [
      { title: '№', width: 26 },
      { title: 'Наименование', width: 233 },
      { title: 'Кол-во', width: 62 },
      { title: 'Ед.', width: 34 },
      { title: 'Цена', width: 70 },
      { title: 'Сумма', width: 90 },
    ],
    inv.lines.map((l, i) => [String(i + 1), l.code ? `${l.title} (${l.code})` : l.title, qty(l.qty), l.unit, money(l.priceVat), money(round2(l.qty * l.priceVat))]),
    { border: true, headFill: null, size: 8.5 },
  );

  const t = totals(inv.lines);
  if (y + 190 > PAGE_BOTTOM) {
    doc.addPage();
    y = 40;
  }
  y += 10;
  doc.font('B').fontSize(10.5).fillColor(INK);
  doc.text('Итого:', L + 250, y, { width: 135, align: 'right' }).text(money(t.total), L + 395, y, { width: 120, align: 'right' });
  y += 17;
  doc.text('В том числе НДС:', L + 150, y, { width: 235, align: 'right' }).text(money(t.vat), L + 395, y, { width: 120, align: 'right' });
  y += 28;
  doc.font('R').fontSize(9).text(`Всего наименований ${inv.lines.length}, на сумму ${money(t.total)} KZT`, L, y);
  y += 18;
  doc.font('B').text(`Всего к оплате: ${amountInWords(t.total)}`, L, y, { width: W });
  y = doc.y + 12;
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(1.2).stroke(INK);
  y += 6;

  doc.font('B').fontSize(9.5).text('Исполнитель', L, y + 34);
  doc.moveTo(L + 100, y + 46).lineTo(L + 310, y + 46).lineWidth(0.8).stroke(INK);
  stamp(doc, company, L + 115, y - 14, 150);
  doc.font('R').text(`/${company.director}/`, L + 325, y + 34);
  doc.fontSize(8.5).text('М.П.', L + 300, y + 110);

  doc.end();
  return done;
}
