// The budget engine. Pure functions over an EngineData source — no I/O of its own,
// so it can be unit-tested with plain arrays.
//
// The headline number for a pay period:
//
//   leftover = income counted − committed − unplanned spending + unplanned income
//
// where each budget line decides what it "commits" (see ExpenseLine rules below), and
// any spending not assigned to a line is unplanned. Transfers and ignored transactions
// never count.

import { addDays, diffDays, eachDay, maxDate, minDate, toDayNum } from '../shared/dates';
import {
  occurrences,
  periodByIndex,
  periodIndexOf,
  rawOccurrences,
  type PaySchedule,
} from '../shared/recurrence';
import type {
  Account,
  Allocation,
  Assessment,
  LensInfo,
  Person,
  Reserve,
  ReserveDetail,
  ReserveSummary,
  CalendarDay,
  CalendarResponse,
  CashCheck,
  ExpenseLine,
  ISODate,
  IncomeLine,
  Item,
  LedgerResponse,
  Period,
  PeriodSummary,
  PlannedEntry,
  Txn,
} from '../shared/types';

export interface EngineData {
  pay: PaySchedule;
  today: ISODate;
  items: Item[];
  accounts: Account[];
  /** Transactions dated in [from, to]. By default only accounts marked "in budget". */
  txnsBetween(from: ISODate, to: ISODate, opts?: { allAccounts?: boolean }): Txn[];
  /** In-budget transactions assigned to one line, dated in [from, to]. */
  txnsForItem(itemId: number, from: ISODate, to: ISODate): Txn[];
  reserves: Reserve[];
  /** In-budget transactions assigned straight to a reserve (not via a line), dated in [from, to]. */
  txnsForReserve(reserveId: number, from: ISODate, to: ISODate): Txn[];
  /** set by applyLens; absent = whole household */
  lens?: LensInfo;
}

/** Days before today an unpaid due line flips from "upcoming" to "overdue" — beyond its tolerance. */
const MAX_TOLERANCE = 31;
/** Occurrence look-around for cycle math. Must exceed the longest cycle (yearly). */
const CYCLE_PAD = 400;

// ---------------------------------------------------------------------------
// Allocation helpers
// ---------------------------------------------------------------------------

/**
 * The allocation the engine actually uses. Income is always `due` (a paycheck lands on a day).
 * A one-time line can only be spread/reserved if it has a start date to spread from.
 */
export function effectiveAllocation(item: Item): Allocation {
  if (item.kind === 'income') return 'due';
  if (item.cadence === 'once' && !item.startDate) return 'due';
  return item.allocation;
}

function tolerance(item: Item): number {
  return Math.min(Math.max(0, item.toleranceDays), MAX_TOLERANCE);
}

/**
 * Which date a transaction "belongs to" for budgeting.
 * - manual override wins
 * - due lines (and income): the nearest due date within ± tolerance. This is what lets a
 *   paycheck that lands a day early, or rent paid on the 30th, still count toward the
 *   right due date — even when that due date is in the neighbouring pay period.
 * - spread/reserve lines: the transaction's own date.
 */
