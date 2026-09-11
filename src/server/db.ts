// node:sqlite (built into Node) instead of better-sqlite3: no native addon to compile on the Pi,
// no extra package in the supply chain.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
  // 1 — initial schema
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE items (
    id                    INTEGER PRIMARY KEY,
    name                  TEXT    NOT NULL,
    kind                  TEXT    NOT NULL CHECK (kind IN ('income','expense')),
    grp                   TEXT    NOT NULL DEFAULT '',
    color                 TEXT,
    amount_cents          INTEGER NOT NULL CHECK (amount_cents >= 0),
    cadence               TEXT    NOT NULL,
    anchor_date           TEXT,
    day_of_month          INTEGER,
    day_of_month_2        INTEGER,
    interval_months       INTEGER NOT NULL DEFAULT 1,
    start_date            TEXT,
    end_date              TEXT,
    allocation            TEXT    NOT NULL DEFAULT 'due' CHECK (allocation IN ('due','spread','reserve')),
    tolerance_days        INTEGER NOT NULL DEFAULT 5,
    reserve_opening_cents INTEGER NOT NULL DEFAULT 0,
    notes                 TEXT    NOT NULL DEFAULT '',
    sort                  INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT    NOT NULL
  );

  CREATE TABLE accounts (
    id              TEXT PRIMARY KEY,          -- "<conn_id>:<account id>", or "manual:<slug>"
    sf_id           TEXT,
    conn_id         TEXT,
    conn_name       TEXT,
    name            TEXT NOT NULL,
    nickname        TEXT,
    currency        TEXT NOT NULL DEFAULT 'USD',
    balance_cents   INTEGER,
    available_cents INTEGER,
    balance_date    INTEGER,
    in_budget       INTEGER NOT NULL DEFAULT 1,
    manual          INTEGER NOT NULL DEFAULT 0,
    synced_through  INTEGER,
    last_error      TEXT,
    last_seen       TEXT
  );

  CREATE TABLE transactions (
    id              TEXT PRIMARY KEY,          -- "<account key>:<transaction id>"
    account_id      TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    sf_id           TEXT,
    date            TEXT    NOT NULL,
    posted          INTEGER,
    transacted_at   INTEGER,
    amount_cents    INTEGER NOT NULL,
    description     TEXT    NOT NULL,
    payee           TEXT,
    memo            TEXT,
    pending         INTEGER NOT NULL DEFAULT 0,
    item_id         INTEGER REFERENCES items(id) ON DELETE SET NULL,
    kind            TEXT    NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','transfer','ignore')),
    assigned_by     TEXT    CHECK (assigned_by IN ('rule','manual')),
    rule_id         INTEGER,
    occurrence_date TEXT,
    note            TEXT    NOT NULL DEFAULT '',
    manual          INTEGER NOT NULL DEFAULT 0,
    first_seen      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
  );
  CREATE INDEX transactions_date ON transactions(date);
  CREATE INDEX transactions_item ON transactions(item_id, date);
  CREATE INDEX transactions_account ON transactions(account_id, pending);

  CREATE TABLE rules (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL DEFAULT '',
    priority   INTEGER NOT NULL DEFAULT 100,
    field      TEXT    NOT NULL DEFAULT 'any',
    match      TEXT    NOT NULL DEFAULT 'contains',
    pattern    TEXT    NOT NULL,
    account_id TEXT,
    direction  TEXT    NOT NULL DEFAULT 'any',
    min_cents  INTEGER,
    max_cents  INTEGER,
    item_id    INTEGER REFERENCES items(id) ON DELETE CASCADE,
    set_kind   TEXT    NOT NULL DEFAULT 'normal',
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL
  );

  CREATE TABLE sync_log (
    id       INTEGER PRIMARY KEY,
    at       TEXT    NOT NULL,
    ok       INTEGER NOT NULL,
    trigger  TEXT    NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    added    INTEGER NOT NULL DEFAULT 0,
    updated  INTEGER NOT NULL DEFAULT 0,
    removed  INTEGER NOT NULL DEFAULT 0,
    errors   TEXT    NOT NULL DEFAULT '[]'
  );
  CREATE INDEX sync_log_at ON sync_log(at);
  `,
  // 2 — people, cash reserves, ownership
  `
  CREATE TABLE people (
    id                 INTEGER PRIMARY KEY,
    name               TEXT    NOT NULL,
    color              TEXT,
    share_pct          REAL    NOT NULL DEFAULT 50 CHECK (share_pct >= 0 AND share_pct <= 100),
    pay_anchor         TEXT,
    pay_interval_days  INTEGER,
    sort               INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE reserves (
    id            INTEGER PRIMARY KEY,
    name          TEXT    NOT NULL,
    color         TEXT,
    owner_id      INTEGER REFERENCES people(id) ON DELETE SET NULL,
    account_id    TEXT    REFERENCES accounts(id) ON DELETE SET NULL,
    target_cents  INTEGER,
    opening_cents INTEGER NOT NULL DEFAULT 0,
    opening_date  TEXT    NOT NULL,
    notes         TEXT    NOT NULL DEFAULT '',
    sort          INTEGER NOT NULL DEFAULT 0
  );

  ALTER TABLE items ADD COLUMN owner_id INTEGER REFERENCES people(id) ON DELETE SET NULL;
  ALTER TABLE items ADD COLUMN reserve_id INTEGER REFERENCES reserves(id) ON DELETE SET NULL;
  ALTER TABLE accounts ADD COLUMN owner_id INTEGER REFERENCES people(id) ON DELETE SET NULL;
  ALTER TABLE transactions ADD COLUMN reserve_id INTEGER REFERENCES reserves(id) ON DELETE SET NULL;
  ALTER TABLE rules ADD COLUMN reserve_id INTEGER REFERENCES reserves(id) ON DELETE CASCADE;
  CREATE INDEX transactions_reserve ON transactions(reserve_id, date);
  `,
  // 3 — hand-tracked balance history for manual (unsynced) accounts
  `
  CREATE TABLE account_balances (
    id            INTEGER PRIMARY KEY,
    account_id    TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date          TEXT    NOT NULL,
    balance_cents INTEGER NOT NULL,
    created_at    TEXT    NOT NULL
  );
  CREATE UNIQUE INDEX account_balances_account_date ON account_balances(account_id, date);
  `,
];

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'fortnyt.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function openMemoryDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
