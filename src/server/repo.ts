import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { inTransaction } from './db';
import type {
  Account,
  AccountBalanceEntry,
  ISODate,
  Item,
  ItemInput,
  OccurrenceMove,
  Person,
  PersonInput,
  Reserve,
  ReserveInput,
  Rule,
  RuleInput,
  Settings,
  SimplefinError,
  SyncLogEntry,
  Txn,
  TxnKind,
} from '../shared/types';

type Row = Record<string, SQLInputValue>;

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toItem(r: Row): Item {
  return {
    id: Number(r.id),
    name: String(r.name),
    kind: r.kind as Item['kind'],
    group: String(r.grp ?? ''),
    color: (r.color as string | null) ?? null,
    amountCents: Number(r.amount_cents),
    cadence: r.cadence as Item['cadence'],
    anchorDate: (r.anchor_date as string | null) ?? null,
    dayOfMonth: r.day_of_month == null ? null : Number(r.day_of_month),
    dayOfMonth2: r.day_of_month_2 == null ? null : Number(r.day_of_month_2),
    intervalMonths: Number(r.interval_months ?? 1),
    startDate: (r.start_date as string | null) ?? null,
    endDate: (r.end_date as string | null) ?? null,
    allocation: r.allocation as Item['allocation'],
    toleranceDays: Number(r.tolerance_days),
    reserveOpeningCents: Number(r.reserve_opening_cents ?? 0),
    notes: String(r.notes ?? ''),
    sort: Number(r.sort ?? 0),
    ownerId: r.owner_id == null ? null : Number(r.owner_id),
    reserveId: r.reserve_id == null ? null : Number(r.reserve_id),
    createdAt: String(r.created_at),
  };
}

function toAccount(r: Row): Account {
  return {
    id: String(r.id),
    name: String(r.name),
    nickname: (r.nickname as string | null) ?? null,
    connName: (r.conn_name as string | null) ?? null,
    currency: String(r.currency ?? 'USD'),
    balanceCents: r.balance_cents == null ? null : Number(r.balance_cents),
    availableCents: r.available_cents == null ? null : Number(r.available_cents),
    balanceDate: r.balance_date == null ? null : Number(r.balance_date),
    inBudget: Number(r.in_budget) === 1,
    manual: Number(r.manual) === 1,
    syncedThrough: r.synced_through == null ? null : Number(r.synced_through),
    lastError: (r.last_error as string | null) ?? null,
    ownerId: r.owner_id == null ? null : Number(r.owner_id),
  };
}

function toAccountBalanceEntry(r: Row): AccountBalanceEntry {
  return { id: Number(r.id), date: String(r.date), balanceCents: Number(r.balance_cents) };
}

function toOccurrenceMove(r: Row): OccurrenceMove {
  return {
    id: Number(r.id),
    itemId: Number(r.item_id),
    fromDate: String(r.from_date),
    toDate: String(r.to_date),
    createdAt: String(r.created_at),
  };
}

function toTxn(r: Row): Txn {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    date: String(r.date),
    amountCents: Number(r.amount_cents),
    description: String(r.description),
    payee: (r.payee as string | null) ?? null,
    memo: (r.memo as string | null) ?? null,
    pending: Number(r.pending) === 1,
    itemId: r.item_id == null ? null : Number(r.item_id),
    kind: r.kind as TxnKind,
    assignedBy: (r.assigned_by as Txn['assignedBy']) ?? null,
    ruleId: r.rule_id == null ? null : Number(r.rule_id),
    occurrenceDate: (r.occurrence_date as string | null) ?? null,
    note: String(r.note ?? ''),
    manual: Number(r.manual) === 1,
    reserveId: r.reserve_id == null ? null : Number(r.reserve_id),
  };
}

function toRule(r: Row): Rule {
  return {
    id: Number(r.id),
    name: String(r.name ?? ''),
    priority: Number(r.priority),
    field: r.field as Rule['field'],
    match: r.match as Rule['match'],
    pattern: String(r.pattern),
    accountId: (r.account_id as string | null) ?? null,
    direction: r.direction as Rule['direction'],
    minCents: r.min_cents == null ? null : Number(r.min_cents),
    maxCents: r.max_cents == null ? null : Number(r.max_cents),
    itemId: r.item_id == null ? null : Number(r.item_id),
    reserveId: r.reserve_id == null ? null : Number(r.reserve_id),
    setKind: r.set_kind as TxnKind,
    enabled: Number(r.enabled) === 1,
  };
}

