// Expands budget lines into dated occurrences, and maps dates onto pay periods.

import {
  addDays,
  daysInMonth,
  diffDays,
  fromDayNum,
  makeDate,
  parts,
  toDayNum,
} from './dates';
import type { Cadence, ISODate, Item, Period } from './types';

/** Cadences that fall on a single fixed calendar date rather than a day-of-month rule. */
export function needsAnchorDate(cadence: Cadence): boolean {
  return cadence === 'weekly' || cadence === 'biweekly' || cadence === 'yearly' || cadence === 'once';
}

export interface PaySchedule {
  /** any real payday; every period starts on a payday */
  anchor: ISODate;
  intervalDays: number;
}

export type RecurrenceSpec = Pick<
  Item,
  'cadence' | 'anchorDate' | 'dayOfMonth' | 'dayOfMonth2' | 'intervalMonths' | 'startDate' | 'endDate'
>;

// ---------------------------------------------------------------------------
// Pay periods
// ---------------------------------------------------------------------------

export function periodIndexOf(date: ISODate, pay: PaySchedule): number {
  return Math.floor(diffDays(date, pay.anchor) / pay.intervalDays);
}

export function periodByIndex(index: number, pay: PaySchedule, today: ISODate): Period {
  const start = addDays(pay.anchor, index * pay.intervalDays);
  const end = addDays(start, pay.intervalDays - 1);
  const status = end < today ? 'past' : start > today ? 'future' : 'current';
  return { index, start, end, payday: start, status };
}

export function periodOf(date: ISODate, pay: PaySchedule, today: ISODate): Period {
  return periodByIndex(periodIndexOf(date, pay), pay, today);
}

export function paydaysBetween(from: ISODate, to: ISODate, pay: PaySchedule): ISODate[] {
  const out: ISODate[] = [];
  const first = Math.ceil(diffDays(from, pay.anchor) / pay.intervalDays);
  for (let k = first; ; k++) {
    const d = addDays(pay.anchor, k * pay.intervalDays);
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------------

/**
 * Raw occurrences in [from, to] (inclusive), ignoring startDate/endDate.
 * Cycle math (spread/reserve) needs the unbounded series; callers bound it themselves.
 */
export function rawOccurrences(
  spec: RecurrenceSpec,
  pay: PaySchedule | null,
  from: ISODate,
  to: ISODate,
): ISODate[] {
  if (from > to) return [];
  switch (spec.cadence) {
    case 'paycheck':
      return pay ? paydaysBetween(from, to, pay) : [];
    case 'weekly':
      return stepped(spec.anchorDate ?? spec.startDate, 7, from, to);
    case 'biweekly':
      return stepped(spec.anchorDate ?? spec.startDate, 14, from, to);
    case 'monthly':
      return monthly(spec, from, to, [spec.dayOfMonth ?? 1]);
    case 'semimonthly':
      return monthly({ ...spec, intervalMonths: 1 }, from, to, [
        spec.dayOfMonth ?? 1,
        spec.dayOfMonth2 ?? 15,
      ]);
    case 'yearly':
      return yearly(spec.anchorDate ?? spec.startDate, from, to);
    case 'once': {
      const d = spec.anchorDate;
      return d && d >= from && d <= to ? [d] : [];
    }
    default: {
      const never: never = spec.cadence;
      throw new Error(`Unknown cadence ${String(never)}`);
    }
  }
}

/** Occurrences in [from, to], bounded by the line's startDate/endDate. */
export function occurrences(
  spec: RecurrenceSpec,
  pay: PaySchedule | null,
  from: ISODate,
  to: ISODate,
): ISODate[] {
  const lo = spec.startDate && spec.startDate > from ? spec.startDate : from;
  const hi = spec.endDate && spec.endDate < to ? spec.endDate : to;
  return rawOccurrences(spec, pay, lo, hi);
}

/**
 * Applies manual occurrence reschedules on top of a natural occurrence list: a moved-away date
 * drops out, and a moved-in date appears if its target falls in [from, to] — regardless of
 * whether the natural series would ever land there. Only meaningful for `due` lines.
 */
export function applyMoves(
  dates: ISODate[],
  moves: { fromDate: ISODate; toDate: ISODate }[],
  from: ISODate,
  to: ISODate,
): ISODate[] {
  if (moves.length === 0) return dates;
  const out = new Set(dates);
  for (const m of moves) out.delete(m.fromDate);
  for (const m of moves) if (m.toDate >= from && m.toDate <= to) out.add(m.toDate);
  return [...out].sort();
}

function stepped(anchor: ISODate | null, step: number, from: ISODate, to: ISODate): ISODate[] {
  if (!anchor) return [];
  const out: ISODate[] = [];
  const a = toDayNum(anchor);
  const first = Math.ceil((toDayNum(from) - a) / step);
  const last = toDayNum(to);
  for (let k = first; a + k * step <= last; k++) out.push(fromDayNum(a + k * step));
  return out;
}

function monthly(spec: RecurrenceSpec, from: ISODate, to: ISODate, days: number[]): ISODate[] {
  const interval = Math.max(1, spec.intervalMonths || 1);
  const alignDate = spec.anchorDate ?? spec.startDate;
  const align = alignDate ? parts(alignDate) : null;
  const alignIdx = align ? align.y * 12 + (align.m - 1) : 0;
  const f = parts(from);
  const t = parts(to);
  const out: ISODate[] = [];
  for (let idx = f.y * 12 + (f.m - 1); idx <= t.y * 12 + (t.m - 1); idx++) {
    if (interval > 1 && (((idx - alignIdx) % interval) + interval) % interval !== 0) continue;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    const seen = new Set<string>();
    for (const day of days) {
      const d = makeDate(y, m, Math.min(day, daysInMonth(y, m)));
      if (!seen.has(d) && d >= from && d <= to) {
        seen.add(d);
        out.push(d);
      }
    }
  }
  return out.sort();
}

function yearly(anchor: ISODate | null, from: ISODate, to: ISODate): ISODate[] {
  if (!anchor) return [];
  const a = parts(anchor);
  const out: ISODate[] = [];
  for (let y = parts(from).y; y <= parts(to).y; y++) {
    const d = makeDate(y, a.m, a.d);
    if (d >= from && d <= to) out.push(d);
  }
  return out;
}

/** Rough "how often per year" for display (e.g. showing a per-paycheck equivalent). */
export function timesPerYear(cadence: Cadence, intervalMonths: number, payIntervalDays: number): number {
  switch (cadence) {
    case 'paycheck':
      return 365.25 / payIntervalDays;
    case 'weekly':
      return 365.25 / 7;
    case 'biweekly':
      return 365.25 / 14;
    case 'semimonthly':
      return 24;
    case 'monthly':
      return 12 / Math.max(1, intervalMonths || 1);
    case 'yearly':
      return 1;
    case 'once':
      return 0;
  }
}
