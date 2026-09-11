// Seeds a throwaway database with a realistic budget and ~100 days of fake bank activity,
// so every view can be tried without connecting SimpleFIN.
//
//   DATA_DIR=./data-demo npm run demo:seed
//   DATA_DIR=./data-demo npm run dev
//
// Refuses to touch a database that already has transactions.

import path from 'node:path';
import { addDays, dayOfWeek, eachDay, localDateOf, parts, toDayNum } from '../src/shared/dates';
import { openDatabase } from '../src/server/db';
import { Repo } from '../src/server/repo';
import { SyncService } from '../src/server/sync';
import type { ItemInput, RuleInput } from '../src/shared/types';

const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? 'data-demo');
const repo = new Repo(openDatabase(dataDir));
if (repo.counts().transactions > 0) {
  console.error(`${dataDir} already has transactions. Point DATA_DIR at an empty folder.`);
  process.exit(1);
}

const tz = process.env.FORTNYT_TZ ?? 'America/New_York';
const today = process.env.FORTNYT_TODAY ?? localDateOf(new Date(), tz);

// Most recent Friday at least a week back → today sits mid-period.
let anchor = addDays(today, -7);
while (dayOfWeek(anchor) !== 5) anchor = addDays(anchor, -1);
repo.saveSettings({ ...repo.getSettings(), payAnchor: anchor, timezone: tz });

// ---------------------------------------------------------------------------
// deterministic randomness
// ---------------------------------------------------------------------------
let seed = 0x5eed;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (lo: number, hi: number) => Math.round(lo + rand() * (hi - lo));
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

// ---------------------------------------------------------------------------
// budget lines
// ---------------------------------------------------------------------------
const base: Omit<ItemInput, 'name' | 'kind' | 'amountCents' | 'cadence'> = {
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
};
const mk = (i: Partial<ItemInput> & Pick<ItemInput, 'name' | 'kind' | 'amountCents' | 'cadence'>) =>
  repo.createItem({ ...base, ...i });

const y = parts(today).y;

// Two people, deliberately on different pay schedules: Rowan every other Friday, Leif twice a month.
const rowan = repo.savePerson({ name: 'Rowan', color: '#2f6f73', sharePct: 55, payAnchor: null, payIntervalDays: null, sort: 0 })!;
const leif = repo.savePerson({ name: 'Leif', color: '#8a5a8c', sharePct: 45, payAnchor: null, payIntervalDays: null, sort: 1 })!;

const accounts = [
  { id: 'demo:checking', name: 'Joint Checking', owner: null },
  { id: 'demo:card', name: 'Rewards Card', owner: null },
  { id: 'demo:leif', name: 'Leif Checking', owner: leif.id },
  { id: 'demo:savings', name: 'High-Yield Savings', owner: null },
];
for (const a of accounts) {
  repo.upsertSimplefinAccount({
    id: a.id, sfId: a.id, connId: 'demo', connName: 'Demo Credit Union', name: a.name, currency: 'USD',
    balanceCents: 0, availableCents: null, balanceDate: Math.floor(Date.now() / 1000),
  });
  repo.updateAccount(a.id, { ownerId: a.owner });
}
repo.updateAccount('demo:savings', { inBudget: false });

const reserveBase = { notes: '', sort: 0, color: null as string | null, targetCents: null as number | null };
const emergency = repo.saveReserve({
  ...reserveBase, name: 'Emergency fund', color: '#4f6d8a', ownerId: null, accountId: 'demo:savings',
  targetCents: 1200000, openingCents: 560000, openingDate: addDays(today, -100),
  notes: 'Lives in the savings account. Grows by the transfer every payday.',
})!;
const carFund = repo.saveReserve({
  ...reserveBase, name: 'Car', color: '#5b6aa0', ownerId: null, accountId: null,
  openingCents: 42000, openingDate: `${y}-03-16`, notes: 'Set aside inside checking for insurance and repairs.',
})!;
const travel = repo.saveReserve({
  ...reserveBase, name: 'Travel', color: '#b0739a', ownerId: leif.id, accountId: null, targetCents: 180000,
  openingCents: 25000, openingDate: addDays(today, -100),
})!;

