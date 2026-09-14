// Shared domain + API types. Imported by both the server and the client.
// All money is integer cents. All calendar dates are local `YYYY-MM-DD` strings.

export type ISODate = string;

/** How often a budget line recurs. `paycheck` follows the pay schedule itself. */
export type Cadence =
  | 'paycheck'
  | 'weekly'
  | 'biweekly'
  | 'semimonthly'
  | 'monthly'
  | 'yearly'
  | 'once';

/**
 * How an expense line lands in pay periods.
 * - `due`     — the whole amount lands in the pay period containing its due date (rent, phone bill).
 * - `spread`  — an envelope: the amount is spread per day across its cycle, and spending
 *               counts against the period it happens in (groceries, gas, fun money).
 * - `reserve` — a sinking fund: every period sets aside its daily share; the actual bill is
 *               paid out of the fund, not out of the period it lands in (car insurance, annual renewals).
 */
export type Allocation = 'due' | 'spread' | 'reserve';
export type ItemKind = 'income' | 'expense';
/** `transfer` and `ignore` transactions never count toward the budget. */
export type TxnKind = 'normal' | 'transfer' | 'ignore';

export interface Item {
  id: number;
  name: string;
  kind: ItemKind;
  group: string;
  color: string | null;
  amountCents: number;
  cadence: Cadence;
  /** weekly / biweekly / yearly / once: a date the line falls on. */
  anchorDate: ISODate | null;
  /** monthly / semimonthly: day of month (1–31; 31 means "last day"). */
  dayOfMonth: number | null;
  /** semimonthly: second day of month. */
  dayOfMonth2: number | null;
  /** monthly: every N months (3 = quarterly). Month alignment comes from anchorDate or startDate. */
  intervalMonths: number;
  startDate: ISODate | null;
  endDate: ISODate | null;
  allocation: Allocation;
  /** A matched transaction within ± this many days of a due date counts toward that due date. */
  toleranceDays: number;
  /** reserve: money already set aside when the fund starts. */
  reserveOpeningCents: number;
  notes: string;
  sort: number;
  /** Who is responsible. null = shared by the household (split by each person's share). */
  ownerId: number | null;
  /**
   * Cash reserve this line feeds.
   * - allocation `reserve`: saves its daily share into this reserve and pays its bills from it
   *   (null = the line keeps its own private fund).
   * - allocation `due` (expense): a contribution — whatever is paid lands in the reserve.
   */
  reserveId: number | null;
  createdAt: string;
}

export type ItemInput = Omit<Item, 'id' | 'createdAt'>;

export interface Account {
  id: string;
  name: string;
  nickname: string | null;
  connName: string | null;
  currency: string;
  balanceCents: number | null;
  availableCents: number | null;
  /** unix seconds */
  balanceDate: number | null;
  inBudget: boolean;
  manual: boolean;
  /** unix seconds — transactions are complete up to here */
  syncedThrough: number | null;
  lastError: string | null;
  /** null = joint */
  ownerId: number | null;
}

/** A bank account fortnyt doesn't sync — its balance is a history you type in by hand. */
export interface AccountInput {
  name: string;
  ownerId: number | null;
  inBudget: boolean;
}

export interface AccountBalanceEntry {
  id: number;
  date: ISODate;
  balanceCents: number;
}

export interface Txn {
  id: string;
  accountId: string;
  date: ISODate;
  amountCents: number;
  description: string;
  payee: string | null;
  memo: string | null;
  pending: boolean;
  itemId: number | null;
  kind: TxnKind;
  assignedBy: 'rule' | 'manual' | null;
  ruleId: number | null;
  /** Manual override: which due date of the item this payment covers. */
  occurrenceDate: ISODate | null;
  note: string;
  manual: boolean;
  /** Paid out of (negative) or deposited into (positive) a cash reserve, instead of the budget. */
  reserveId: number | null;
  /** Set only in a person's view when the amount shown is their share: the full bank amount. */
  fullAmountCents?: number;
}

export type RuleField = 'any' | 'description' | 'payee' | 'memo';
export type RuleMatch = 'contains' | 'starts' | 'exact' | 'regex';

