// PDF коммерческого предложения и счёта на оплату (pdfkit, кириллица — DejaVu).
import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { amountInWords, money, qty, round2, vatIncluded, VAT_RATE } from './money.js';

const FONT_R = new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url).pathname;
const FONT_B = new URL('../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url).pathname;

const NAVY = '#1f3a8a';
const GOLD = '#e0a100';
const INK = '#1d2433';
const MUTED = '#6b7384';
const LINE = '#dfe3ec';
const SOFT = '#f3f5fa';
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

function stamp(doc, company, x, y, width = 150) {
  if (company.stampPath && fs.existsSync(company.stampPath)) {
    doc.image(company.stampPath, x, y, { width });
  }
}

// Коммерческое предложение.
// kp: { number, date, validUntil, buyer: { name, bin?, address? }, lines: [{ title, qty, unit, priceVat, status: 'stock'|'order', leadTime? }], pending?: [названия позиций, которые уточняются] }
export async function renderKP(kp, company) {
  const { doc, done } = newDoc();
  const L = 40;
  const W = 515;

  doc.rect(0, 0, 595.28, 16).fill(NAVY);

  // Шапка
  doc.font('B').fontSize(24).fillColor(NAVY).text('AIM', L, 38, { continued: true }).fillColor(GOLD).text('A', { continued: true }).fillColor(NAVY).text('G');
  doc.font('R').fontSize(7.5).fillColor(MUTED).text('Кабельно-проводниковая продукция и электрооборудование', L, 68);
  doc.fontSize(7.5).fillColor('#3a4252').text(
    [`${company.name} · ИИН ${company.iin}`, company.address, [company.phone, company.email].filter(Boolean).join(' · '), company.site].filter(Boolean).join('\n'),
    L + 280, 40, { width: W - 280, align: 'right', lineGap: 1.5 },
  );

  doc.font('B').fontSize(16).fillColor(INK).text(`Коммерческое предложение № ${kp.number}`, L, 100);
  doc.font('R').fontSize(8.5).fillColor(MUTED).text(`от ${longDate(kp.date)} · действительно до ${longDate(kp.validUntil)}`, L, 122);

  // Стороны
  const py = 142;
  const half = (W - 10) / 2;
  const buyer = [kp.buyer.bin ? `БИН/ИИН ${kp.buyer.bin}` : null, kp.buyer.address, kp.buyer.phone].filter(Boolean).join('\n');
  const seller = `ИИН ${company.iin} · плательщик НДС\n${company.bank}, БИК ${company.bik}\nИИК ${company.iik}`;
  doc.font('R').fontSize(8.5);
  const ph = Math.max(doc.heightOfString(buyer, { width: half - 20 }), doc.heightOfString(seller, { width: half - 20 })) + 40;
  for (const [i, [label, name, body]] of [['ЗАКАЗЧИК', kp.buyer.name, buyer], ['ПОСТАВЩИК', company.name, seller]].entries()) {
    const bx = L + i * (half + 10);
    doc.rect(bx, py, half, ph).fill(SOFT);
    doc.font('R').fontSize(6.5).fillColor(MUTED).text(label, bx + 10, py + 9, { characterSpacing: 1 });
    doc.font('B').fontSize(9).fillColor(INK).text(name, bx + 10, py + 20, { width: half - 20 });
    doc.font('R').fontSize(8.5).text(body, bx + 10, doc.y + 2, { width: half - 20, lineGap: 1.5 });
  }

  // Позиции
  const rows = kp.lines.map((l, i) => [
    String(i + 1),
    l.title,
    qty(l.qty),
    l.unit,
    money(l.priceVat),
    money(round2(l.qty * l.priceVat)),
    l.status === 'stock' ? { text: 'в наличии', pill: OK } : { text: `под заказ${l.leadTime ? `, ${l.leadTime}` : ''}`, pill: ORDER },
  ]);
  let y = table(
    doc,
    L,
    py + ph + 14,
    [
      { title: '№', width: 22, align: 'center' },
      { title: 'Наименование', width: 160 },
      { title: 'Кол-во', width: 50, align: 'right' },
      { title: 'Ед.', width: 28, align: 'center' },
      { title: 'Цена с НДС, ₸', width: 85, align: 'right' },
      { title: 'Сумма с НДС, ₸', width: 85, align: 'right' },
      { title: 'Наличие', width: 85, align: 'center' },
    ],
    rows,
  );

  // Итоги
  const t = totals(kp.lines);
  if (y + 120 > PAGE_BOTTOM) {
    doc.addPage();
    y = 40;
  }
  y += 8;
  const tx = L + 300;
  for (const [label, value] of [['Сумма без НДС', money(t.net)], [`НДС ${Math.round(VAT_RATE * 100)}%`, money(t.vat)]]) {
    doc.font('R').fontSize(9).fillColor(INK).text(label, tx, y).text(value, tx, y, { width: W - 300, align: 'right' });
    y += 15;
  }
  doc.moveTo(tx, y).lineTo(L + W, y).lineWidth(1.5).stroke(NAVY);
  y += 6;
  doc.font('B').fontSize(12).fillColor(NAVY).text('Итого с НДС', tx, y).text(`${money(t.total)} ₸`, tx, y, { width: W - 300, align: 'right' });
  y += 22;
  doc.font('R').fontSize(8.5).fillColor('#3a4252').text(`${amountInWords(t.total)}, в т.ч. НДС ${Math.round(VAT_RATE * 100)}%`, L, y, { width: W });
  y = doc.y + 6;

  if (kp.pending?.length) {
    doc.font('B').fontSize(8.5).fillColor(ORDER[1]).text('Уточняем у поставщиков и дополним предложение:', L, y, { width: W });
    doc.font('R').fillColor(INK).text(kp.pending.map((p) => `• ${p}`).join('\n'), L, doc.y + 2, { width: W });
    y = doc.y + 6;
  }

  // Условия
  const terms = [
    ['Срок действия', '7 календарных дней с даты КП'],
    ['Оплата', '100% предоплата за позиции под заказ; для наличия — по счёту'],
    ['Доставка', 'По Казахстану 1–3 дня после оплаты, склад — г. Шымкент'],
    ['Документы', 'Счёт на оплату, накладная, ЭСФ, сертификаты'],
  ];
  const tw = W / 4;
  doc.font('R').fontSize(8);
  const th = Math.max(...terms.map(([, v]) => doc.heightOfString(v, { width: tw - 14 }))) + 30;
  if (y + th + 130 > PAGE_BOTTOM) {
    doc.addPage();
    y = 40;
  }
  terms.forEach(([k, v], i) => {
    const bx = L + i * tw;
    doc.rect(bx, y, tw, th).lineWidth(0.7).stroke(LINE);
    doc.font('B').fontSize(8.5).fillColor(NAVY).text(k, bx + 7, y + 8, { width: tw - 14 });
    doc.font('R').fontSize(8).fillColor(INK).text(v, bx + 7, y + 21, { width: tw - 14 });
  });
  y += th + 14;

  // Подпись
  doc.font('R').fontSize(9.5).fillColor(INK).text('Руководитель', L, y + 48);
  doc.moveTo(L + 110, y + 60).lineTo(L + 280, y + 60).lineWidth(0.8).stroke(INK);
  stamp(doc, company, L + 110, y - 12, 140);
  doc.text(company.director, L + 295, y + 48);
  y += 125;

  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.6).stroke(LINE);
  doc.fontSize(7).fillColor(MUTED).text(
    `Цены указаны в тенге с учётом НДС ${Math.round(VAT_RATE * 100)}%. Наличие позиций «под заказ» подтверждается в момент оплаты. Для оформления счёта нажмите «Согласен» в WhatsApp.`,
    L, y + 5, { width: W },
  );

  doc.end();
  return done;
}

