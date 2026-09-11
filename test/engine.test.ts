import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyLens, assessPeriod, dailyRates, effectiveDate, type EngineData } from '../src/server/engine';
import { occurrences, periodOf, type PaySchedule } from '../src/shared/recurrence';
import { parseCents } from '../src/shared/money';
import { dayOfWeek } from '../src/shared/dates';
import type { Account, Item, OccurrenceMove, Person, Reserve, Txn } from '../src/shared/types';

const pay: PaySchedule = { anchor: '2026-09-04', intervalDays: 14 }; // a Friday

let nextId = 1;
function item(p: Partial<Item> & Pick<Item, 'name' | 'kind' | 'amountCents' | 'cadence'>): Item {
  return {
    id: nextId++,
    group: '',
    color: null,
    anchorDate: null,
    dayOfMonth: null,
    dayOfMonth2: null,
    intervalMonths: 1,
    startDate: null,
    endDate: null,
    allocation: 'due',
    toleranceDays: 5,
    reserveOpeningCents: 0,
    notes: '',
    sort: 0,
    ownerId: null,
    reserveId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...p,
  };
}

let txnSeq = 1;
function txn(date: string, amountCents: number, itemId: number | null, extra: Partial<Txn> = {}): Txn {
  return {
    id: `t${txnSeq++}`,
    accountId: 'a1',
    date,
    amountCents,
    description: 'x',
    payee: null,
    memo: null,
    pending: false,
    itemId,
    kind: 'normal',
    assignedBy: itemId ? 'manual' : null,
    ruleId: null,
    occurrenceDate: null,
    note: '',
    manual: false,
    reserveId: null,
    ...extra,
  };
}

function data(
  items: Item[],
  txns: Txn[],
  today: string,
  accounts: Account[] = [],
  reserves: Reserve[] = [],
  moves: OccurrenceMove[] = [],
): EngineData {
  return {
    pay,
    today,
    items,
    accounts,
    reserves,
    txnsBetween: (f, t) => txns.filter((x) => x.date >= f && x.date <= t),
    txnsForItem: (id, f, t) => txns.filter((x) => x.itemId === id && x.date >= f && x.date <= t),
    txnsForReserve: (id, f, t) => txns.filter((x) => x.reserveId === id && x.itemId == null && x.date >= f && x.date <= t),
    movesForItem: (id) => moves.filter((m) => m.itemId === id),
  };
}

let moveSeq = 1;
function move(itemId: number, fromDate: string, toDate: string): OccurrenceMove {
  return { id: moveSeq++, itemId, fromDate, toDate, createdAt: '2026-01-01T00:00:00.000Z' };
}

function reserve(p: Partial<Reserve> & Pick<Reserve, 'id' | 'name'>): Reserve {
  return { color: null, ownerId: null, accountId: null, targetCents: null, openingCents: 0, openingDate: '2026-01-01', notes: '', sort: 0, ...p };
}

function account(p: Partial<Account> & Pick<Account, 'id'>): Account {
  return {
    name: p.id, nickname: null, connName: null, currency: 'USD', balanceCents: 0, availableCents: null, balanceDate: null,
    inBudget: true, manual: false, syncedThrough: null, lastError: null, ownerId: null, ...p,
  };
}

describe('dates & money', () => {
  it('knows weekdays', () => {
    assert.equal(dayOfWeek('2026-09-04'), 5); // Friday
    assert.equal(dayOfWeek('1970-01-01'), 4);
  });

  it('parses SimpleFIN amounts without float error', () => {
    assert.equal(parseCents('-33293.43'), -3329343);
    assert.equal(parseCents('0.29'), 29);
    assert.equal(parseCents('12'), 1200);
    assert.equal(parseCents('.5'), 50);
    assert.equal(parseCents('1,234.567'), 123457);
    assert.throws(() => parseCents('abc'));
  });
});