function toPerson(r: Row): Person {
  return {
    id: Number(r.id),
    name: String(r.name),
    color: (r.color as string | null) ?? null,
    sharePct: Number(r.share_pct),
    payAnchor: (r.pay_anchor as string | null) ?? null,
    payIntervalDays: r.pay_interval_days == null ? null : Number(r.pay_interval_days),
    sort: Number(r.sort ?? 0),
  };
}

function toReserve(r: Row): Reserve {
  return {
    id: Number(r.id),
    name: String(r.name),
    color: (r.color as string | null) ?? null,
    ownerId: r.owner_id == null ? null : Number(r.owner_id),
    accountId: (r.account_id as string | null) ?? null,
    targetCents: r.target_cents == null ? null : Number(r.target_cents),
    openingCents: Number(r.opening_cents ?? 0),
    openingDate: String(r.opening_date),
    notes: String(r.notes ?? ''),
    sort: Number(r.sort ?? 0),
  };
}

function toSyncLog(r: Row): SyncLogEntry {
  let errors: SimplefinError[] = [];
  try {
    errors = JSON.parse(String(r.errors));
  } catch {
    errors = [];
  }
  return {
    id: Number(r.id),
    at: String(r.at),
    ok: Number(r.ok) === 1,
    trigger: String(r.trigger),
    requests: Number(r.requests),
    added: Number(r.added),
    updated: Number(r.updated),
    removed: Number(r.removed),
    errors,
  };
}

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: Settings = {
  payAnchor: null,
  payIntervalDays: 14,
  timezone: 'America/New_York',
  currency: 'USD',
  syncIntervalHours: 6,
  backfillDays: 89,
};

export interface IncomingTxn {
  id: string;
  accountId: string;
  sfId: string;
  date: ISODate;
  posted: number | null;
  transactedAt: number | null;
  amountCents: number;
  description: string;
  payee: string | null;
  memo: string | null;
  pending: boolean;
}

export class Repo {
  constructor(readonly db: DatabaseSync) {}

  tx<T>(fn: () => T): T {
    return inTransaction(this.db, fn);
  }