export function effectiveDate(txn: Txn, item: Item | undefined, pay: PaySchedule): ISODate {
  if (txn.occurrenceDate) return txn.occurrenceDate;
  if (!item || effectiveAllocation(item) !== 'due') return txn.date;
  const tol = tolerance(item);
  const candidates = occurrences(item, pay, addDays(txn.date, -tol), addDays(txn.date, tol));
  if (candidates.length === 0) return txn.date;
  let best = candidates[0];
  let bestDist = Math.abs(diffDays(best, txn.date));
  for (const c of candidates.slice(1)) {
    const dist = Math.abs(diffDays(c, txn.date));
    // Ties go to the later date: payments made ahead of time are more common than late ones.
    if (dist <= bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

function fundStart(item: Item): ISODate {
  return item.startDate ?? item.createdAt.slice(0, 10);
}

/**
 * Per-day budget amounts (fractional cents) for a spread or reserve line over [from, to].
 *
 * spread:  day d belongs to the cycle [occurrence ≤ d, next occurrence)   — budget renews on the date
 * reserve: day d belongs to the cycle (previous occurrence, occurrence ≥ d] — you save up *toward* the date
 *
 * Either way the daily rate is amount / cycle length, so a $600/month line gives $19.35/day in
 * a 31-day month and $21.43/day in February, and a year of pay periods sums to exactly 12 × $600
 * (± rounding cents) no matter how many paydays fall in a month.
 */
export function dailyRates(
  item: Item,
  pay: PaySchedule,
  from: ISODate,
  to: ISODate,
  mode: 'spread' | 'reserve',
): number[] {
  const days = diffDays(to, from) + 1;
  if (days <= 0) return [];
  const out = new Array<number>(days).fill(0);
  const lo = item.startDate ?? null;
  const hi = item.endDate ?? null;

  if (item.cadence === 'once') {
    // Spread/save from startDate up to and including the date.
    const start = item.startDate;
    const date = item.anchorDate;
    if (!start || !date || date < start) return out;
    const rate = item.amountCents / (diffDays(date, start) + 1);
    let i = 0;
    for (const d of eachDay(from, to)) {
      if (d >= start && d <= date) out[i] = rate;
      i++;
    }
    return out;
  }

  const occ = rawOccurrences(item, pay, addDays(from, -CYCLE_PAD), addDays(to, CYCLE_PAD)).map(toDayNum);
  if (occ.length < 2) return out;

  let i = 0;
  for (const d of eachDay(from, to)) {
    if ((lo && d < lo) || (hi && d > hi)) {
      i++;
      continue;
    }
    const n = toDayNum(d);
    if (mode === 'spread') {
      const k = lastIndexAtOrBefore(occ, n);
      if (k >= 0 && k + 1 < occ.length) out[i] = item.amountCents / (occ[k + 1] - occ[k]);
    } else {
      const k = firstIndexAtOrAfter(occ, n);
      if (k > 0 && k < occ.length) out[i] = item.amountCents / (occ[k] - occ[k - 1]);
    }
    i++;
  }
  return out;
}

function lastIndexAtOrBefore(sorted: number[], n: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= n) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function firstIndexAtOrAfter(sorted: number[], n: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = sorted.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] >= n) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return ans;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Cash reserves ("pots")
// ---------------------------------------------------------------------------

/**
 * A pot is a pool of set-aside money. Real pots come from the reserves table; a `reserve` line
 * with no reserve picked gets a private pot of its own (so a single sinking fund needs no setup).
 *
 * Money in:  daily shares of `reserve` lines that save into it, payments of `due` contribution
 *            lines (actual once matched; planned amount for future dates), positive transactions
 *            assigned straight to the pot (interest, refunds).
 * Money out: transactions assigned to its `reserve` lines (the bills it exists for), negative
 *            transactions assigned straight to the pot (the car repair paid from the car fund).
 *
 * A pot can't go below zero. An overrun is charged to the pay period it happens in as a
 * shortfall and the pot restarts at zero, so every dollar is counted exactly once.
 */
export interface Pot {
  key: string;
  reserveId: number | null;
  name: string;
  color: string | null;
  accountId: string | null;
  targetCents: number | null;
  openingCents: number;
  openingDate: ISODate;
  saves: Item[];
  contributes: Item[];
}

export function potsFor(data: EngineData): Pot[] {
  const real = new Map(data.reserves.map((r) => [r.id, r]));
  const pots: Pot[] = data.reserves.map((r) => ({
    key: `r:${r.id}`,
    reserveId: r.id,
    name: r.name,
    color: r.color,
    accountId: r.accountId,
    targetCents: r.targetCents,
    openingCents: r.openingCents,
    openingDate: r.openingDate,
    saves: [],
    contributes: [],
  }));
  const byId = new Map(pots.map((p) => [p.reserveId!, p]));
  for (const item of data.items) {
    if (item.kind !== 'expense') continue;
    const alloc = effectiveAllocation(item);
    const pot = item.reserveId != null && real.has(item.reserveId) ? byId.get(item.reserveId)! : null;
    if (alloc === 'reserve') {
      if (pot) pot.saves.push(item);
      else
        pots.push({
          key: `line:${item.id}`,
          reserveId: null,
          name: item.name,
          color: item.color,
          accountId: null,
          targetCents: null,
          openingCents: item.reserveOpeningCents,
          openingDate: fundStart(item),
          saves: [item],
          contributes: [],
        });
    } else if (alloc === 'due' && pot) {
      pot.contributes.push(item);
    }
  }
  return pots;
}

export interface PotSim {
  start: ISODate;
  /** end-of-day balance, index 0 = start */
  balance: number[];
  inflow: number[];
  outflow: number[];
  shortfall: number[];
  shareByItem: Map<number, number[]>;
  spendByItem: Map<number, number[]>;
}

/**
 * `projectBills` (reserves page only): also subtract the planned amount of fund-line bills that
 * haven't happened yet, so the projected balance dips where the bill will land. Period
 * assessments leave it off — an unpaid future bill isn't money gone yet, and the cash check
 * relies on that.
 */
export function simulatePot(pot: Pot, data: EngineData, until: ISODate, projectBills = false): PotSim {
  const start = pot.openingDate;
  const n = Math.max(0, diffDays(until, start) + 1);
  const sim: PotSim = {
    start,
    balance: new Array(n).fill(0),
    inflow: new Array(n).fill(0),
    outflow: new Array(n).fill(0),
    shortfall: new Array(n).fill(0),
    shareByItem: new Map(),
    spendByItem: new Map(),
  };
  if (n === 0) return sim;
  const idx = (d: ISODate) => diffDays(d, start);
  const inRange = (d: ISODate) => d >= start && d <= until;

  for (const item of pot.saves) {
    const rates = dailyRates(item, data.pay, start, until, 'reserve');
    sim.shareByItem.set(item.id, rates);
    rates.forEach((r, i) => (sim.inflow[i] += r));
    const spend = new Array(n).fill(0);
    for (const t of data.txnsForItem(item.id, start, until)) {
      if (t.kind !== 'normal') continue;
      spend[idx(t.date)] += -t.amountCents;
    }
    if (projectBills) {
      const tol = tolerance(item);
      const paid = data.txnsForItem(item.id, addDays(data.today, -tol), addDays(until, tol)).filter((t) => t.kind === 'normal');
      for (const occ of occurrences(item, data.pay, addDays(data.today, 1), until)) {
        if (occ < start) continue;
        if (paid.some((t) => Math.abs(diffDays(t.date, occ)) <= tol)) continue;
        spend[idx(occ)] += item.amountCents;
      }
    }
    sim.spendByItem.set(item.id, spend);
    spend.forEach((v, i) => (sim.outflow[i] += v));
  }

  for (const item of pot.contributes) {
    const tol = tolerance(item);
    for (const occ of occurrences(item, data.pay, start, until)) {
      const matched = data
        .txnsForItem(item.id, addDays(occ, -tol), addDays(occ, tol))
        .filter((t) => t.kind === 'normal' && effectiveDate(t, item, data.pay) === occ);
      if (matched.length) sim.inflow[idx(occ)] += -sum(matched.map((t) => t.amountCents));
      else if (occ > data.today) sim.inflow[idx(occ)] += item.amountCents;
    }
  }

  if (pot.reserveId != null) {
    for (const t of data.txnsForReserve(pot.reserveId, start, until)) {
      if (t.kind !== 'normal' || !inRange(t.date)) continue;
      if (t.amountCents < 0) sim.outflow[idx(t.date)] += -t.amountCents;
      else sim.inflow[idx(t.date)] += t.amountCents;
    }
  }

  let bal = pot.openingCents;
  for (let i = 0; i < n; i++) {
    bal += sim.inflow[i] - sim.outflow[i];
    if (bal < 0) {
      sim.shortfall[i] = -bal;
      bal = 0;
    }
    sim.balance[i] = bal;
  }
  return sim;
}

/** Sum of a daily series over [from, to], clipped to the simulation window. */
function sumOver(sim: PotSim, series: number[], from: ISODate, to: ISODate): number {
  let total = 0;
  const lo = Math.max(0, diffDays(from, sim.start));
  const hi = Math.min(series.length - 1, diffDays(to, sim.start));
  for (let i = lo; i <= hi; i++) total += series[i];
  return total;
}

function balanceAt(sim: PotSim, pot: Pot, date: ISODate): number {
  const i = diffDays(date, sim.start);
  if (i < 0) return date < pot.openingDate ? 0 : pot.openingCents;
  return sim.balance[Math.min(i, sim.balance.length - 1)] ?? pot.openingCents;
}

function heldInBudget(pot: Pot, accounts: Account[]): boolean {
  if (!pot.accountId) return true;
  const a = accounts.find((x) => x.id === pot.accountId);
  return a ? a.inBudget : true;
}

// ---------------------------------------------------------------------------
// Period assessment
// ---------------------------------------------------------------------------

export function assessPeriod(data: EngineData, period: Period): Assessment {
  const { pay, today } = data;
  const itemsById = new Map(data.items.map((i) => [i.id, i]));
  const maxTol = Math.max(7, ...data.items.map(tolerance));
  const window = data.txnsBetween(addDays(period.start, -maxTol), addDays(period.end, maxTol));
  const inP = (d: ISODate) => d >= period.start && d <= period.end;
  const reserveIds = new Set(data.reserves.map((r) => r.id));

  // Cash reserves first: reserve lines read their share and balance from their pot.
  const pots = potsFor(data);
  const potOfItem = new Map<number, { pot: Pot; sim: PotSim }>();
  const reserves: ReserveSummary[] = [];
  let shortfallTotal = 0;
  for (const pot of pots) {
    const sim = simulatePot(pot, data, period.end);
    for (const i of pot.saves) potOfItem.set(i.id, { pot, sim });
    const summary: ReserveSummary = {
      key: pot.key,
      reserveId: pot.reserveId,
      name: pot.name,
      color: pot.color,
      accountId: pot.accountId,
      targetCents: pot.targetCents,
      startCents: Math.round(balanceAt(sim, pot, addDays(period.start, -1))),
      inCents: Math.round(sumOver(sim, sim.inflow, period.start, period.end)),
      outCents: Math.round(sumOver(sim, sim.outflow, period.start, period.end)),
      shortfallCents: Math.round(sumOver(sim, sim.shortfall, period.start, period.end)),
      endCents: Math.round(balanceAt(sim, pot, period.end)),
      heldInBudget: heldInBudget(pot, data.accounts),
    };
    shortfallTotal += summary.shortfallCents;
    if (pot.reserveId != null || summary.endCents || summary.inCents || summary.outCents) reserves.push(summary);
  }

  // Attribute every assigned, counting transaction to an effective date.
  const effective = new Map<string, ISODate>();
  for (const t of window) {
    const item = t.itemId != null ? itemsById.get(t.itemId) : undefined;
    effective.set(t.id, effectiveDate(t, item, pay));
  }

  const byItem = new Map<number, Txn[]>();
  const unplannedTxns: Txn[] = [];
  for (const t of window) {
    if (t.kind !== 'normal') continue;
    const item = t.itemId != null ? itemsById.get(t.itemId) : undefined;
    if (!item) {
      // Paid from (or into) a cash reserve: the pot handles it, not this period.
      if (t.reserveId != null && reserveIds.has(t.reserveId)) continue;
      if (inP(t.date)) unplannedTxns.push(t);
      continue;
    }
    const list = byItem.get(item.id) ?? [];
    list.push(t);
    byItem.set(item.id, list);
  }

  const income: IncomeLine[] = [];
  const expenses: ExpenseLine[] = [];

  for (const item of data.items) {
    const txns = byItem.get(item.id) ?? [];
    const alloc = effectiveAllocation(item);

    if (alloc === 'due') {
      const occ = occurrences(item, pay, period.start, period.end);
      const occSet = new Set(occ);
      for (const date of occ) {
        const matched = txns.filter((t) => effective.get(t.id) === date);
        const signed = sum(matched.map((t) => t.amountCents));
        const overdue = addDays(date, tolerance(item)) < today;
        if (item.kind === 'income') {
          const received = matched.length > 0;
          income.push({
            ...lineBase(item, `${item.id}:${date}`),
            date,
            expectedCents: item.amountCents,
            actualCents: signed,
            countedCents: received ? signed : overdue ? 0 : item.amountCents,
            status: received ? 'received' : overdue ? 'late' : 'expected',
            txnIds: matched.map((t) => t.id),
          });
        } else {
          const paid = matched.length > 0;
          expenses.push({
            ...lineBase(item, `${item.id}:${date}`),
            allocation: 'due',
            date,
            budgetCents: item.amountCents,
            actualCents: -signed,
            committedCents: paid ? -signed : item.amountCents,
            remainingCents: paid ? 0 : item.amountCents,
            status: paid ? 'paid' : overdue ? 'overdue' : 'upcoming',
            txnIds: matched.map((t) => t.id),
            fundBalanceCents: null,
            reserveKey: null,
          });
        }
      }
      // Assigned to this line, landing in this period, but not near any due date.
      const extra = txns.filter((t) => {
        const eff = effective.get(t.id)!;
        return inP(eff) && !occSet.has(eff);
      });
      if (extra.length) {
        const signed = sum(extra.map((t) => t.amountCents));
        if (item.kind === 'income') {
          income.push({
            ...lineBase(item, `${item.id}:extra`),
            date: null,
            expectedCents: 0,
            actualCents: signed,
            countedCents: signed,
            status: 'extra',
            txnIds: extra.map((t) => t.id),
          });
        } else {
          expenses.push({
            ...lineBase(item, `${item.id}:extra`),
            allocation: 'due',
            date: null,
            budgetCents: 0,
            actualCents: -signed,
            committedCents: -signed,
            remainingCents: 0,
            status: 'extra',
            txnIds: extra.map((t) => t.id),
            fundBalanceCents: null,
            reserveKey: null,
          });
        }
      }
      continue;
    }

    const inPeriod = txns.filter((t) => inP(t.date));
    const actual = -sum(inPeriod.map((t) => t.amountCents));

    if (alloc === 'spread') {
      const budget = Math.round(sum(dailyRates(item, pay, period.start, period.end, 'spread')));
      if (budget === 0 && inPeriod.length === 0) continue;
      const closed = period.status === 'past';
      expenses.push({
        ...lineBase(item, `${item.id}:spread`),
        allocation: 'spread',
        date: null,
        budgetCents: budget,
        actualCents: actual,
        // While the period is open, unspent envelope money is still spoken for.
        // Once it closes, only what was really spent counts.
        committedCents: closed ? actual : Math.max(budget, actual),
        remainingCents: closed ? 0 : Math.max(budget - actual, 0),
        status: closed ? 'closed' : 'open',
        txnIds: inPeriod.map((t) => t.id),
        fundBalanceCents: null,
        reserveKey: null,
      });
      continue;
    }

    // reserve: this period sets aside its share; bills are paid from the pot (see pots above)
    const link = potOfItem.get(item.id);
    if (!link) continue;
    const share = Math.round(sumOver(link.sim, link.sim.shareByItem.get(item.id) ?? [], period.start, period.end));
    if (share === 0 && inPeriod.length === 0) continue;
    expenses.push({
      ...lineBase(item, `${item.id}:reserve`),
      allocation: 'reserve',
      date: null,
      budgetCents: share,
      actualCents: actual,
      committedCents: share,
      remainingCents: 0,
      status: 'funding',
      txnIds: inPeriod.map((t) => t.id),
      fundBalanceCents: Math.round(balanceAt(link.sim, link.pot, period.end)),
      reserveKey: link.pot.key,
    });
  }

  income.sort(byDateThenName);
  expenses.sort(byDateThenName);

  let unplannedSpend = 0;
  let unplannedIncome = 0;
  for (const t of unplannedTxns) {
    if (t.amountCents < 0) unplannedSpend += -t.amountCents;
    else unplannedIncome += t.amountCents;
  }

  const incomeExpected = sum(income.map((l) => l.expectedCents));
  const incomeCounted = sum(income.map((l) => l.countedCents));
  const budgeted = sum(expenses.map((l) => l.budgetCents));
  const committed = sum(expenses.map((l) => l.committedCents));
  const spent = sum(expenses.map((l) => l.actualCents)) + unplannedSpend;

  const transactions = window.filter((t) => inP(t.date) || inP(effective.get(t.id) ?? t.date));

  return {
    period,
    today,
    income,
    expenses,
    unplanned: {
      spendCents: unplannedSpend,
      incomeCents: unplannedIncome,
      txnIds: unplannedTxns.map((t) => t.id),
    },
    uncategorizedCount: unplannedTxns.length,
    totals: {
      incomeExpectedCents: incomeExpected,
      incomeCountedCents: incomeCounted,
      budgetedCents: budgeted,
      committedCents: committed,
      spentCents: spent,
      unplannedSpendCents: unplannedSpend,
      unplannedIncomeCents: unplannedIncome,
      reserveShortfallCents: shortfallTotal,
      leftoverCents: incomeCounted + unplannedIncome - committed - unplannedSpend - shortfallTotal,
      planLeftoverCents: incomeExpected - budgeted,
    },
    cash: period.status === 'current' ? cashCheck(data.accounts, income, expenses, reserves) : null,
    reserves,
    transactions,
    lens: data.lens ?? { personId: null, name: 'Household', sharePct: null, pay: data.pay },
  };
}

/**
 * Reality check against bank balances: what's in the budget accounts right now, plus paychecks
 * still expected this period, minus everything still owed this period and money parked in funds.
 * Only as accurate as "all budget money lives in accounts marked In budget".
 */
function cashCheck(
  accounts: Account[],
  income: IncomeLine[],
  expenses: ExpenseLine[],
  reserves: ReserveSummary[],
): CashCheck | null {
  // A manual account counts too, as long as it has a hand-entered balance (the ad hoc
  // "Cash & manual entries" bucket never gets one, so it stays excluded on its own).
  const counted = accounts.filter((a) => a.inBudget && a.balanceCents != null);
  if (counted.length === 0) return null;
  const balance = sum(counted.map((a) => a.balanceCents!));
  const upcomingIncome = sum(income.filter((l) => l.status === 'expected').map((l) => l.expectedCents));
  const remaining = sum(
    expenses
      .filter((l) => l.allocation !== 'reserve')
      .map((l) => (l.status === 'upcoming' || l.status === 'overdue' || l.status === 'open' ? l.remainingCents : 0)),
  );
  // Only money that physically sits in the in-budget accounts has to be held back from them.
  const reserveHeld = sum(reserves.filter((r) => r.heldInBudget).map((r) => Math.max(0, r.endCents)));
  const dates = counted.map((a) => a.balanceDate).filter((d): d is number => d != null);
  return {
    balanceCents: balance,
    upcomingIncomeCents: upcomingIncome,
    remainingCents: remaining,
    reserveHeldCents: reserveHeld,
    freeCents: balance + upcomingIncome - remaining - reserveHeld,
    accountCount: counted.length,
    asOf: dates.length ? Math.min(...dates) : null,
  };
}

function lineBase(item: Item, key: string) {
  return { key, itemId: item.id, name: item.name, group: item.group, color: item.color };
}

function byDateThenName(a: { date: ISODate | null; name: string }, b: { date: ISODate | null; name: string }) {
  if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.date && !b.date) return -1;
  if (!a.date && b.date) return 1;
  return a.name.localeCompare(b.name);
}

// ---------------------------------------------------------------------------
// Multi-period views
// ---------------------------------------------------------------------------

export function periodsOverlapping(data: EngineData, from: ISODate, to: ISODate): Period[] {
  const out: Period[] = [];
  for (let i = periodIndexOf(from, data.pay); i <= periodIndexOf(to, data.pay); i++) {
    out.push(periodByIndex(i, data.pay, data.today));
  }
  return out;
}

function summarize(a: Assessment): PeriodSummary {
  const env = a.expenses.filter((l) => l.allocation === 'spread');
  return {
    period: a.period,
    leftoverCents: a.totals.leftoverCents,
    planLeftoverCents: a.totals.planLeftoverCents,
    envelopeBudgetCents: sum(env.map((l) => l.budgetCents)),
    envelopeSpentCents: sum(env.map((l) => l.actualCents)),
  };
}

function plannedFrom(a: Assessment, kindOf: (itemId: number) => 'income' | 'expense'): PlannedEntry[] {
  const out: PlannedEntry[] = [];
  for (const l of a.income) {
    if (!l.date) continue;
    out.push({
      key: l.key,
      itemId: l.itemId,
      name: l.name,
      kind: 'income',
      color: l.color,
      date: l.date,
      amountCents: l.status === 'received' ? l.actualCents : l.expectedCents,
      status: l.status,
    });
  }
  for (const l of a.expenses) {
    if (!l.date || l.allocation !== 'due') continue;
    out.push({
      key: l.key,
      itemId: l.itemId,
      name: l.name,
      kind: kindOf(l.itemId),
      color: l.color,
      date: l.date,
      amountCents: l.status === 'paid' ? l.actualCents : l.budgetCents,
      status: l.status,
    });
  }
  return out;
}

export function buildCalendar(data: EngineData, from: ISODate, to: ISODate): CalendarResponse {
  const kinds = new Map(data.items.map((i) => [i.id, i.kind]));
  const assessments = periodsOverlapping(data, from, to).map((p) => assessPeriod(data, p));
  const planned = assessments
    .flatMap((a) => plannedFrom(a, (id) => kinds.get(id) ?? 'expense'))
    .filter((p) => p.date >= from && p.date <= to);
  const txns = data.txnsBetween(from, to);

  const days: CalendarDay[] = [];
  for (const date of eachDay(from, to)) {
    const idx = periodIndexOf(date, data.pay);
    const dayTxns = txns.filter((t) => t.date === date);
    days.push({
      date,
      periodIndex: idx,
      payday: periodByIndex(idx, data.pay, data.today).start === date,
      planned: planned.filter((p) => p.date === date),
      txns: dayTxns,
      netCents: sum(dayTxns.filter((t) => t.kind === 'normal').map((t) => t.amountCents)),
    });
  }
  return { from, to, today: data.today, days, periods: assessments.map(summarize) };
}

export function buildLedger(data: EngineData, from: ISODate, to: ISODate): LedgerResponse {
  const kinds = new Map(data.items.map((i) => [i.id, i.kind]));
  // Only future-facing, still-unmatched plan entries belong in a ledger next to real transactions.
  const open = new Set(['expected', 'late', 'upcoming', 'overdue']);
  const lo = maxDate(from, addDays(data.today, -400));
  const hi = minDate(to, addDays(data.today, 800));
  const planned =
    lo <= hi
      ? periodsOverlapping(data, lo, hi)
          .map((p) => assessPeriod(data, p))
          .flatMap((a) => plannedFrom(a, (id) => kinds.get(id) ?? 'expense'))
          .filter((p) => p.date >= from && p.date <= to && open.has(p.status))
      : [];
  return {
    from,
    to,
    transactions: data.txnsBetween(from, to, { allAccounts: true }),
    planned,
  };
}

// ---------------------------------------------------------------------------
// Reserves page
// ---------------------------------------------------------------------------

export function buildReserveDetails(data: EngineData): ReserveDetail[] {
  const pots = potsFor(data);
  const current = periodIndexOf(data.today, data.pay);
  const ends: ISODate[] = [];
  for (let k = current - 6; k <= current + 6; k++) ends.push(periodByIndex(k, data.pay, data.today).end);
  const until = ends[ends.length - 1];
  const realById = new Map(data.reserves.map((r) => [r.id, r]));
  return pots.map((pot) => {
    const sim = simulatePot(pot, data, until, true);
    const real = pot.reserveId != null ? realById.get(pot.reserveId) : undefined;
    const account = pot.accountId ? data.accounts.find((a) => a.id === pot.accountId) : undefined;
    const base: Reserve = real ?? {
      id: 0,
      name: pot.name,
      color: pot.color,
      ownerId: pot.saves[0]?.ownerId ?? null,
      accountId: null,
      targetCents: null,
      openingCents: pot.openingCents,
      openingDate: pot.openingDate,
      notes: '',
      sort: 1000,
    };
    return {
      ...base,
      key: pot.key,
      virtual: !real,
      balanceTodayCents: Math.round(balanceAt(sim, pot, data.today)),
      history: ends.map((date) => ({
        date,
        balanceCents: Math.round(balanceAt(sim, pot, date)),
        projected: date > data.today,
      })),
      lines: [
        ...pot.saves.map((i) => ({ itemId: i.id, name: i.name, role: 'saves' as const })),
        ...pot.contributes.map((i) => ({ itemId: i.id, name: i.name, role: 'contributes' as const })),
      ],
      accountBalanceCents: account?.balanceCents ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// People: one person's view of the household
// ---------------------------------------------------------------------------

/**
 * Re-expresses the household as one person's share. Weights:
 *   line / reserve / account owned by this person → 100 %
 *   shared (no owner)                            → person's share %
 *   owned by someone else                        → left out
 * A transaction takes the weight of its budget line, else its reserve, else its account —
 * so half of the rent counts for each of two people even when one of them pays it.
 * Amounts are scaled before the engine runs, so every total downstream is already "their share".
 */
export function applyLens(data: EngineData, people: Person[], personId: number | null): EngineData {
  if (personId == null) return data;
  const person = people.find((p) => p.id === personId);
  if (!person) return data;
  const share = person.sharePct / 100;
  const weightOf = (ownerId: number | null) => (ownerId === personId ? 1 : ownerId == null ? share : 0);

  const itemW = new Map(data.items.map((i) => [i.id, weightOf(i.ownerId)]));
  const potW = new Map(data.reserves.map((r) => [r.id, weightOf(r.ownerId)]));
  const acctW = new Map(data.accounts.map((a) => [a.id, weightOf(a.ownerId)]));
  const scale = (c: number, w: number) => Math.round(c * w);

  const txnWeight = (t: Txn) => {
    if (t.itemId != null && itemW.has(t.itemId)) return itemW.get(t.itemId)!;
    if (t.reserveId != null && potW.has(t.reserveId)) return potW.get(t.reserveId)!;
    return acctW.get(t.accountId) ?? share;
  };
  const scaleTxns = (list: Txn[]) =>
    list.flatMap((t) => {
      const w = txnWeight(t);
      if (w === 0) return [];
      return [w === 1 ? t : { ...t, amountCents: scale(t.amountCents, w), fullAmountCents: t.amountCents }];
    });

  const pay =
    person.payAnchor && person.payIntervalDays
      ? { anchor: person.payAnchor, intervalDays: person.payIntervalDays }
      : data.pay;

  return {
    ...data,
    pay,
    items: data.items
      .filter((i) => itemW.get(i.id)! > 0)
      .map((i) => {
        const w = itemW.get(i.id)!;
        return w === 1 ? i : { ...i, amountCents: scale(i.amountCents, w), reserveOpeningCents: scale(i.reserveOpeningCents, w) };
      }),
    reserves: data.reserves
      .filter((r) => potW.get(r.id)! > 0)
      .map((r) => {
        const w = potW.get(r.id)!;
        return w === 1
          ? r
          : { ...r, openingCents: scale(r.openingCents, w), targetCents: r.targetCents == null ? null : scale(r.targetCents, w) };
      }),
    accounts: data.accounts
      .filter((a) => acctW.get(a.id)! > 0)
      .map((a) => {
        const w = acctW.get(a.id)!;
        return w === 1
          ? a
          : {
              ...a,
              balanceCents: a.balanceCents == null ? null : scale(a.balanceCents, w),
              availableCents: a.availableCents == null ? null : scale(a.availableCents, w),
            };
      }),
    txnsBetween: (f, t, o) => scaleTxns(data.txnsBetween(f, t, o)),
    txnsForItem: (id, f, t) => (itemW.get(id) ? scaleTxns(data.txnsForItem(id, f, t)) : []),
    txnsForReserve: (id, f, t) => (potW.get(id) ? scaleTxns(data.txnsForReserve(id, f, t)) : []),
    lens: { personId, name: person.name, sharePct: person.sharePct, pay },
  };
}
