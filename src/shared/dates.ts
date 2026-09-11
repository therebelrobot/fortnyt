// Calendar-date math on `YYYY-MM-DD` strings.
// Everything goes through a "day number" (days since 1970-01-01, computed in UTC),
// so daylight-saving shifts can never make a pay period 13 or 15 days long.

import type { ISODate } from './types';

const MS_PER_DAY = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string') return false;
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function toDayNum(date: ISODate): number {
  const m = ISO_RE.exec(date);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PER_DAY);
}

export function fromDayNum(n: number): ISODate {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromDayNum(toDayNum(date) + days);
}

/** a − b, in days */
export function diffDays(a: ISODate, b: ISODate): number {
  return toDayNum(a) - toDayNum(b);
}

export function parts(date: ISODate): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d };
}

/** m is 1–12 */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Builds a date, rolling month overflow and clamping the day (Jan 31 + 1 month → Feb 28/29). */
export function makeDate(y: number, m: number, d: number): ISODate {
  const total = y * 12 + (m - 1);
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  const dd = Math.min(Math.max(d, 1), daysInMonth(yy, mm));
  return `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export function monthStart(date: ISODate): ISODate {
  const { y, m } = parts(date);
  return makeDate(y, m, 1);
}

export function monthEnd(date: ISODate): ISODate {
  const { y, m } = parts(date);
  return makeDate(y, m, daysInMonth(y, m));
}

export function addMonths(date: ISODate, months: number): ISODate {
  const { y, m, d } = parts(date);
  return makeDate(y, m + months, d);
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(date: ISODate): number {
  // 1970-01-01 was a Thursday (4). The double modulo keeps pre-1970 dates positive.
  return (((toDayNum(date) + 4) % 7) + 7) % 7;
}

export function startOfWeek(date: ISODate, weekStartsOn = 0): ISODate {
  const dow = dayOfWeek(date);
  return addDays(date, -((dow - weekStartsOn + 7) % 7));
}

export function* eachDay(from: ISODate, to: ISODate): Generator<ISODate> {
  const end = toDayNum(to);
  for (let n = toDayNum(from); n <= end; n++) yield fromDayNum(n);
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a <= b ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a >= b ? a : b;
}

/** Local calendar date of an instant in an IANA timezone. */
export function localDateOf(instant: Date, timeZone: string): ISODate {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function localDateOfEpoch(seconds: number, timeZone: string): ISODate {
  return localDateOf(new Date(seconds * 1000), timeZone);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