describe('pay periods', () => {
  it('finds the 14-day window containing a date', () => {
    const p = periodOf('2026-09-11', pay, '2026-09-11');
    assert.deepEqual([p.start, p.end, p.status], ['2026-09-04', '2026-09-17', 'current']);
    const before = periodOf('2026-09-03', pay, '2026-09-11');
    assert.deepEqual([before.start, before.end, before.status], ['2026-08-21', '2026-09-03', 'past']);
  });

  it('clamps day 31 to short months', () => {
    const spec = item({ name: 'x', kind: 'expense', amountCents: 1, cadence: 'monthly', dayOfMonth: 31 });
    assert.deepEqual(occurrences(spec, pay, '2027-01-01', '2027-03-31'), ['2027-01-31', '2027-02-28', '2027-03-31']);
  });

  it('supports quarterly via intervalMonths', () => {
    const spec = item({ name: 'q', kind: 'expense', amountCents: 1, cadence: 'monthly', dayOfMonth: 10, intervalMonths: 3, anchorDate: '2026-01-10' });
    assert.deepEqual(occurrences(spec, pay, '2026-01-01', '2026-12-31'), ['2026-01-10', '2026-04-10', '2026-07-10', '2026-10-10']);
  });
});

describe('spread (envelope) lines', () => {
  const groceries = item({ name: 'Groceries', kind: 'expense', amountCents: 60000, cadence: 'monthly', dayOfMonth: 1, allocation: 'spread' });

  it('sums to exactly the yearly total regardless of how paydays fall', () => {
    const year = dailyRates(groceries, pay, '2027-01-01', '2027-12-31', 'spread');
    assert.ok(Math.abs(year.reduce((a, b) => a + b, 0) - 720000) < 0.001);
  });

  it('gives a pay period its daily share', () => {
    const a = assessPeriod(data([groceries], [], '2026-09-10'), periodOf('2026-09-10', pay, '2026-09-10'));
    const line = a.expenses.find((l) => l.itemId === groceries.id)!;
    assert.equal(line.budgetCents, 28000); // 14 September days × $600/30
    assert.equal(line.committedCents, 28000); // nothing spent yet: still spoken for
  });

  it('commits the larger of budget and actual while open, actual once closed', () => {
    const txns = [txn('2026-09-05', -31000, groceries.id)];
    const open = assessPeriod(data([groceries], txns, '2026-09-10'), periodOf('2026-09-10', pay, '2026-09-10'));
    assert.equal(open.expenses[0].committedCents, 31000);
    const closed = assessPeriod(data([groceries], txns, '2026-10-01'), periodOf('2026-09-10', pay, '2026-10-01'));
    assert.equal(closed.expenses[0].status, 'closed');
    assert.equal(closed.expenses[0].committedCents, 31000);
  });
});

describe('due lines and attribution', () => {
  const paycheck = item({ name: 'Paycheck', kind: 'income', amountCents: 215000, cadence: 'paycheck' });
  // startDate keeps the line's very first due date at Oct 1 — otherwise it would already owe an
  // unpaid Sep 1 (this fixture supplies no transactions), which would legitimately carry forward.
  const rent = item({ name: 'Rent', kind: 'expense', amountCents: 140000, cadence: 'monthly', dayOfMonth: 1, startDate: '2026-09-02' });

  it('puts a monthly bill only in the period containing its due date', () => {
    const d = data([rent], [], '2026-09-10');
    const hasRent = (date: string) => assessPeriod(d, periodOf(date, pay, '2026-09-10')).expenses.length > 0;
    assert.equal(hasRent('2026-09-10'), false); // Sep 4–17
    assert.equal(hasRent('2026-09-20'), true); // Sep 18–Oct 1 contains Oct 1
  });

  it('attributes an early deposit to the payday it belongs to, across a period boundary', () => {
    const early = txn('2026-09-03', 214812, paycheck.id); // lands in the previous period by date
    assert.equal(effectiveDate(early, paycheck, pay), '2026-09-04');
    const a = assessPeriod(data([paycheck], [early], '2026-09-10'), periodOf('2026-09-10', pay, '2026-09-10'));
    assert.equal(a.income[0].status, 'received');
    assert.equal(a.income[0].countedCents, 214812);
    const prev = assessPeriod(data([paycheck], [early], '2026-09-10'), periodOf('2026-09-01', pay, '2026-09-10'));
    assert.equal(prev.income.find((l) => l.date === '2026-09-04'), undefined);
  });

  it('rent paid on the 30th counts for the 1st', () => {
    const paid = txn('2026-09-30', -140000, rent.id);
    assert.equal(effectiveDate(paid, rent, pay), '2026-10-01');
  });

  it('computes the leftover from counted income, commitments, and unplanned spending', () => {
    const phone = item({ name: 'Phone', kind: 'expense', amountCents: 5500, cadence: 'monthly', dayOfMonth: 10, startDate: '2026-09-01' });
    const txns = [
      txn('2026-09-04', 215000, paycheck.id),
      txn('2026-09-09', -5200, phone.id), // bill came in $3 lower
      txn('2026-09-06', -1850, null), // coffee + snack, not budgeted
      txn('2026-09-07', -9999, null, { kind: 'transfer' }), // never counts
    ];
    const a = assessPeriod(data([paycheck, phone], txns, '2026-09-10'), periodOf('2026-09-10', pay, '2026-09-10'));
    assert.equal(a.totals.incomeCountedCents, 215000);
    assert.equal(a.totals.committedCents, 5200);
    assert.equal(a.totals.unplannedSpendCents, 1850);
    assert.equal(a.totals.leftoverCents, 215000 - 5200 - 1850);
    assert.equal(a.uncategorizedCount, 1);
    assert.equal(a.totals.planLeftoverCents, 215000 - 5500);
  });

  it('treats a missing paycheck as late (counted 0) once past tolerance', () => {
    const a = assessPeriod(data([paycheck], [], '2026-09-12'), periodOf('2026-09-12', pay, '2026-09-12'));
    assert.equal(a.income[0].status, 'late');
    assert.equal(a.income[0].countedCents, 0);
  });
});