const items = {
  paycheck: mk({ name: 'Rowan paycheck', kind: 'income', amountCents: 215000, cadence: 'paycheck', group: 'Income', color: '#4f8a4b', ownerId: rowan.id }),
  leifPay: mk({ name: 'Leif paycheck', kind: 'income', amountCents: 158000, cadence: 'semimonthly', dayOfMonth: 1, dayOfMonth2: 15, group: 'Income', color: '#6f9a4e', ownerId: leif.id, toleranceDays: 3 }),
  side: mk({ name: 'Side work', kind: 'income', amountCents: 30000, cadence: 'monthly', dayOfMonth: 20, group: 'Income', color: '#7da35a', toleranceDays: 4, ownerId: rowan.id }),
  rent: mk({ name: 'Rent', kind: 'expense', amountCents: 210000, cadence: 'monthly', dayOfMonth: 1, group: 'Home', color: '#2f6f73' }),
  electric: mk({ name: 'Electric', kind: 'expense', amountCents: 9500, cadence: 'monthly', dayOfMonth: 12, group: 'Home', color: '#3f8f86' }),
  internet: mk({ name: 'Internet', kind: 'expense', amountCents: 7000, cadence: 'monthly', dayOfMonth: 5, group: 'Home', color: '#5aa39a' }),
  phone: mk({ name: 'Rowan phone', kind: 'expense', amountCents: 5500, cadence: 'monthly', dayOfMonth: 22, group: 'Bills', color: '#6b7fae', ownerId: rowan.id }),
  streaming: mk({ name: 'Streaming', kind: 'expense', amountCents: 2800, cadence: 'monthly', dayOfMonth: 9, group: 'Bills', color: '#8290bd' }),
  insurance: mk({
    name: 'Car insurance', kind: 'expense', amountCents: 54000, cadence: 'monthly', dayOfMonth: 15, intervalMonths: 6,
    anchorDate: `${y}-03-15`, startDate: `${y}-03-16`, allocation: 'reserve', group: 'Bills', color: '#5b6aa0',
    reserveId: carFund.id, notes: 'Six-month premium, saved up a little every day into the Car reserve.',
  }),
  carUpkeep: mk({
    name: 'Car upkeep', kind: 'expense', amountCents: 6000, cadence: 'paycheck', allocation: 'reserve',
    startDate: `${y}-03-16`, group: 'Bills', color: '#7482b5', reserveId: carFund.id,
  }),
  travelFund: mk({
    name: 'Travel fund', kind: 'expense', amountCents: 15000, cadence: 'monthly', dayOfMonth: 1, allocation: 'reserve',
    startDate: addDays(today, -100), group: 'Savings', color: '#b0739a', reserveId: travel.id, ownerId: leif.id,
  }),
  hosting: mk({
    name: 'Domains & hosting', kind: 'expense', amountCents: 18000, cadence: 'yearly', anchorDate: `${y + 1}-02-01`,
    startDate: `${y}-02-02`, allocation: 'reserve', group: 'Bills', color: '#9aa5cf',
  }),
  groceries: mk({ name: 'Groceries', kind: 'expense', amountCents: 85000, cadence: 'monthly', dayOfMonth: 1, allocation: 'spread', group: 'Everyday', color: '#b8892a' }),
  gas: mk({ name: 'Gas & transit', kind: 'expense', amountCents: 16000, cadence: 'monthly', dayOfMonth: 1, allocation: 'spread', group: 'Everyday', color: '#c99a3c' }),
  fun: mk({ name: 'Fun money', kind: 'expense', amountCents: 10000, cadence: 'paycheck', allocation: 'spread', group: 'Everyday', color: '#d6a94e' }),
  hobby: mk({ name: 'Hobby supplies', kind: 'expense', amountCents: 12000, cadence: 'monthly', dayOfMonth: 1, allocation: 'spread', group: 'Everyday', color: '#a8792a', ownerId: rowan.id }),
  carPayment: mk({ name: 'Car payment', kind: 'expense', amountCents: 38500, cadence: 'monthly', dayOfMonth: 8, group: 'Bills', color: '#56679c', ownerId: rowan.id }),
  loan: mk({ name: 'Leif student loan', kind: 'expense', amountCents: 26000, cadence: 'monthly', dayOfMonth: 18, group: 'Bills', color: '#9a6f8c', ownerId: leif.id }),
  savings: mk({ name: 'To emergency fund', kind: 'expense', amountCents: 20000, cadence: 'paycheck', group: 'Savings', color: '#4f6d8a', toleranceDays: 3, reserveId: emergency.id }),
};

