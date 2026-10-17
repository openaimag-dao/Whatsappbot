// Деньги: НДС, округление, формат и сумма прописью (тенге/тиын).

export const VAT_RATE = 0.16;

export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

// «В том числе НДС» из суммы с НДС: итог × 16/116.
export const vatIncluded = (totalWithVat, rate = VAT_RATE) => round2((totalWithVat * rate) / (1 + rate));

// 34565700 → «34 565 700,00»
export function money(x) {
  const [int, frac] = round2(x).toFixed(2).split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${frac}`;
}

// 2138 → «2 138», 2.5 → «2,5»
export function qty(x) {
  const [int, frac] = String(round2(x)).split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${frac ? `,${frac}` : ''}`;
}

const ONES_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
// [одна, две-четыре, пять+], род
const SCALES = [
  [['', '', ''], 'm'],
  [['тысяча', 'тысячи', 'тысяч'], 'f'],
  [['миллион', 'миллиона', 'миллионов'], 'm'],
  [['миллиард', 'миллиарда', 'миллиардов'], 'm'],
];

function plural(n, forms) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return forms[0];
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return forms[1];
  return forms[2];
}

function triad(n, gender) {
  const words = [HUNDREDS[Math.floor(n / 100)]];
  const rest = n % 100;
  if (rest >= 10 && rest < 20) words.push(TEENS[rest - 10]);
  else words.push(TENS[Math.floor(rest / 10)], (gender === 'f' ? ONES_F : ONES_M)[rest % 10]);
  return words.filter(Boolean);
}

export function numberToWords(n) {
  n = Math.floor(n);
  if (n === 0) return 'ноль';
  const parts = [];
  for (let i = 0; n > 0 && i < SCALES.length; i += 1, n = Math.floor(n / 1000)) {
    const t = n % 1000;
    if (!t) continue;
    const [forms, gender] = SCALES[i];
    parts.unshift([...triad(t, gender), plural(t, forms)].filter(Boolean).join(' '));
  }
  return parts.join(' ');
}

// 34565700 → «Тридцать четыре миллиона пятьсот шестьдесят пять тысяч семьсот тенге 00 тиын»
export function amountInWords(x) {
  const [int, frac] = round2(x).toFixed(2).split('.');
  const words = numberToWords(Number(int));
  return `${words[0].toUpperCase()}${words.slice(1)} тенге ${frac} тиын`;
}
