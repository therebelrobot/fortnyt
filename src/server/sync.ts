// Pulls SimpleFIN data into SQLite.
//
// Bridge limits (developer guide): ~24 /accounts requests per day before warnings, then the
// token gets disabled; max 90 days per request; overlap windows by ~5 days; avoid the top of
// the hour. So: scheduled syncs run at a random fixed minute, manual syncs stop at 20/day,
// every window overlaps 5 days, and long ranges are chunked into 89-day requests.

import { localDateOfEpoch, diffDays } from '../shared/dates';
import { parseCents, tryParseCents } from '../shared/money';
import type { SimplefinError, SyncLogEntry } from '../shared/types';
import type { Repo } from './repo';
import { firstMatch, sortRules } from './rules';
import { isSealed, openSecret, sealSecret } from './secrets';
import {
  accessHost,
  claimAccessUrl,
  fetchAccounts,
  sanitize,
  SimplefinHttpError,
  type FetchLike,
  type SfAccount,
} from './simplefin';

const DAY = 86_400;
const OVERLAP_DAYS = 5;
const CHUNK_DAYS = 89;
const MAX_LOOKBACK_DAYS = 366;
/** Hard ceiling across manual + scheduled requests in any rolling 24h. */
export const REQUEST_BUDGET = 20;
const ACCESS_KEY = 'simplefin_access';

export class QuotaError extends Error {}

export interface SyncDeps {
  repo: Repo;
  secret?: string;
  fetch?: FetchLike;
  allowInsecure?: boolean;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface SyncResult {
  ok: boolean;
  requests: number;
  added: number;
  updated: number;
  removed: number;
  errors: SimplefinError[];
  ruleAssigned: number;
}

export class SyncService {
  running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private deps: SyncDeps) {}

