import type { Cadence, ISODate, Item } from '../shared/types';

let currency = 'USD';
let moneyFmt = new Intl.NumberFormat(undefined, { style: 'currency', currency });

export function setCurrency(c: string) {
  if (c === currency) return;
  currency = c;
  moneyFmt = new Intl.NumberFormat(undefined, { style: 'currency', currency });
}

export function money(cents: number, opts: { sign?: boolean } = {}): string {
  const s = moneyFmt.format(Math.abs(cents) / 100);
  if (cents < 0) return `−${s}`;
  if (opts.sign && cents > 0) return `+${s}`;
  return s;
}

/** "12.50" or "-12.50" → cents. Returns null when unparseable. */
export function parseMoneyInput(s: string): number | null {
  const cleaned = s.replace(/[^\d.\-−]/g, '').replace('−', '-');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

// ISO dates are calendar dates: format them at UTC midnight so no timezone can shift the day.
const dt = (d: ISODate) => new Date(`${d}T00:00:00Z`);
const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...o });
const fmtShort = f({ month: 'short', day: 'numeric' });
const fmtDay = f({ weekday: 'short', month: 'short', day: 'numeric' });
const fmtLong = f({ weekday: 'long', month: 'long', day: 'numeric' });
const fmtMonth = f({ month: 'long', year: 'numeric' });
const fmtWeekday = f({ weekday: 'short' });

export const dateShort = (d: ISODate) => fmtShort.format(dt(d));
export const dateDay = (d: ISODate) => fmtDay.format(dt(d));
export const dateLong = (d: ISODate) => fmtLong.format(dt(d));
export const monthLabel = (d: ISODate) => fmtMonth.format(dt(d));
export const weekday = (d: ISODate) => fmtWeekday.format(dt(d));

export function rangeLabel(a: ISODate, b: ISODate): string {
  return `${dateShort(a)} – ${dateShort(b)}`;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export const CADENCE_LABEL: Record<Cadence, string> = {
  paycheck: 'Every payday',
  weekly: 'Weekly',
  biweekly: 'Every two weeks',
  semimonthly: 'Twice a month',
  monthly: 'Monthly',
  yearly: 'Yearly',
  once: 'Once',
};

export function cadenceSummary(i: Item): string {
  switch (i.cadence) {
    case 'paycheck':
      return 'Every payday';
    case 'weekly':
      return i.anchorDate ? `Weekly on ${weekday(i.anchorDate)}` : 'Weekly';
    case 'biweekly':
      return i.anchorDate ? `Every other ${weekday(i.anchorDate)}` : 'Every two weeks';
    case 'semimonthly':
      return `The ${ordinal(i.dayOfMonth ?? 1)} and ${ordinal(i.dayOfMonth2 ?? 15)}`;
    case 'monthly': {
      const day = i.dayOfMonth === 31 ? 'last day' : ordinal(i.dayOfMonth ?? 1);
      if (i.intervalMonths === 1) return `Monthly on the ${day}`;
      if (i.intervalMonths === 3) return `Quarterly on the ${day}`;
      if (i.intervalMonths === 12) return `Yearly on the ${day}`;
      return `Every ${i.intervalMonths} months on the ${day}`;
    }
    case 'yearly':
      return i.anchorDate ? `Yearly on ${dateShort(i.anchorDate)}` : 'Yearly';
    case 'once':
      return i.anchorDate ? `Once, ${dateShort(i.anchorDate)}` : 'Once';
  }
}

export const ALLOCATION_LABEL = { due: 'On its date', spread: 'Envelope', reserve: 'Fund' } as const;