const rule = (r: Partial<RuleInput> & Pick<RuleInput, 'pattern'>) =>
  repo.createRule({
    name: '', priority: 100, field: 'any', match: 'contains', accountId: null, direction: 'any',
    minCents: null, maxCents: null, itemId: null, reserveId: null, setKind: 'normal', enabled: true, ...r,
  });
rule({ pattern: 'ACME COOPERATIVE PAYROLL', direction: 'in', itemId: items.paycheck.id });
rule({ pattern: 'RIVERBEND CLINIC PAYROLL', direction: 'in', itemId: items.leifPay.id });
rule({ pattern: 'AUTO FINANCE', itemId: items.carPayment.id });
rule({ pattern: 'LOAN SERVICER', itemId: items.loan.id });
rule({ pattern: 'TIRE & AUTO', direction: 'out', reserveId: carFund.id });
rule({ pattern: 'TRANSFER TO JOINT', setKind: 'transfer', priority: 10 });
rule({ pattern: 'TRANSFER FROM LEIF', setKind: 'transfer', priority: 10 });
rule({ pattern: 'INVOICE', direction: 'in', itemId: items.side.id });
rule({ pattern: 'PROPERTY MGMT', itemId: items.rent.id });
rule({ pattern: 'POWER & LIGHT', itemId: items.electric.id });
rule({ pattern: 'FIBERNET', itemId: items.internet.id });
rule({ pattern: 'MOBILE', itemId: items.phone.id });
rule({ pattern: 'STREAMFLIX', itemId: items.streaming.id });
rule({ pattern: 'green leaf|corner grocer|co-op', match: 'regex', itemId: items.groceries.id });
rule({ pattern: 'SUNPOINT', itemId: items.gas.id });
rule({ pattern: 'noodle|cinema|arcade', match: 'regex', itemId: items.fun.id });
rule({ pattern: 'PARTSBIN', itemId: items.hobby.id });
rule({ pattern: 'TRANSFER TO SAVINGS', direction: 'out', itemId: items.savings.id });
rule({ pattern: 'CARD AUTOPAY', setKind: 'transfer', priority: 10 });
rule({ pattern: 'PAYMENT THANK YOU', setKind: 'transfer', priority: 10 });

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------
let seq = 0;
const totals: Record<string, number> = { 'demo:checking': -560000, 'demo:card': -41250, 'demo:leif': -250000, 'demo:savings': 560000 };
function add(accountId: string, date: string, amountCents: number, description: string) {
  if (date > today) return;
  totals[accountId] += amountCents;
  repo.upsertIncomingTxn({
    id: `${accountId}:${++seq}`, accountId, sfId: String(seq), date, posted: null, transactedAt: null, amountCents,
    description, payee: null, memo: null, pending: toDayNum(today) - toDayNum(date) < 2,
  });
}