// Счёт на оплату — по образцу счёта AIMAG.
// inv: { number, date, buyer: { text }, contract?, lines: [{ title, code?, qty, unit, priceVat }] }
export async function renderInvoice(inv, company) {
  const { doc, done } = newDoc();
  const L = 40;
  const W = 515;

  doc.font('B').fontSize(8).fillColor(INK).text(
    'Внимание! При оплате укажите номер и дату счета. Уведомление об оплате направьте поставщику.\nНаличие товара и условия отгрузки согласовываются с поставщиком.',
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
  cell(`Бенефициар:\n${company.name}\nИИН: ${company.iin}`, c[0], gy, c[1] - c[0]);
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
  party('Поставщик:', `ИИН ${company.iin}, ${company.name}, ${company.address}, тел.: ${company.phone}`);
  party('Покупатель:', inv.buyer.text);
  party('Договор:', inv.contract || '—');

  y = table(
    doc,
    L,
    y + 4,
    [
      { title: '№', width: 24 },
      { title: 'Код', width: 40 },
      { title: 'Наименование', width: 190 },
      { title: 'Кол-во', width: 64 },
      { title: 'Ед.', width: 32 },
      { title: 'Цена', width: 70 },
      { title: 'Сумма', width: 95 },
    ],
    inv.lines.map((l, i) => [String(i + 1), l.code || '—', l.title, qty(l.qty), l.unit, money(l.priceVat), money(round2(l.qty * l.priceVat))]),
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
  doc.text(`В том числе НДС ${Math.round(VAT_RATE * 100)}%:`, L + 150, y, { width: 235, align: 'right' }).text(money(t.vat), L + 395, y, { width: 120, align: 'right' });
  y += 28;
  doc.font('R').fontSize(9).text(`Всего наименований ${inv.lines.length}, на сумму ${money(t.total)} KZT`, L, y);
  y += 18;
  doc.font('B').text(`Всего к оплате: ${amountInWords(t.total)}`, L, y, { width: W });
  y = doc.y + 12;
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(1.2).stroke(INK);
  y += 6;

  doc.font('B').fontSize(9.5).text('Руководитель', L, y + 34);
  doc.moveTo(L + 100, y + 46).lineTo(L + 310, y + 46).lineWidth(0.8).stroke(INK);
  stamp(doc, company, L + 115, y - 14, 150);
  doc.font('R').text(company.director, L + 325, y + 34);
  doc.fontSize(8.5).text('М.П.', L + 300, y + 110);

  doc.end();
  return done;
}
