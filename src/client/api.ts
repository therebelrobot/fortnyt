import type {
  Account,
  AccountBalanceEntry,
  AccountInput,
  Assessment,
  CalendarResponse,
  Item,
  ItemInput,
  LedgerResponse,
  OccurrenceMove,
  Person,
  PersonInput,
  Reserve,
  ReserveDetail,
  ReserveInput,
  Rule,
  RuleInput,
  Settings,
  Status,
  SyncLogEntry,
  Txn,
  TxnKind,
} from '../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON body — e.g. the plain-text "Unauthorized" that a 401 carries.
    }
  }
  if (!res.ok) {
    const d = data as { error?: string; code?: string; issues?: { path: string; message: string }[] } | null;
    throw new ApiError(d?.error ?? `Request failed (${res.status})`, res.status, d?.code ?? 'error', d?.issues ?? []);
  }
  return data as T;
}

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
  return s.toString();
};

export interface SyncResult {
  ok: boolean;
  requests: number;
  added: number;
  updated: number;
  removed: number;
  ruleAssigned: number;
  errors: { code: string; msg: string }[];
}

export const api = {
  status: () => req<Status>('GET', '/api/status'),
  saveSettings: (s: Settings) => req<Settings>('PUT', '/api/settings', s),

  assessment: (date: string | undefined, person: number | null) =>
    req<Assessment>('GET', `/api/assessment?${q({ date, person: person ?? undefined })}`),
  calendar: (from: string, to: string, person: number | null) =>
    req<CalendarResponse>('GET', `/api/calendar?${q({ from, to, person: person ?? undefined })}`),
  ledger: (from: string, to: string, person: number | null) =>
    req<LedgerResponse>('GET', `/api/ledger?${q({ from, to, person: person ?? undefined })}`),

  people: () => req<Person[]>('GET', '/api/people'),
  savePerson: (p: PersonInput, id?: number) =>
    id == null ? req<Person>('POST', '/api/people', p) : req<Person>('PUT', `/api/people/${id}`, p),
  deletePerson: (id: number) => req<{ ok: true }>('DELETE', `/api/people/${id}`),

  reserves: (person: number | null) => req<ReserveDetail[]>('GET', `/api/reserves?${q({ person: person ?? undefined })}`),
  saveReserve: (r: ReserveInput, id?: number) =>
    id == null ? req<Reserve>('POST', '/api/reserves', r) : req<Reserve>('PUT', `/api/reserves/${id}`, r),
  deleteReserve: (id: number) => req<{ ok: true }>('DELETE', `/api/reserves/${id}`),

  items: () => req<Item[]>('GET', '/api/items'),
  createItem: (i: ItemInput) => req<Item>('POST', '/api/items', i),
  updateItem: (id: number, i: ItemInput) => req<Item>('PUT', `/api/items/${id}`, i),
  deleteItem: (id: number) => req<{ ok: true }>('DELETE', `/api/items/${id}`),

  moveOccurrence: (itemId: number, fromDate: string, toDate: string) =>
    req<OccurrenceMove>('POST', `/api/items/${itemId}/moves`, { fromDate, toDate }),
  undoMove: (itemId: number, fromDate: string) =>
    req<{ ok: true }>('DELETE', `/api/items/${itemId}/moves/${fromDate}`),

  accounts: () => req<Account[]>('GET', '/api/accounts'),
  createAccount: (a: AccountInput) => req<Account>('POST', '/api/accounts', a),
  patchAccount: (id: string, p: { inBudget?: boolean; nickname?: string | null; ownerId?: number | null }) =>
    req<Account>('PATCH', `/api/accounts/${encodeURIComponent(id)}`, p),
  deleteAccount: (id: string) => req<{ ok: true }>('DELETE', `/api/accounts/${encodeURIComponent(id)}`),
  accountBalances: (id: string) => req<AccountBalanceEntry[]>('GET', `/api/accounts/${encodeURIComponent(id)}/balances`),
  setAccountBalance: (id: string, b: { date: string; balanceCents: number }) =>
    req<Account>('POST', `/api/accounts/${encodeURIComponent(id)}/balances`, b),
  deleteAccountBalance: (id: string, balanceId: number) =>
    req<Account>('DELETE', `/api/accounts/${encodeURIComponent(id)}/balances/${balanceId}`),

  patchTxn: (
    id: string,
    p: {
      itemId?: number | null;
      reserveId?: number | null;
      kind?: TxnKind;
      note?: string;
      occurrenceDate?: string | null;
      reset?: boolean;
    },
  ) => req<Txn>('PATCH', `/api/transactions/${encodeURIComponent(id)}`, p),
  addTxn: (t: {
    date: string;
    amountCents: number;
    description: string;
    itemId: number | null;
    reserveId: number | null;
    kind: TxnKind;
    note: string;
  }) =>
    req<Txn>('POST', '/api/transactions', t),
  deleteTxn: (id: string) => req<{ ok: true }>('DELETE', `/api/transactions/${encodeURIComponent(id)}`),

  rules: () => req<Rule[]>('GET', '/api/rules'),
  createRule: (r: RuleInput) => req<{ rule: Rule; changed: number }>('POST', '/api/rules', r),
  updateRule: (id: number, r: RuleInput) => req<{ rule: Rule; changed: number }>('PUT', `/api/rules/${id}`, r),
  deleteRule: (id: number) => req<{ ok: true; changed: number }>('DELETE', `/api/rules/${id}`),
  previewRule: (r: RuleInput) => req<{ count: number; manualSkipped: number; sample: Txn[] }>('POST', '/api/rules/preview', r),
  applyRules: () => req<{ changed: number }>('POST', '/api/rules/apply'),

  claim: (token: string) => req<{ ok: true; result?: SyncResult; syncError?: string }>('POST', '/api/simplefin/claim', { token }),
  sync: () => req<SyncResult>('POST', '/api/simplefin/sync'),
  disconnect: () => req<{ ok: true }>('DELETE', '/api/simplefin'),
  syncLog: () => req<SyncLogEntry[]>('GET', '/api/simplefin/log'),
};
