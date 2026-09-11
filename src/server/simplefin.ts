// SimpleFIN protocol client (v2, https://www.simplefin.org/protocol.html).
//
// Spec checklist this file covers:
//  - 403 on claim → tell the user the token may be compromised
//  - HTTPS only; Node's fetch verifies TLS certificates by default (never disabled here)
//  - 402 / 403 on /accounts handled with user-facing messages
//  - errlist (and the deprecated `errors` strings) surfaced, sanitized

import type { SimplefinError } from '../shared/types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class SimplefinHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface SfTransaction {
  id: string;
  posted: number;
  amount: string;
  description: string;
  transacted_at?: number;
  pending?: boolean;
  payee?: string;
  memo?: string;
}

export interface SfAccount {
  id: string;
  name: string;
  conn_id?: string;
  conn_name?: string;
  currency: string;
  balance: string;
  'available-balance'?: string;
  'balance-date': number;
  transactions?: SfTransaction[];
  /** v1 only */
  org?: { name?: string; domain?: string };
}

export interface SfAccountSet {
  errlist: SimplefinError[];
  connections: { conn_id: string; name: string; org_id?: string; org_url?: string }[];
  accounts: SfAccount[];
}

/** Control characters out, length capped. React escapes HTML on render. */
export function sanitize(msg: unknown, max = 400): string {
  return String(msg ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function requireHttps(url: URL, allowInsecure: boolean): void {
  if (url.protocol !== 'https:' && !allowInsecure) {
    throw new Error(`SimpleFIN URLs must use HTTPS (got ${url.protocol.replace(':', '')}).`);
  }
}

/** Decode a Setup Token (base64 URL) and claim the Access URL. One-shot: the token dies after this. */
export async function claimAccessUrl(
  setupToken: string,
  opts: { fetch?: FetchLike; allowInsecure?: boolean } = {},
): Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  const cleaned = setupToken.trim().replace(/\s+/g, '');
  let claimUrl: URL;
  try {
    claimUrl = new URL(Buffer.from(cleaned, 'base64').toString('utf8').trim());
  } catch {
    throw new Error('That does not look like a SimpleFIN Setup Token. Copy the whole token from the SimpleFIN Bridge and paste it again.');
  }
  requireHttps(claimUrl, !!opts.allowInsecure);

  const res = await doFetch(claimUrl.toString(), { method: 'POST', headers: { 'Content-Length': '0' } });
  if (res.status === 403) {
    throw new SimplefinHttpError(
      'SimpleFIN refused this Setup Token: it was already claimed or does not exist. ' +
        'If you did not claim it yourself, someone else may have — disable it in the SimpleFIN Bridge and create a new one.',
      403,
    );
  }
  if (!res.ok) throw new SimplefinHttpError(`SimpleFIN claim failed with HTTP ${res.status}.`, res.status);
  const accessUrl = (await res.text()).trim();
  let parsed: URL;
  try {
    parsed = new URL(accessUrl);
  } catch {
    throw new Error('SimpleFIN returned something that is not an Access URL.');
  }
  requireHttps(parsed, !!opts.allowInsecure);
  if (!parsed.username) throw new Error('SimpleFIN returned an Access URL without credentials.');
  return accessUrl;
}

export function accessHost(accessUrl: string): string | null {
  try {
    return new URL(accessUrl).host;
  } catch {
    return null;
  }
}

export interface AccountsQuery {
  /** unix seconds, inclusive */
  startDate?: number;
  /** unix seconds, exclusive */
  endDate?: number;
  pending?: boolean;
  balancesOnly?: boolean;
}

/**
 * GET {access}/accounts. Node's fetch refuses URLs with embedded credentials,
 * so they're split out into an Authorization header here.
 */
export async function fetchAccounts(
  accessUrl: string,
  q: AccountsQuery,
  opts: { fetch?: FetchLike; allowInsecure?: boolean } = {},
): Promise<SfAccountSet> {
  const doFetch = opts.fetch ?? fetch;
  const url = new URL(accessUrl);
  requireHttps(url, !!opts.allowInsecure);
  const auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
  url.username = '';
  url.password = '';
  url.pathname = url.pathname.replace(/\/+$/, '') + '/accounts';
  url.searchParams.set('version', '2');
  if (q.startDate != null) url.searchParams.set('start-date', String(Math.floor(q.startDate)));
  if (q.endDate != null) url.searchParams.set('end-date', String(Math.floor(q.endDate)));
  if (q.pending) url.searchParams.set('pending', '1');
  if (q.balancesOnly) url.searchParams.set('balances-only', '1');

  const res = await doFetch(url.toString(), {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (res.status === 402) {
    throw new SimplefinHttpError('SimpleFIN says payment is required. Check your SimpleFIN Bridge subscription.', 402);
  }
  if (res.status === 403) {
    throw new SimplefinHttpError(
      'SimpleFIN rejected the saved connection (access revoked or credentials wrong). Disconnect and connect again with a new Setup Token.',
      403,
    );
  }
  if (!res.ok) throw new SimplefinHttpError(`SimpleFIN /accounts failed with HTTP ${res.status}.`, res.status);
  const body = (await res.json()) as Partial<SfAccountSet> & { errors?: unknown[] };
  return normalizeAccountSet(body);
}

export function normalizeAccountSet(body: Partial<SfAccountSet> & { errors?: unknown[] }): SfAccountSet {
  const errlist: SimplefinError[] = [];
  for (const e of Array.isArray(body.errlist) ? body.errlist : []) {
    const raw = e as unknown as Record<string, unknown>;
    errlist.push({
      code: sanitize(raw.code ?? 'gen.', 40) || 'gen.',
      msg: sanitize(raw.msg ?? 'Unknown error'),
      connId: raw.conn_id ? sanitize(raw.conn_id, 120) : undefined,
      accountId: raw.account_id ? sanitize(raw.account_id, 120) : undefined,
    });
  }
  // v1's deprecated string list — only use it when errlist is absent to avoid duplicates.
  if (!Array.isArray(body.errlist) && Array.isArray(body.errors)) {
    for (const e of body.errors) errlist.push({ code: 'gen.', msg: sanitize(e) });
  }
  return {
    errlist,
    connections: Array.isArray(body.connections) ? body.connections : [],
    accounts: Array.isArray(body.accounts) ? body.accounts : [],
  };
}
