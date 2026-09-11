// Request validation. Deliberately no `.default()` anywhere: defaults on a schema that's
// reused for partial updates silently overwrite columns the client never sent.
// Create paths fill defaults explicitly in code instead.

import { z } from 'zod';
import { isISODate, isValidTimeZone } from '../shared/dates';
import { isValidRegex } from './rules';

const isoDate = z.string().refine(isISODate, 'Use a real date in YYYY-MM-DD form');
const cents = z.number().int().min(0).max(10_000_000_00);
const signedCents = z.number().int().min(-10_000_000_00).max(10_000_000_00);

export const itemSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['income', 'expense']),
    group: z.string().trim().max(40),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable(),
    amountCents: cents,
    cadence: z.enum(['paycheck', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'yearly', 'once']),
    anchorDate: isoDate.nullable(),
    dayOfMonth: z.number().int().min(1).max(31).nullable(),
    dayOfMonth2: z.number().int().min(1).max(31).nullable(),
    intervalMonths: z.number().int().min(1).max(24),
    startDate: isoDate.nullable(),
    endDate: isoDate.nullable(),
    allocation: z.enum(['due', 'spread', 'reserve']),
    toleranceDays: z.number().int().min(0).max(31),
    reserveOpeningCents: cents,
    notes: z.string().max(2000),
    sort: z.number().int(),
    ownerId: z.number().int().nullable(),
    reserveId: z.number().int().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.reserveId != null && (v.kind === 'income' || v.allocation === 'spread')) {
      ctx.addIssue({
        code: 'custom',
        path: ['reserveId'],
        message: 'Only fund lines and on-date expense lines can feed a reserve',
      });
    }
    const need = (field: 'anchorDate' | 'dayOfMonth' | 'dayOfMonth2', why: string) => {
      if (v[field] == null) ctx.addIssue({ code: 'custom', path: [field], message: why });
    };
    if (['weekly', 'biweekly', 'yearly', 'once'].includes(v.cadence)) need('anchorDate', 'Pick a date this falls on');
    if (v.cadence === 'monthly') need('dayOfMonth', 'Pick a day of the month');
    if (v.cadence === 'semimonthly') {
      need('dayOfMonth', 'Pick the first day of the month');
      need('dayOfMonth2', 'Pick the second day of the month');
    }
    if (v.startDate && v.endDate && v.endDate < v.startDate) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date is before start date' });
    }
    if (v.kind === 'income' && v.allocation !== 'due') {
      ctx.addIssue({ code: 'custom', path: ['allocation'], message: 'Income always lands on its date' });
    }
  });

export const settingsSchema = z.object({
  payAnchor: isoDate.nullable(),
  payIntervalDays: z.number().int().min(7).max(31),
  timezone: z.string().refine(isValidTimeZone, 'Unknown time zone'),
  currency: z.string().regex(/^[A-Z]{3}$/),
  syncIntervalHours: z.number().int().min(2).max(24),
  backfillDays: z.number().int().min(1).max(366),
});

export const personSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  sharePct: z.number().min(0).max(100),
  payAnchor: isoDate.nullable(),
  payIntervalDays: z.number().int().min(7).max(31).nullable(),
  sort: z.number().int(),
});

export const reserveSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  ownerId: z.number().int().nullable(),
  accountId: z.string().nullable(),
  targetCents: cents.nullable(),
  openingCents: cents,
  openingDate: isoDate,
  notes: z.string().max(2000),
  sort: z.number().int(),
});

export const accountPatchSchema = z.object({
  ownerId: z.number().int().nullable().optional(),
  inBudget: z.boolean().optional(),
  nickname: z.string().trim().max(60).nullable().optional(),
});

export const accountCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  ownerId: z.number().int().nullable(),
  inBudget: z.boolean(),
});

export const accountBalanceSchema = z.object({
  date: isoDate,
  balanceCents: signedCents,
});

export const txnPatchSchema = z.object({
  itemId: z.number().int().nullable().optional(),
  reserveId: z.number().int().nullable().optional(),
  kind: z.enum(['normal', 'transfer', 'ignore']).optional(),
  note: z.string().max(500).optional(),
  occurrenceDate: isoDate.nullable().optional(),
  /** hand the transaction back to the rules */
  reset: z.boolean().optional(),
});

export const manualTxnSchema = z.object({
  date: isoDate,
  amountCents: signedCents.refine((n) => n !== 0, 'Amount cannot be zero'),
  description: z.string().trim().min(1).max(200),
  itemId: z.number().int().nullable(),
  reserveId: z.number().int().nullable(),
  kind: z.enum(['normal', 'transfer', 'ignore']),
  note: z.string().max(500),
});

export const ruleSchema = z
  .object({
    name: z.string().trim().max(80),
    priority: z.number().int().min(0).max(10000),
    field: z.enum(['any', 'description', 'payee', 'memo']),
    match: z.enum(['contains', 'starts', 'exact', 'regex']),
    pattern: z.string().trim().min(1).max(200),
    accountId: z.string().nullable(),
    direction: z.enum(['any', 'in', 'out']),
    minCents: cents.nullable(),
    maxCents: cents.nullable(),
    itemId: z.number().int().nullable(),
    reserveId: z.number().int().nullable(),
    setKind: z.enum(['normal', 'transfer', 'ignore']),
    enabled: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.match === 'regex' && !isValidRegex(v.pattern)) {
      ctx.addIssue({ code: 'custom', path: ['pattern'], message: 'Not a valid regular expression' });
    }
    if (v.setKind === 'normal' && v.itemId == null && v.reserveId == null) {
      ctx.addIssue({ code: 'custom', path: ['itemId'], message: 'Pick a budget line or reserve, or mark as transfer/ignore' });
    }
    if (v.minCents != null && v.maxCents != null && v.maxCents < v.minCents) {
      ctx.addIssue({ code: 'custom', path: ['maxCents'], message: 'Max is below min' });
    }
  });

export const claimSchema = z.object({ token: z.string().trim().min(10).max(4000) });

export const rangeSchema = z.object({ from: isoDate, to: isoDate }).refine((v) => v.from <= v.to, 'from must be ≤ to');