  // --- meta / settings -----------------------------------------------------

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else
      this.db
        .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value);
  }

  getSettings(): Settings {
    const raw = this.getMeta('settings');
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(s: Settings): Settings {
    this.setMeta('settings', JSON.stringify(s));
    return s;
  }

  // --- items ---------------------------------------------------------------

  listItems(): Item[] {
    return (this.db.prepare('SELECT * FROM items ORDER BY kind DESC, sort, name').all() as Row[]).map(toItem);
  }

  getItem(id: number): Item | null {
    const r = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Row | undefined;
    return r ? toItem(r) : null;
  }

  private itemParams(i: ItemInput) {
    return {
      $name: i.name,
      $kind: i.kind,
      $grp: i.group,
      $color: i.color,
      $amount: i.amountCents,
      $cadence: i.cadence,
      $anchor: i.anchorDate,
      $dom: i.dayOfMonth,
      $dom2: i.dayOfMonth2,
      $interval: i.intervalMonths,
      $start: i.startDate,
      $end: i.endDate,
      $alloc: i.allocation,
      $tol: i.toleranceDays,
      $opening: i.reserveOpeningCents,
      $notes: i.notes,
      $sort: i.sort,
      $owner: i.ownerId,
      $reserve: i.reserveId,
    };
  }

  createItem(i: ItemInput): Item {
    const res = this.db
      .prepare(
        `INSERT INTO items (name, kind, grp, color, amount_cents, cadence, anchor_date, day_of_month, day_of_month_2,
           interval_months, start_date, end_date, allocation, tolerance_days, reserve_opening_cents, notes, sort, owner_id,
           reserve_id, created_at)
         VALUES ($name, $kind, $grp, $color, $amount, $cadence, $anchor, $dom, $dom2, $interval, $start, $end, $alloc,
           $tol, $opening, $notes, $sort, $owner, $reserve, $created)`,
      )
      .run({ ...this.itemParams(i), $created: nowIso() });
    return this.getItem(Number(res.lastInsertRowid))!;
  }

  updateItem(id: number, i: ItemInput): Item | null {
    this.db
      .prepare(
        `UPDATE items SET name=$name, kind=$kind, grp=$grp, color=$color, amount_cents=$amount, cadence=$cadence,
           anchor_date=$anchor, day_of_month=$dom, day_of_month_2=$dom2, interval_months=$interval, start_date=$start,
           end_date=$end, allocation=$alloc, tolerance_days=$tol, reserve_opening_cents=$opening, notes=$notes, sort=$sort,
           owner_id=$owner, reserve_id=$reserve
         WHERE id=$id`,
      )
      .run({ ...this.itemParams(i), $id: id });
    return this.getItem(id);
  }

  deleteItem(id: number): boolean {
    return this.tx(() => {
      // Transactions keep existing but fall back to uncategorized; rule assignments are released.
      this.db.prepare(`UPDATE transactions SET assigned_by = NULL, rule_id = NULL WHERE item_id = ?`).run(id);
      return Number(this.db.prepare('DELETE FROM items WHERE id = ?').run(id).changes) > 0;
    });
  }

  // --- occurrence moves ------------------------------------------------------

  allMoves(): OccurrenceMove[] {
    return (this.db.prepare('SELECT * FROM occurrence_moves').all() as Row[]).map(toOccurrenceMove);
  }

  movesForItem(itemId: number): OccurrenceMove[] {
    return (
      this.db.prepare('SELECT * FROM occurrence_moves WHERE item_id = ?').all(itemId) as Row[]
    ).map(toOccurrenceMove);
  }

  /** Re-moving the same occurrence just replaces its target; that's the natural way to change your mind. */
  moveOccurrence(itemId: number, fromDate: ISODate, toDate: ISODate): OccurrenceMove {
    this.db
      .prepare(
        `INSERT INTO occurrence_moves (item_id, from_date, to_date, created_at) VALUES ($item, $from, $to, $created)
         ON CONFLICT(item_id, from_date) DO UPDATE SET to_date = excluded.to_date, created_at = excluded.created_at`,
      )
      .run({ $item: itemId, $from: fromDate, $to: toDate, $created: nowIso() });
    return this.movesForItem(itemId).find((m) => m.fromDate === fromDate)!;
  }

  deleteMove(itemId: number, fromDate: ISODate): boolean {
    return (
      Number(this.db.prepare('DELETE FROM occurrence_moves WHERE item_id = ? AND from_date = ?').run(itemId, fromDate).changes) > 0
    );
  }

  // --- accounts ------------------------------------------------------------

  listAccounts(): Account[] {
    return (this.db.prepare('SELECT * FROM accounts ORDER BY manual, conn_name, name').all() as Row[]).map(toAccount);
  }

  getAccount(id: string): Account | null {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
    return r ? toAccount(r) : null;
  }

  upsertSimplefinAccount(a: {
    id: string;
    sfId: string;
    connId: string | null;
    connName: string | null;
    name: string;
    currency: string;
    balanceCents: number | null;
    availableCents: number | null;
    balanceDate: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO accounts (id, sf_id, conn_id, conn_name, name, currency, balance_cents, available_cents, balance_date, last_seen)
         VALUES ($id, $sf, $conn, $connName, $name, $cur, $bal, $avail, $bdate, $seen)
         ON CONFLICT(id) DO UPDATE SET
           conn_name = excluded.conn_name, name = excluded.name, currency = excluded.currency,
           balance_cents = excluded.balance_cents, available_cents = excluded.available_cents,
           balance_date = excluded.balance_date, last_seen = excluded.last_seen`,
      )
      .run({
        $id: a.id,
        $sf: a.sfId,
        $conn: a.connId,
        $connName: a.connName,
        $name: a.name,
        $cur: a.currency,
        $bal: a.balanceCents,
        $avail: a.availableCents,
        $bdate: a.balanceDate,
        $seen: nowIso(),
      });
  }

  ensureManualAccount(id: string, name: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO accounts (id, name, manual, in_budget) VALUES (?, ?, 1, 1)`)
      .run(id, name);
  }

  updateAccount(id: string, patch: { inBudget?: boolean; nickname?: string | null; ownerId?: number | null }): Account | null {
    if (patch.ownerId !== undefined) this.db.prepare('UPDATE accounts SET owner_id = ? WHERE id = ?').run(patch.ownerId, id);
    if (patch.inBudget !== undefined)
      this.db.prepare('UPDATE accounts SET in_budget = ? WHERE id = ?').run(patch.inBudget ? 1 : 0, id);
    if (patch.nickname !== undefined)
      this.db.prepare('UPDATE accounts SET nickname = ? WHERE id = ?').run(patch.nickname, id);
    return this.getAccount(id);
  }

  createManualAccount(name: string, ownerId: number | null, inBudget: boolean): Account {
    const id = `manual:${crypto.randomUUID()}`;
    this.db
      .prepare(`INSERT INTO accounts (id, name, manual, in_budget, owner_id) VALUES (?, ?, 1, ?, ?)`)
      .run(id, name, inBudget ? 1 : 0, ownerId);
    return this.getAccount(id)!;
  }

  /**
   * Only accounts entered by hand can be removed; synced accounts come back on the next sync,
   * and the ad hoc "Cash & manual entries" bucket isn't something you added, so it can't be removed either.
   */
  deleteManualAccount(id: string): boolean {
    if (id === 'manual:cash') return false;
    return Number(this.db.prepare('DELETE FROM accounts WHERE id = ? AND manual = 1').run(id).changes) > 0;
  }

  listAccountBalances(accountId: string): AccountBalanceEntry[] {
    return (this.db.prepare('SELECT * FROM account_balances WHERE account_id = ? ORDER BY date').all(accountId) as Row[]).map(
      toAccountBalanceEntry,
    );
  }

  /** Records a balance as of a date and recomputes the account's current balance from the latest entry. */
  setAccountBalance(accountId: string, date: ISODate, balanceCents: number): void {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO account_balances (account_id, date, balance_cents, created_at) VALUES ($account, $date, $bal, $created)
           ON CONFLICT(account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents`,
        )
        .run({ $account: accountId, $date: date, $bal: balanceCents, $created: nowIso() });
      this.recomputeManualBalance(accountId);
    });
  }

  deleteAccountBalance(id: number, accountId: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM account_balances WHERE id = ? AND account_id = ?').run(id, accountId);
      this.recomputeManualBalance(accountId);
    });
  }

  private recomputeManualBalance(accountId: string): void {
    const latest = this.db
      .prepare('SELECT date, balance_cents FROM account_balances WHERE account_id = ? ORDER BY date DESC LIMIT 1')
      .get(accountId) as { date: string; balance_cents: number } | undefined;
    const epoch = latest ? Math.floor(Date.parse(`${latest.date}T00:00:00Z`) / 1000) : null;
    this.db
      .prepare('UPDATE accounts SET balance_cents = ?, balance_date = ? WHERE id = ?')
      .run(latest ? latest.balance_cents : null, epoch, accountId);
  }

  setAccountSync(id: string, syncedThrough: number | null, lastError: string | null): void {
    if (syncedThrough != null)
      this.db.prepare('UPDATE accounts SET synced_through = ?, last_error = ? WHERE id = ?').run(syncedThrough, lastError, id);
    else this.db.prepare('UPDATE accounts SET last_error = ? WHERE id = ?').run(lastError, id);
  }

  // --- transactions --------------------------------------------------------

  txnsBetween(from: ISODate, to: ISODate, opts: { allAccounts?: boolean } = {}): Txn[] {
    const sql = opts.allAccounts
      ? `SELECT t.* FROM transactions t WHERE t.date BETWEEN ? AND ? ORDER BY t.date, t.id`
      : `SELECT t.* FROM transactions t JOIN accounts a ON a.id = t.account_id
         WHERE a.in_budget = 1 AND t.date BETWEEN ? AND ? ORDER BY t.date, t.id`;
    return (this.db.prepare(sql).all(from, to) as Row[]).map(toTxn);
  }

  txnsForItem(itemId: number, from: ISODate, to: ISODate): Txn[] {
    return (
      this.db
        .prepare(
          `SELECT t.* FROM transactions t JOIN accounts a ON a.id = t.account_id
           WHERE a.in_budget = 1 AND t.item_id = ? AND t.date BETWEEN ? AND ? ORDER BY t.date`,
        )
        .all(itemId, from, to) as Row[]
    ).map(toTxn);
  }

  txnsForReserve(reserveId: number, from: ISODate, to: ISODate): Txn[] {
    return (
      this.db
        .prepare(
          `SELECT t.* FROM transactions t JOIN accounts a ON a.id = t.account_id
           WHERE a.in_budget = 1 AND t.reserve_id = ? AND t.item_id IS NULL AND t.date BETWEEN ? AND ? ORDER BY t.date`,
        )
        .all(reserveId, from, to) as Row[]
    ).map(toTxn);
  }

  getTxn(id: string): Txn | null {
    const r = this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Row | undefined;
    return r ? toTxn(r) : null;
  }

  /** Rules may only rewrite transactions nobody assigned by hand. */
  txnsOpenToRules(): Txn[] {
    return (
      this.db.prepare(`SELECT * FROM transactions WHERE assigned_by IS NULL OR assigned_by = 'rule'`).all() as Row[]
    ).map(toTxn);
  }

  pendingTxnsForAccount(accountId: string): Txn[] {
    return (
      this.db.prepare('SELECT * FROM transactions WHERE account_id = ? AND pending = 1').all(accountId) as Row[]
    ).map(toTxn);
  }

  /** Insert or refresh a bank transaction. Returns whether it was new. Never touches assignment fields. */
  upsertIncomingTxn(t: IncomingTxn): 'added' | 'updated' | 'same' {
    const existing = this.db
      .prepare('SELECT date, amount_cents, description, pending, posted FROM transactions WHERE id = ?')
      .get(t.id) as Row | undefined;
    const now = nowIso();
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO transactions (id, account_id, sf_id, date, posted, transacted_at, amount_cents, description,
             payee, memo, pending, first_seen, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          t.id,
          t.accountId,
          t.sfId,
          t.date,
          t.posted,
          t.transactedAt,
          t.amountCents,
          t.description,
          t.payee,
          t.memo,
          t.pending ? 1 : 0,
          now,
          now,
        );
      return 'added';
    }
    const changed =
      String(existing.date) !== t.date ||
      Number(existing.amount_cents) !== t.amountCents ||
      String(existing.description) !== t.description ||
      Number(existing.pending) !== (t.pending ? 1 : 0) ||
      (existing.posted == null ? null : Number(existing.posted)) !== t.posted;
    if (!changed) return 'same';
    this.db
      .prepare(
        `UPDATE transactions SET date=?, posted=?, transacted_at=?, amount_cents=?, description=?, payee=?, memo=?,
           pending=?, updated_at=? WHERE id=?`,
      )
      .run(t.date, t.posted, t.transactedAt, t.amountCents, t.description, t.payee, t.memo, t.pending ? 1 : 0, now, t.id);
    return 'updated';
  }

  assignTxn(
    id: string,
    a: {
      itemId: number | null;
      kind: TxnKind;
      assignedBy: 'rule' | 'manual' | null;
      ruleId?: number | null;
      reserveId?: number | null;
    },
  ): void {
    this.db
      .prepare('UPDATE transactions SET item_id=?, reserve_id=?, kind=?, assigned_by=?, rule_id=?, updated_at=? WHERE id=?')
      .run(a.itemId, a.reserveId ?? null, a.kind, a.assignedBy, a.ruleId ?? null, nowIso(), id);
  }

  updateTxnFields(id: string, patch: { note?: string; occurrenceDate?: ISODate | null }): void {
    if (patch.note !== undefined) this.db.prepare('UPDATE transactions SET note=? WHERE id=?').run(patch.note, id);
    if (patch.occurrenceDate !== undefined)
      this.db.prepare('UPDATE transactions SET occurrence_date=? WHERE id=?').run(patch.occurrenceDate, id);
  }

  copyAssignment(fromId: string, toId: string): void {
    this.db
      .prepare(
        `UPDATE transactions SET
           item_id = (SELECT item_id FROM transactions WHERE id = $from),
           reserve_id = (SELECT reserve_id FROM transactions WHERE id = $from),
           kind = (SELECT kind FROM transactions WHERE id = $from),
           assigned_by = (SELECT assigned_by FROM transactions WHERE id = $from),
           rule_id = (SELECT rule_id FROM transactions WHERE id = $from),
           note = (SELECT note FROM transactions WHERE id = $from),
           occurrence_date = (SELECT occurrence_date FROM transactions WHERE id = $from)
         WHERE id = $to`,
      )
      .run({ $from: fromId, $to: toId });
  }

  deleteTxn(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM transactions WHERE id = ?').run(id).changes) > 0;
  }

  createManualTxn(t: {
    accountId: string;
    date: ISODate;
    amountCents: number;
    description: string;
    itemId: number | null;
    reserveId: number | null;
    kind: TxnKind;
    note: string;
  }): Txn {
    const id = `${t.accountId}:${crypto.randomUUID()}`;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO transactions (id, account_id, date, amount_cents, description, item_id, reserve_id, kind, assigned_by,
           note, manual, first_seen, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        t.accountId,
        t.date,
        t.amountCents,
        t.description,
        t.itemId,
        t.reserveId,
        t.kind,
        t.itemId != null || t.reserveId != null || t.kind !== 'normal' ? 'manual' : null,
        t.note,
        now,
        now,
      );
    return this.getTxn(id)!;
  }

  counts() {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as Row).n);
    return {
      items: one('SELECT COUNT(*) AS n FROM items'),
      accounts: one('SELECT COUNT(*) AS n FROM accounts'),
      transactions: one('SELECT COUNT(*) AS n FROM transactions'),
      uncategorized: one(
        `SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
         WHERE a.in_budget = 1 AND t.kind = 'normal' AND t.item_id IS NULL AND t.reserve_id IS NULL`,
      ),
    };
  }

  // --- rules ---------------------------------------------------------------

  listRules(): Rule[] {
    return (this.db.prepare('SELECT * FROM rules ORDER BY priority, id').all() as Row[]).map(toRule);
  }

  private ruleParams(r: RuleInput) {
    return {
      $name: r.name,
      $priority: r.priority,
      $field: r.field,
      $match: r.match,
      $pattern: r.pattern,
      $account: r.accountId,
      $direction: r.direction,
      $min: r.minCents,
      $max: r.maxCents,
      $item: r.itemId,
      $reserve: r.reserveId,
      $kind: r.setKind,
      $enabled: r.enabled ? 1 : 0,
    };
  }

  createRule(r: RuleInput): Rule {
    const res = this.db
      .prepare(
        `INSERT INTO rules (name, priority, field, match, pattern, account_id, direction, min_cents, max_cents, item_id,
           reserve_id, set_kind, enabled, created_at)
         VALUES ($name, $priority, $field, $match, $pattern, $account, $direction, $min, $max, $item, $reserve, $kind,
           $enabled, $created)`,
      )
      .run({ ...this.ruleParams(r), $created: nowIso() });
    return this.listRules().find((x) => x.id === Number(res.lastInsertRowid))!;
  }

  updateRule(id: number, r: RuleInput): Rule | null {
    this.db
      .prepare(
        `UPDATE rules SET name=$name, priority=$priority, field=$field, match=$match, pattern=$pattern,
           account_id=$account, direction=$direction, min_cents=$min, max_cents=$max, item_id=$item, reserve_id=$reserve, set_kind=$kind,
           enabled=$enabled WHERE id=$id`,
      )
      .run({ ...this.ruleParams(r), $id: id });
    return this.listRules().find((x) => x.id === id) ?? null;
  }

  deleteRule(id: number): boolean {
    return this.tx(() => {
      // Release what this rule assigned so the next rules pass can reassign it.
      this.db
        .prepare(`UPDATE transactions SET item_id=NULL, reserve_id=NULL, kind='normal', assigned_by=NULL, rule_id=NULL
           WHERE rule_id=? AND assigned_by='rule'`)
        .run(id);
      return Number(this.db.prepare('DELETE FROM rules WHERE id = ?').run(id).changes) > 0;
    });
  }

  // --- people --------------------------------------------------------------

  listPeople(): Person[] {
    return (this.db.prepare('SELECT * FROM people ORDER BY sort, id').all() as Row[]).map(toPerson);
  }

  savePerson(p: PersonInput, id?: number): Person | null {
    const params = {
      $name: p.name,
      $color: p.color,
      $share: p.sharePct,
      $anchor: p.payAnchor,
      $interval: p.payIntervalDays,
      $sort: p.sort,
    };
    let key = id;
    if (id == null) {
      key = Number(
        this.db
          .prepare(
            `INSERT INTO people (name, color, share_pct, pay_anchor, pay_interval_days, sort)
             VALUES ($name, $color, $share, $anchor, $interval, $sort)`,
          )
          .run(params).lastInsertRowid,
      );
    } else {
      this.db
        .prepare(
          `UPDATE people SET name=$name, color=$color, share_pct=$share, pay_anchor=$anchor, pay_interval_days=$interval,
             sort=$sort WHERE id=$id`,
        )
        .run({ ...params, $id: id });
    }
    return this.listPeople().find((x) => x.id === key) ?? null;
  }

  deletePerson(id: number): boolean {
    // Their lines, accounts and reserves become shared (ON DELETE SET NULL).
    return Number(this.db.prepare('DELETE FROM people WHERE id = ?').run(id).changes) > 0;
  }

  // --- reserves ------------------------------------------------------------

  listReserves(): Reserve[] {
    return (this.db.prepare('SELECT * FROM reserves ORDER BY sort, name').all() as Row[]).map(toReserve);
  }

  saveReserve(r: ReserveInput, id?: number): Reserve | null {
    const params = {
      $name: r.name,
      $color: r.color,
      $owner: r.ownerId,
      $account: r.accountId,
      $target: r.targetCents,
      $opening: r.openingCents,
      $odate: r.openingDate,
      $notes: r.notes,
      $sort: r.sort,
    };
    let key = id;
    if (id == null) {
      key = Number(
        this.db
          .prepare(
            `INSERT INTO reserves (name, color, owner_id, account_id, target_cents, opening_cents, opening_date, notes, sort)
             VALUES ($name, $color, $owner, $account, $target, $opening, $odate, $notes, $sort)`,
          )
          .run(params).lastInsertRowid,
      );
    } else {
      this.db
        .prepare(
          `UPDATE reserves SET name=$name, color=$color, owner_id=$owner, account_id=$account, target_cents=$target,
             opening_cents=$opening, opening_date=$odate, notes=$notes, sort=$sort WHERE id=$id`,
        )
        .run({ ...params, $id: id });
    }
    return this.listReserves().find((x) => x.id === key) ?? null;
  }

  deleteReserve(id: number): boolean {
    return this.tx(() => {
      // Withdrawals assigned to it fall back to "not in the budget" so they stay visible.
      this.db.prepare(`UPDATE transactions SET assigned_by = NULL, rule_id = NULL WHERE reserve_id = ?`).run(id);
      return Number(this.db.prepare('DELETE FROM reserves WHERE id = ?').run(id).changes) > 0;
    });
  }

  // --- sync log ------------------------------------------------------------

  addSyncLog(e: Omit<SyncLogEntry, 'id' | 'at'>): void {
    this.db
      .prepare('INSERT INTO sync_log (at, ok, trigger, requests, added, updated, removed, errors) VALUES (?,?,?,?,?,?,?,?)')
      .run(nowIso(), e.ok ? 1 : 0, e.trigger, e.requests, e.added, e.updated, e.removed, JSON.stringify(e.errors));
    // Keep the log bounded.
    this.db.prepare('DELETE FROM sync_log WHERE id NOT IN (SELECT id FROM sync_log ORDER BY id DESC LIMIT 500)').run();
  }

  recentSyncLog(limit = 20): SyncLogEntry[] {
    return (this.db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(toSyncLog);
  }

  requestsSince(iso: string): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(requests), 0) AS n FROM sync_log WHERE at >= ?').get(iso) as Row;
    return Number(r.n);
  }

  lastSyncAt(): string | null {
    const r = this.db.prepare(`SELECT at FROM sync_log WHERE requests > 0 ORDER BY id DESC LIMIT 1`).get() as
      | Row
      | undefined;
    return r ? String(r.at) : null;
  }
}
