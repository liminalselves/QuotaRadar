const SCALE = 10n ** 12n;
export function scaled(value: string | number): bigint {
  const text = String(value);
  if (!/^-?\d+(\.\d{1,12})?$/.test(text) || text.length > 60) throw new Error('金额必须是最多 12 位小数的十进制数');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, '0'));
  return negative ? -result : result;
}
export function fromScaled(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const n = value < 0n ? -value : value;
  const fraction = (n % SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return `${sign}${n / SCALE}${fraction ? `.${fraction}` : ''}`;
}
export function decimal(value: string | number): string { return fromScaled(scaled(value)); }
export function add(a: string, b: string): string { return fromScaled(scaled(a) + scaled(b)); }
export function subtract(a: string, b: string): string { return fromScaled(scaled(a) - scaled(b)); }
export function compare(a: string, b: string): number { const d = scaled(a) - scaled(b); return d < 0n ? -1 : d > 0n ? 1 : 0; }
export function divide(a: string, b: string): string {
  const denominator = scaled(b);
  if (denominator <= 0n) throw new Error('换算比例必须大于 0');
  const numerator = scaled(a) * SCALE;
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  return fromScaled(sign * ((absolute + denominator / 2n) / denominator));
}
export function formatAmount(value: string | null, unit = 'USD'): string {
  if (value === null) return '未知';
  const text = decimal(value);
  const [whole, fraction = ''] = text.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${unit === 'USD' ? '$' : ''}${grouped}.${fraction.padEnd(2, '0').slice(0, 4)}${unit === 'USD' ? '' : ` ${unit}`}`;
}