const start = addDays(today, -100);
let cardMonthSpend = 0;
for (const d of eachDay(start, today)) {
  const { d: dom } = parts(d);
  const dow = dayOfWeek(d);
  const isPayday = (toDayNum(d) - toDayNum(anchor)) % 14 === 0;

  if (isPayday) {
    // Direct deposit sometimes lands a day early — the engine still counts it for this payday.
    const depositDay = rand() < 0.4 ? addDays(d, -1) : d;
    add('demo:checking', depositDay, 215000 - between(0, 400), 'ACME COOPERATIVE PAYROLL');
    add('demo:checking', d, -20000, 'TRANSFER TO SAVINGS');
    add('demo:savings', d, 20000, 'TRANSFER FROM CHECKING');
  }
  if (dom === 1 || dom === 15) {
    add('demo:leif', d, 158000 - between(0, 300), 'RIVERBEND CLINIC PAYROLL');
    // Leif moves their half of the shared costs into the joint account.
    add('demo:leif', d, -95000, 'TRANSFER TO JOINT');
    add('demo:checking', d, 95000, 'TRANSFER FROM LEIF');
  }
  if (dom === 8) add('demo:checking', d, -38500, 'VALLEY AUTO FINANCE');
  if (dom === 18) add('demo:leif', d, -26000, 'MERIDIAN LOAN SERVICER');
  if (dom === 1) add('demo:checking', rand() < 0.5 ? addDays(d, -1) : d, -210000, 'OAKWOOD PROPERTY MGMT');
  if (d === addDays(today, -9)) add('demo:checking', d, -38400, 'NORTHSIDE TIRE & AUTO');
  if (dom === 20) add('demo:checking', addDays(d, between(0, 2)), between(26000, 34000), 'CLIENT INVOICE 20' + between(10, 99));
  if (dom === 12) {
    const amt = -between(8200, 11800);
    add('demo:card', addDays(d, between(-1, 1)), amt, 'VALLEY POWER & LIGHT');
    cardMonthSpend -= amt;
  }
  if (dom === 5) add('demo:checking', d, -7000, 'FIBERNET HOME');
  if (dom === 22) add('demo:card', d, -5500, 'CEDAR MOBILE');
  if (dom === 9) add('demo:card', d, -2800, 'STREAMFLIX');
  if (dom === 25 && cardMonthSpend > 0) {
    add('demo:checking', d, -cardMonthSpend, 'REWARDS CARD AUTOPAY');
    add('demo:card', d, cardMonthSpend, 'PAYMENT THANK YOU');
    cardMonthSpend = 0;
  }

  const card = (amountCents: number, description: string) => {
    add('demo:card', d, amountCents, description);
    cardMonthSpend -= amountCents;
  };
  if ((dow === 2 || dow === 6) && rand() < 0.9) card(-between(5500, 12800), pick(['GREEN LEAF MARKET', 'CORNER GROCER #44', 'RIVERSIDE CO-OP']));
  if (dow === 1 && rand() < 0.85) card(-between(2800, 5200), 'SUNPOINT FUEL 118');
  if (rand() < 0.35) card(-between(450, 925), 'LANTERN COFFEE');
  if (dow === 5 && rand() < 0.6) card(-between(1800, 4200), pick(['NOODLE HOUSE', 'MOONLIGHT CINEMA', 'PIXEL ARCADE BAR']));
  if (rand() < 0.07) card(-between(1500, 6400), 'PARTSBIN ELECTRONICS');
  if (rand() < 0.05) card(-between(900, 4800), pick(['HARDWARE DEPOT', 'POST OFFICE', 'LEAF & SPINE BOOKS', 'THRIFT COLLECTIVE']));
  if (rand() < 0.2) add('demo:leif', d, -between(600, 2400), pick(['YARN & NEEDLE', 'LANTERN COFFEE', 'CORNER GROCER #44']));
}

for (const [id, bal] of Object.entries(totals)) {
  repo.db.prepare('UPDATE accounts SET balance_cents = ? WHERE id = ?').run(bal, id);
}

const sync = new SyncService({ repo, log: () => { } });
const assigned = sync.applyRules('all');
console.log(`Seeded ${dataDir}: ${Object.keys(items).length} budget lines, ${seq} transactions (${assigned} matched by rules).`);
console.log(`Pay schedule: every 14 days from ${anchor}. Start it with DATA_DIR=${path.relative(process.cwd(), dataDir) || '.'} npm run dev`);