describe('moving a due occurrence', () => {
  const phone = item({ name: 'Phone', kind: 'expense', amountCents: 5500, cadence: 'monthly', dayOfMonth: 10, startDate: '2026-09-01' });

  it('stays visible, deferred and uncommitted, in its natural period, and lands as the real obligation in the target period', () => {
    const moves = [move(phone.id, '2026-09-10', '2026-09-18')];
    const origin = assessPeriod(data([phone], [], '2026-09-05', [], [], moves), periodOf('2026-09-05', pay, '2026-09-05'));
    assert.equal(origin.expenses.length, 1); // still shown here — just marked deferred
    assert.equal(origin.expenses[0].date, '2026-09-10');
    assert.equal(origin.expenses[0].status, 'deferred');
    assert.equal(origin.expenses[0].movedTo, '2026-09-18');
    assert.equal(origin.expenses[0].committedCents, 0); // no longer counts against this period

    const target = assessPeriod(data([phone], [], '2026-09-05', [], [], moves), periodOf('2026-09-20', pay, '2026-09-05'));
    assert.equal(target.expenses.length, 1);
    assert.equal(target.expenses[0].date, '2026-09-18');
    assert.equal(target.expenses[0].movedFrom, '2026-09-10');
    assert.equal(target.expenses[0].status, 'upcoming');
    assert.equal(target.expenses[0].committedCents, 5500); // the real obligation now lives here
  });

  it('paying the original bill anyway clears the deferral and counts as paid', () => {
    const moves = [move(phone.id, '2026-09-10', '2026-09-18')];
    const paidAnyway = txn('2026-09-10', -5500, phone.id);
    const origin = assessPeriod(data([phone], [paidAnyway], '2026-09-05', [], [], moves), periodOf('2026-09-05', pay, '2026-09-05'));
    assert.equal(origin.expenses[0].status, 'paid');
    assert.equal(origin.expenses[0].committedCents, 5500);
  });

  it('stops matching a payment near the old date, and matches one near the new date instead', () => {
    const moves = [move(phone.id, '2026-09-10', '2026-09-18')];
    const nearOld = txn('2026-09-09', -5500, phone.id);
    assert.equal(effectiveDate(nearOld, phone, pay, moves), '2026-09-09'); // no longer snaps to the 10th
    const nearNew = txn('2026-09-19', -5500, phone.id);
    assert.equal(effectiveDate(nearNew, phone, pay, moves), '2026-09-18');
  });
});

