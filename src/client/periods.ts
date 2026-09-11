import { addDays } from '../shared/dates';
import { periodOf, type PaySchedule } from '../shared/recurrence';
import type { ISODate, Person } from '../shared/types';

export function periodFor(date: ISODate, pay: PaySchedule, today: ISODate) {
  return periodOf(date, pay, today);
}

export function shiftPeriod(date: ISODate, pay: PaySchedule, by: number): ISODate {
  const p = periodOf(date, pay, date);
  return addDays(p.start, by * pay.intervalDays);
}

export function personName(people: Person[], id: number | null): string {
  if (id == null) return 'Shared';
  return people.find((p) => p.id === id)?.name ?? 'Shared';
}