export interface Rule {
  id: number;
  name: string;
  priority: number;
  field: RuleField;
  match: RuleMatch;
  pattern: string;
  accountId: string | null;
  direction: 'any' | 'in' | 'out';
  /** compared against the absolute amount */
  minCents: number | null;
  maxCents: number | null;
  itemId: number | null;
  /** alternative target: pay from / deposit into a cash reserve */
  reserveId: number | null;
  setKind: TxnKind;
  enabled: boolean;
}

export type RuleInput = Omit<Rule, 'id'>;

/** A manual reschedule of one due-line occurrence — pushes its obligation to a different date. */
export interface OccurrenceMove {
  id: number;
  itemId: number;
  fromDate: ISODate;
  toDate: ISODate;
  createdAt: string;
}

/** A temporary override of a line's budget for one pay period. */
export interface PeriodAdjustment {
  id: number;
  itemId: number;
  /** the pay period's start date (a payday) */
  periodStart: ISODate;
  /** the line's total budget for that period, in cents */
  amountCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface Period {
  index: number;
  start: ISODate;
  end: ISODate;
  payday: ISODate;
  status: 'past' | 'current' | 'future';
}

export type IncomeStatus = 'received' | 'expected' | 'late' | 'extra';
export type ExpenseStatus =
  | 'paid'
  | 'upcoming'
  | 'overdue'
  | 'extra'
  | 'open'
  | 'closed'
  | 'funding'
  | 'deferred';

export interface IncomeLine {
  key: string;
  itemId: number;
  name: string;
  group: string;
  color: string | null;
  date: ISODate | null;
  expectedCents: number;
  actualCents: number;
  /** what the leftover math uses */
  countedCents: number;
  status: IncomeStatus;
  txnIds: string[];
}

export interface ExpenseLine {
  key: string;
  itemId: number;
  name: string;
  group: string;
  color: string | null;
  allocation: Allocation;
  date: ISODate | null;
  budgetCents: number;
  /** positive = money out */
  actualCents: number;
  /** what the leftover math uses */
  committedCents: number;
  remainingCents: number;
  status: ExpenseStatus;
  txnIds: string[];
  /** reserve lines: balance of the reserve it saves into, at the end of the period */
  fundBalanceCents: number | null;
  /** reserve lines: which reserve (see Assessment.reserves) */
  reserveKey: string | null;
  /** due lines: this occurrence was due before this period and is still unpaid — it stays committed until paid. */
  carriedOver: boolean;
  /** due lines: this occurrence was manually moved here from an earlier natural date. */
  movedFrom: ISODate | null;
  /** due lines: this occurrence's natural date was here, but its obligation was moved out to a later date. */
  movedTo: ISODate | null;
  /** set when a temporary per-period adjustment applies to this line */
  adjustedCents: number | null;
  /** the line's budget for this period without any adjustment (for display); null for lines that don't take an adjustment */
  baseBudgetCents: number | null;
}

export interface CashCheck {
  balanceCents: number;
  upcomingIncomeCents: number;
  remainingCents: number;
  reserveHeldCents: number;
  freeCents: number;
  accountCount: number;
  /** oldest balance-date among counted accounts, unix seconds */
  asOf: number | null;
}

export interface Totals {
  incomeExpectedCents: number;
  incomeCountedCents: number;
  budgetedCents: number;
  committedCents: number;
  spentCents: number;
  unplannedSpendCents: number;
  unplannedIncomeCents: number;
  /** bills that overran a cash reserve; the overrun is charged to this period */
  reserveShortfallCents: number;
  /** the headline: counted income − committed − unplanned spend + unplanned income − reserve shortfall */
  leftoverCents: number;
  /** pure plan, no transactions: expected income − budgeted */
  planLeftoverCents: number;
}

export interface Assessment {
  period: Period;
  today: ISODate;
  income: IncomeLine[];
  expenses: ExpenseLine[];
  unplanned: {
    spendCents: number;
    incomeCents: number;
    txnIds: string[];
  };
  uncategorizedCount: number;
  totals: Totals;
  cash: CashCheck | null;
  reserves: ReserveSummary[];
  transactions: Txn[];
  lens: LensInfo;
}

export interface Person {
  id: number;
  name: string;
  color: string | null;
  /** percent of shared lines and joint accounts this person carries (0–100) */
  sharePct: number;
  /** optional own pay schedule for this person's view; falls back to the household schedule */
  payAnchor: ISODate | null;
  payIntervalDays: number | null;
  sort: number;
}
export type PersonInput = Omit<Person, 'id'>;

/** A named pool of set-aside money: emergency fund, car fund, travel. */
export interface Reserve {
  id: number;
  name: string;
  color: string | null;
  ownerId: number | null;
  /** where the money physically sits; null = somewhere in the in-budget accounts */
  accountId: string | null;
  targetCents: number | null;
  openingCents: number;
  openingDate: ISODate;
  notes: string;
  sort: number;
}
export type ReserveInput = Omit<Reserve, 'id'>;

export interface ReserveSummary {
  /** "r:<id>" for a real reserve, "line:<itemId>" for a line's private fund */
  key: string;
  reserveId: number | null;
  name: string;
  color: string | null;
  accountId: string | null;
  targetCents: number | null;
  startCents: number;
  /** money that went in during the period (shares, contributions, deposits) */
  inCents: number;
  /** money paid out during the period */
  outCents: number;
  shortfallCents: number;
  endCents: number;
  /** true when the money sits in an in-budget account, so the cash check must hold it back */
  heldInBudget: boolean;
}

export interface LensInfo {
  /** null = the whole household */
  personId: number | null;
  name: string;
  sharePct: number | null;
  /** which pay schedule framed the periods */
  pay: { anchor: ISODate; intervalDays: number };
}

export interface ReserveDetail extends Reserve {
  virtual: boolean;
  key: string;
  balanceTodayCents: number;
  /** balance at the end of each pay period, 6 back to 6 ahead (future includes planned contributions) */
  history: { date: ISODate; balanceCents: number; projected: boolean }[];
  lines: { itemId: number; name: string; role: 'saves' | 'contributes' }[];
  accountBalanceCents: number | null;
}

export interface PlannedEntry {
  key: string;
  itemId: number;
  name: string;
  kind: ItemKind;
  color: string | null;
  date: ISODate;
  amountCents: number;
  status: IncomeStatus | ExpenseStatus;
}

export interface CalendarDay {
  date: ISODate;
  periodIndex: number | null;
  payday: boolean;
  planned: PlannedEntry[];
  txns: Txn[];
  netCents: number;
}

export interface PeriodSummary {
  period: Period;
  leftoverCents: number;
  planLeftoverCents: number;
  envelopeBudgetCents: number;
  envelopeSpentCents: number;
}

export interface CalendarResponse {
  from: ISODate;
  to: ISODate;
  today: ISODate;
  days: CalendarDay[];
  periods: PeriodSummary[];
}

export interface LedgerResponse {
  from: ISODate;
  to: ISODate;
  transactions: Txn[];
  planned: PlannedEntry[];
}

export interface Settings {
  payAnchor: ISODate | null;
  payIntervalDays: number;
  timezone: string;
  currency: string;
  syncIntervalHours: number;
  backfillDays: number;
}

export interface SyncLogEntry {
  id: number;
  at: string;
  ok: boolean;
  trigger: string;
  requests: number;
  added: number;
  updated: number;
  removed: number;
  errors: SimplefinError[];
}

export interface SimplefinError {
  code: string;
  msg: string;
  connId?: string;
  accountId?: string;
}

export interface Status {
  settings: Settings;
  today: ISODate;
  currentPeriod: Period | null;
  simplefin: {
    connected: boolean;
    host: string | null;
    encrypted: boolean;
    running: boolean;
    requests24h: number;
    requestBudget: number;
    lastSync: SyncLogEntry | null;
    nextScheduledAt: string | null;
  };
  counts: { items: number; accounts: number; transactions: number; uncategorized: number };
  people: Person[];
}