describe('carrying an unpaid obligation forward', () => {
  const cable = item({ name: 'Cable', kind: 'expense', amountCents: 8000, cadence: 'monthly', dayOfMonth: 5, createdAt: '2026-08-25T00:00:00.000Z' });

  it('keeps an unpaid overdue bill committed in every later period until it is paid', () => {
    const checking = account({ id: 'chk', balanceCents: 100000 });
    const today = '2026-09-25';

    const origin = assessPeriod(data([cable], [], today, [checking]), periodOf('2026-09-10', pay, today));
    assert.equal(origin.period.status, 'past');
    assert.equal(origin.expenses.length, 1);
    assert.equal(origin.expenses[0].status, 'overdue');
    assert.equal(origin.expenses[0].carriedOver, false); // it's the bill's own period, not a carry-forward echo

    const next = assessPeriod(data([cable], [], today, [checking]), periodOf('2026-09-20', pay, today));
    assert.equal(next.period.status, 'current');
    assert.equal(next.expenses.length, 1);
    assert.equal(next.expenses[0].date, '2026-09-05');
    assert.equal(next.expenses[0].carriedOver, true);
    assert.equal(next.expenses[0].committedCents, 8000);
    assert.equal(next.totals.committedCents, 8000);
    assert.equal(next.cash!.freeCents, 100000 - 8000);

    // Paid late, well past tolerance, via the same manual occurrenceDate override the app already supports.
    const paidLate = txn('2026-09-24', -8000, cable.id, { occurrenceDate: '2026-09-05' });
    const settled = assessPeriod(data([cable], [paidLate], today, [checking]), periodOf('2026-09-20', pay, today));
    assert.equal(settled.expenses.length, 0);
    assert.equal(settled.cash!.freeCents, 100000);
  });
});

describe('reserve (sinking fund) lines', () => {
  it('charges each period its share, and only an overrun hits the period the bill lands in', () => {
    const insurance = item({
      name: 'Car insurance',
      kind: 'expense',
      amountCents: 54000,
      cadence: 'monthly',
      dayOfMonth: 15,
      intervalMonths: 6,
      anchorDate: '2026-03-15',
      allocation: 'reserve',
      startDate: '2026-03-16',
    });
    // Six-month cycle Mar 16 → Sep 15 (184 days). By Sep 15 the fund holds the full $540.
    const bill = txn('2026-09-15', -56000, insurance.id); // premium went up $20
    const a = assessPeriod(data([insurance], [bill], '2026-09-16'), periodOf('2026-09-16', pay, '2026-09-16'));
    const line = a.expenses[0];
    assert.equal(line.allocation, 'reserve');
    const pot = a.reserves.find((r) => r.key === line.reserveKey)!;
    assert.ok(Math.abs(pot.shortfallCents - 2000) <= 1, `shortfall ${pot.shortfallCents}`);
    assert.equal(a.totals.reserveShortfallCents, pot.shortfallCents);
    assert.ok(line.committedCents < 7000, 'period pays its share, not the whole bill');
    assert.equal(a.totals.leftoverCents, -(line.committedCents + pot.shortfallCents));
  });

  it('pools several lines into one named reserve, with contributions and direct withdrawals', () => {
    const car = reserve({ id: 1, name: 'Car', openingCents: 50000, openingDate: '2026-09-01' });
    const repairs = item({ name: 'Car upkeep', kind: 'expense', amountCents: 14000, cadence: 'paycheck', allocation: 'reserve', reserveId: 1, startDate: '2026-09-01' });
    const topUp = item({ name: 'Extra to car fund', kind: 'expense', amountCents: 5000, cadence: 'monthly', dayOfMonth: 10, reserveId: 1, startDate: '2026-09-01' });
    const txns = [
      txn('2026-09-10', -5000, topUp.id), // contribution paid
      txn('2026-09-12', -62000, null, { reserveId: 1 }), // tires, paid straight from the reserve
    ];
    const a = assessPeriod(data([repairs, topUp], txns, '2026-09-13', [], [car]), periodOf('2026-09-13', pay, '2026-09-13'));
    const pot = a.reserves.find((r) => r.reserveId === 1)!;
    // Opening $500 + 3 days of Sep 1–3 shares before this period.
    assert.equal(pot.startCents, 50000 + 3000);
    // The tire purchase is not unplanned spending — the reserve paid for it.
    assert.equal(a.totals.unplannedSpendCents, 0);
    assert.equal(a.uncategorizedCount, 0);
    // In this period: $140 share + $50 contribution in, $620 out.
    assert.equal(pot.inCents, 14000 + 5000);
    assert.equal(pot.outCents, 62000);
    // 530 + 190 − 620 = 100 left, no shortfall.
    assert.equal(pot.shortfallCents, 0);
    assert.equal(pot.endCents, 10000);
    assert.equal(a.totals.committedCents, 14000 + 5000);
  });

  it('holds back only reserves whose money sits in in-budget accounts', () => {
    const checking = account({ id: 'chk', balanceCents: 100000 });
    const savings = account({ id: 'sav', inBudget: false, balanceCents: 900000 });
    const emergency = reserve({ id: 1, name: 'Emergency', accountId: 'sav', openingCents: 900000 });
    const buffer = reserve({ id: 2, name: 'Buffer', openingCents: 20000 });
    const a = assessPeriod(data([], [], '2026-09-10', [checking, savings], [emergency, buffer]), periodOf('2026-09-10', pay, '2026-09-10'));
    assert.equal(a.cash!.reserveHeldCents, 20000);
    assert.equal(a.cash!.freeCents, 100000 - 20000);
  });

  it('counts a hand-entered account with a logged balance, but not one still empty', () => {
    const checking = account({ id: 'chk', balanceCents: 100000 });
    const handEntered = account({ id: 'manual:hyf', manual: true, balanceCents: 50000, balanceDate: 1234 });
    const cashBucket = account({ id: 'manual:cash', manual: true, balanceCents: null });
    const a = assessPeriod(data([], [], '2026-09-10', [checking, handEntered, cashBucket]), periodOf('2026-09-10', pay, '2026-09-10'));
    assert.equal(a.cash!.accountCount, 2);
    assert.equal(a.cash!.balanceCents, 150000);
  });
});