  private get repo() {
    return this.deps.repo;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private log(msg: string) {
    (this.deps.log ?? console.log)(`[sync] ${msg}`);
  }

  // --- connection ----------------------------------------------------------

  isConnected(): boolean {
    return !!this.repo.getMeta(ACCESS_KEY);
  }

  connectionInfo() {
    const stored = this.repo.getMeta(ACCESS_KEY);
    if (!stored) return { connected: false, host: null, encrypted: false };
    let host: string | null = null;
    try {
      host = accessHost(openSecret(this.repo, stored, this.deps.secret));
    } catch {
      host = null;
    }
    return { connected: true, host, encrypted: isSealed(stored) };
  }

  async claim(setupToken: string): Promise<void> {
    const accessUrl = await claimAccessUrl(setupToken, {
      fetch: this.deps.fetch,
      allowInsecure: this.deps.allowInsecure,
    });
    this.repo.setMeta(ACCESS_KEY, sealSecret(this.repo, accessUrl, this.deps.secret));
  }

  disconnect(): void {
    this.repo.setMeta(ACCESS_KEY, null);
  }

  requests24h(): number {
    return this.repo.requestsSince(new Date(this.now().getTime() - DAY * 1000).toISOString());
  }

  // --- sync ----------------------------------------------------------------

  async sync(trigger: 'manual' | 'schedule' | 'connect'): Promise<SyncResult> {
    if (this.running) throw new QuotaError('A sync is already running.');
    const stored = this.repo.getMeta(ACCESS_KEY);
    if (!stored) throw new Error('SimpleFIN is not connected.');
    const accessUrl = openSecret(this.repo, stored, this.deps.secret);

    const settings = this.repo.getSettings();
    const tz = settings.timezone;
    const nowSec = Math.floor(this.now().getTime() / 1000);
    // end-date is exclusive; a small margin covers clock skew between here and the Bridge.
    const endSec = nowSec + 3600;
    const known = this.repo.listAccounts().filter((a) => !a.manual);
    // Measured back from endSec so the default 89-day backfill is exactly one request.
    const initialStart = endSec - Math.max(1, settings.backfillDays) * DAY;
    let startSec =
      known.length === 0
        ? initialStart
        : Math.min(...known.map((a) => a.syncedThrough ?? initialStart)) - OVERLAP_DAYS * DAY;
    startSec = Math.max(startSec, nowSec - MAX_LOOKBACK_DAYS * DAY);

    const chunks: [number, number][] = [];
    for (let s = startSec; s < endSec; s += CHUNK_DAYS * DAY) chunks.push([s, Math.min(s + CHUNK_DAYS * DAY, endSec)]);

    const used = this.requests24h();
    if (used + chunks.length > REQUEST_BUDGET) {
      throw new QuotaError(
        `This sync needs ${chunks.length} SimpleFIN request(s) and ${used} of ${REQUEST_BUDGET} have been used in the last 24 hours. ` +
          'Waiting protects the connection from being disabled by the Bridge.',
      );
    }

    this.running = true;
    const result: SyncResult = { ok: true, requests: 0, added: 0, updated: 0, removed: 0, errors: [], ruleAssigned: 0 };
    try {
      const seen = new Map<string, Set<string>>();
      const newIds = new Set<string>();
      const incomplete = new Set<string>();
      const returned = new Map<string, SfAccount>();
      let generalFailure = false;

      for (const [s, e] of chunks) {
        const set = await fetchAccounts(
          accessUrl,
          { startDate: s, endDate: e, pending: true },
          { fetch: this.deps.fetch, allowInsecure: this.deps.allowInsecure },
        );
        result.requests++;
        for (const err of set.errlist) {
          if (!result.errors.some((x) => x.code === err.code && x.msg === err.msg)) result.errors.push(err);
          if (err.code.startsWith('gen.')) generalFailure = true;
        }
        const connNames = new Map(set.connections.map((c) => [c.conn_id, c.name]));

        this.repo.tx(() => {
          for (const a of set.accounts) {
            const connId = a.conn_id ?? a.org?.domain ?? 'simplefin';
            const key = `${connId}:${a.id}`;
            returned.set(key, a);
            if (set.errlist.some((x) => x.accountId === a.id || (x.connId && x.connId === a.conn_id))) incomplete.add(key);
            this.repo.upsertSimplefinAccount({
              id: key,
              sfId: a.id,
              connId: a.conn_id ?? null,
              connName: sanitize(a.conn_name ?? connNames.get(a.conn_id ?? '') ?? a.org?.name ?? '', 120) || null,
              name: sanitize(a.name, 120) || a.id,
              currency: sanitize(a.currency, 200) || 'USD',
              balanceCents: tryParseCents(a.balance),
              availableCents: tryParseCents(a['available-balance']),
              balanceDate: typeof a['balance-date'] === 'number' ? a['balance-date'] : null,
            });
            const ids = seen.get(key) ?? new Set<string>();
            seen.set(key, ids);
            for (const t of a.transactions ?? []) {
              let amount: number;
              try {
                amount = parseCents(t.amount);
              } catch {
                continue;
              }
              const when = t.transacted_at || t.posted || nowSec;
              const id = `${key}:${t.id}`;
              ids.add(id);
              const outcome = this.repo.upsertIncomingTxn({
                id,
                accountId: key,
                sfId: String(t.id),
                date: localDateOfEpoch(when, tz),
                posted: t.posted || null,
                transactedAt: t.transacted_at ?? null,
                amountCents: amount,
                description: sanitize(t.description || t.payee || 'Transaction', 300),
                payee: t.payee ? sanitize(t.payee, 200) : null,
                memo: t.memo ? sanitize(t.memo, 300) : null,
                pending: !!t.pending,
              });
              if (outcome === 'added') {
                result.added++;
                newIds.add(id);
              } else if (outcome === 'updated') result.updated++;
            }
          }
        });
      }

      // Pending transactions often come back under a new id once they post. Anything pending
      // in the window that the bank no longer returns is gone — but only trust that for
      // accounts that came back complete.
      const windowStartDate = localDateOfEpoch(startSec, tz);
      this.repo.tx(() => {
        for (const [key, ids] of seen) {
          if (incomplete.has(key) || generalFailure) continue;
          for (const p of this.repo.pendingTxnsForAccount(key)) {
            if (p.date < windowStartDate || ids.has(p.id)) continue;
            if (p.assignedBy === 'manual' || p.note) this.carryAssignment(p.id, key, p.amountCents, p.date, newIds);
            this.repo.deleteTxn(p.id);
            result.removed++;
          }
        }
        for (const key of returned.keys()) {
          const accountErr = result.errors.find((x) => x.accountId === returned.get(key)?.id);
          if (incomplete.has(key)) this.repo.setAccountSync(key, null, accountErr?.msg ?? 'Incomplete data from the bank');
          else this.repo.setAccountSync(key, nowSec, null);
        }
      });

      result.ruleAssigned = this.applyRules('unassigned');
      result.ok = !generalFailure;
      return result;
    } catch (err) {
      result.ok = false;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ code: err instanceof SimplefinHttpError ? `http.${err.status}` : 'gen.', msg: sanitize(msg) });
      throw Object.assign(err instanceof Error ? err : new Error(msg), { result });
    } finally {
      this.running = false;
      this.repo.addSyncLog({
        ok: result.ok,
        trigger,
        requests: result.requests,
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        errors: result.errors,
      });
      this.log(
        `${trigger}: ${result.requests} request(s), +${result.added} ~${result.updated} -${result.removed}, ${result.errors.length} error(s)`,
      );
    }
  }

  /** A hand-assigned pending transaction posted under a new id: move the assignment onto it. */
  private carryAssignment(fromId: string, accountId: string, amount: number, date: string, newIds: Set<string>) {
    for (const id of newIds) {
      const t = this.repo.getTxn(id);
      if (!t || t.accountId !== accountId || t.amountCents !== amount || t.pending) continue;
      if (Math.abs(diffDays(t.date, date)) > 5 || t.assignedBy === 'manual') continue;
      this.repo.copyAssignment(fromId, id);
      newIds.delete(id);
      return;
    }
  }

  // --- rules ---------------------------------------------------------------

  /**
   * 'unassigned' — only transactions with no assignment (after a sync).
   * 'all'        — every transaction not assigned by hand (after rules change). Rule-assigned
   *                transactions whose rule no longer matches are released.
   */
  applyRules(scope: 'unassigned' | 'all'): number {
    const rules = sortRules(this.repo.listRules()).filter(
      (r) => r.enabled && (r.itemId != null || r.reserveId != null || r.setKind !== 'normal'),
    );
    let changed = 0;
    this.repo.tx(() => {
      for (const t of this.repo.txnsOpenToRules()) {
        if (scope === 'unassigned' && t.assignedBy !== null) continue;
        if (scope === 'unassigned' && (t.itemId !== null || t.reserveId !== null || t.kind !== 'normal')) continue;
        const r = firstMatch(rules, t);
        if (r) {
          const itemId = r.setKind === 'normal' ? r.itemId : null;
          const reserveId = r.setKind === 'normal' && itemId == null ? r.reserveId : null;
          if (
            t.itemId !== itemId ||
            t.reserveId !== reserveId ||
            t.kind !== r.setKind ||
            t.ruleId !== r.id ||
            t.assignedBy !== 'rule'
          ) {
            this.repo.assignTxn(t.id, { itemId, reserveId, kind: r.setKind, assignedBy: 'rule', ruleId: r.id });
            changed++;
          }
        } else if (t.assignedBy === 'rule') {
          this.repo.assignTxn(t.id, { itemId: null, reserveId: null, kind: 'normal', assignedBy: null, ruleId: null });
          changed++;
        }
      }
    });
    return changed;
  }

  // --- scheduler -----------------------------------------------------------

  syncMinute(): number {
    let m = Number(this.repo.getMeta('sync_minute'));
    if (!Number.isInteger(m) || m < 1 || m > 58) {
      m = 1 + Math.floor(Math.random() * 58);
      this.repo.setMeta('sync_minute', String(m));
    }
    return m;
  }

  /** Earliest moment the next scheduled sync may run (any sync, manual included, resets the clock). */
  private dueAt(): number {
    const hours = Math.max(1, this.repo.getSettings().syncIntervalHours);
    const last = this.repo.lastSyncAt();
    return last ? new Date(last).getTime() + hours * 3_600_000 - 300_000 : 0;
  }

  /** For display: the first :MM (the random sync minute) at or after dueAt. */
  nextScheduledAt(): string | null {
    if (!this.isConnected()) return null;
    const d = new Date(Math.max(this.now().getTime(), this.dueAt()));
    const minute = this.syncMinute();
    if (d.getUTCMinutes() > minute || (d.getUTCMinutes() === minute && d.getUTCSeconds() > 0)) {
      d.setUTCHours(d.getUTCHours() + 1);
    }
    d.setUTCMinutes(minute, 0, 0);
    return d.toISOString();
  }

  startScheduler(): void {
    if (this.timer) return;
    this.syncMinute();
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running || !this.isConnected()) return;
    const now = this.now();
    // A 3-minute window tolerates setInterval drift; dueAt() prevents a second run in the same window.
    const m = now.getUTCMinutes();
    const target = this.syncMinute();
    if (m < target || m > target + 2 || now.getTime() < this.dueAt()) return;
    if (this.requests24h() >= REQUEST_BUDGET) return;
    try {
      await this.sync('schedule');
    } catch (err) {
      this.log(`scheduled sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export type { SyncLogEntry };