describe('people', () => {
  const people: Person[] = [
    { id: 1, name: 'Rowan', color: null, sharePct: 60, payAnchor: null, payIntervalDays: null, sort: 0 },
    { id: 2, name: 'Leif', color: null, sharePct: 40, payAnchor: null, payIntervalDays: null, sort: 1 },
  ];
  const rowanPay = item({ name: 'Rowan pay', kind: 'income', amountCents: 200000, cadence: 'paycheck', ownerId: 1 });
  const leifPay = item({ name: 'Leif pay', kind: 'income', amountCents: 150000, cadence: 'paycheck', ownerId: 2 });
  const rent = item({ name: 'Rent', kind: 'expense', amountCents: 100000, cadence: 'monthly', dayOfMonth: 10, startDate: '2026-09-01' });
  const txns = [
    txn('2026-09-04', 200000, rowanPay.id),
    txn('2026-09-04', 150000, leifPay.id),
    txn('2026-09-10', -100000, rent.id, { accountId: 'leif-chk' }), // Leif paid the shared rent
    txn('2026-09-08', -3000, null, { accountId: 'rowan-card' }), // Rowan's own card
    txn('2026-09-08', -2000, null, { accountId: 'joint' }), // joint account
  ];
  const accounts = [
    account({ id: 'rowan-card', ownerId: 1 }),
    account({ id: 'leif-chk', ownerId: 2 }),
    account({ id: 'joint' }),
  ];
  const household = data([rowanPay, leifPay, rent], txns, '2026-09-11', accounts);
  const period = periodOf('2026-09-11', pay, '2026-09-11');

  it('household view counts everything once', () => {
    const a = assessPeriod(household, period);
    assert.equal(a.totals.leftoverCents, 350000 - 100000 - 5000);
  });

  it("a person's view counts their own lines fully and shared lines at their share", () => {
    const rowan = assessPeriod(applyLens(household, people, 1), period);
    // own income, 60 % of rent (even though Leif paid it), own card fully, 60 % of the joint account
    assert.equal(rowan.totals.incomeCountedCents, 200000);
    assert.equal(rowan.totals.committedCents, 60000);
    assert.equal(rowan.totals.unplannedSpendCents, 3000 + 1200);
    const leif = assessPeriod(applyLens(household, people, 2), period);
    assert.equal(leif.totals.committedCents, 40000);
    assert.equal(leif.totals.unplannedSpendCents, 800);
    // The two shares add back up to the household.
    assert.equal(rowan.totals.leftoverCents + leif.totals.leftoverCents, 350000 - 100000 - 5000);
  });
});
