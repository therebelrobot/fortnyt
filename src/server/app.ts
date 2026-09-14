import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { HTTPException } from 'hono/http-exception';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { diffDays, isISODate, localDateOf } from '../shared/dates';
import { periodByIndex, periodIndexOf, periodOf } from '../shared/recurrence';
import type { Status } from '../shared/types';
import { applyLens, assessPeriod, buildCalendar, buildLedger, buildReserveDetails, type EngineData } from './engine';
import type { Repo } from './repo';
import { ruleMatches } from './rules';
import { QuotaError, REQUEST_BUDGET, type SyncService } from './sync';
import {
  accountBalanceSchema,
  accountCreateSchema,
  accountPatchSchema,
  adjustmentSchema,
  claimSchema,
  itemSchema,
  manualTxnSchema,
  occurrenceMoveSchema,
  personSchema,
  rangeSchema,
  reserveSchema,
  ruleSchema,
  settingsSchema,
  txnPatchSchema,
} from './validate';

export interface AppDeps {
  repo: Repo;
  sync: SyncService;
  staticDir?: string;
  password?: string;
  user?: string;
  /** Pins "today" — for demos and screenshots only. */
  todayOverride?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429 | 502,
    message: string,
    readonly code = 'error',
  ) {
    super(message);
  }
}

const MAX_RANGE_DAYS = 800;

/** A date is a valid period start iff it falls on a payday of the schedule (past periods included). */
function isPeriodStart(d: string, pay: { anchor: string; intervalDays: number }): boolean {
  if (!isISODate(d)) return false;
  const diff = diffDays(d, pay.anchor);
  return diff % pay.intervalDays === 0;
}

export function createApp(deps: AppDeps) {
  const { repo, sync } = deps;
  const app = new Hono();

  const today = () => {
    if (deps.todayOverride && isISODate(deps.todayOverride)) return deps.todayOverride;
    return localDateOf(new Date(), repo.getSettings().timezone);
  };

  /** `?person=<id>` narrows every view to that person's share; absent = the whole household. */
  const engine = (c?: Context): EngineData => {
    const s = repo.getSettings();
    if (!s.payAnchor) {
      throw new HttpError(409, 'Set your pay schedule first: one real payday and how often you are paid.', 'pay_schedule_missing');
    }
    const household: EngineData = {
      pay: { anchor: s.payAnchor, intervalDays: s.payIntervalDays },
      today: today(),
      items: repo.listItems(),
      accounts: repo.listAccounts(),
      reserves: repo.listReserves(),
      txnsBetween: (f, t, o) => repo.txnsBetween(f, t, o),
      txnsForItem: (id, f, t) => repo.txnsForItem(id, f, t),
      txnsForReserve: (id, f, t) => repo.txnsForReserve(id, f, t),
      movesForItem: (id) => repo.movesForItem(id),
      adjustmentsForItem: (id) => repo.adjustmentsForItem(id),
    };
    const person = c?.req.query('person');
    if (!person || !/^\d+$/.test(person)) return household;
    if (!repo.listPeople().some((p) => p.id === Number(person))) throw new HttpError(404, 'No such person.');
    return applyLens(household, repo.listPeople(), Number(person));
  };

  const checkRefs = (r: { ownerId?: number | null; reserveId?: number | null; itemId?: number | null; accountId?: string | null }) => {
    if (r.ownerId != null && !repo.listPeople().some((p) => p.id === r.ownerId)) throw new HttpError(400, 'No such person.');
    if (r.reserveId != null && !repo.listReserves().some((x) => x.id === r.reserveId)) throw new HttpError(400, 'No such reserve.');
    if (r.itemId != null && !repo.getItem(r.itemId)) throw new HttpError(400, 'No such budget line.');
    if (r.accountId != null && !repo.getAccount(r.accountId)) throw new HttpError(400, 'No such account.');
  };

  const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<T> => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new HttpError(400, 'Request body must be JSON.');
    }
    return schema.parse(raw);
  };

  const range = (c: Context) => {
    const r = rangeSchema.parse({ from: c.req.query('from'), to: c.req.query('to') });
    if (diffDays(r.to, r.from) > MAX_RANGE_DAYS) throw new HttpError(400, `Ranges are limited to ${MAX_RANGE_DAYS} days.`);
    return r;
  };

  // --- middleware ------------------------------------------------------------

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  if (deps.password) {
    const auth = basicAuth({ username: deps.user || 'fortnyt', password: deps.password, realm: 'fortnyt' });
    app.use('*', async (c, next) => (c.req.path === '/api/health' ? next() : auth(c, next)));
  }

  app.onError((err, c) => {
    // basicAuth (and any future Hono middleware) signals auth failure by throwing an
    // HTTPException that carries the prepared 401 + WWW-Authenticate response. Without
    // this branch the 401 falls through to the generic 500 below and the browser never
    // sees the header it needs to show the credential prompt.
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof z.ZodError) {
      return c.json(
        { error: 'Some fields need attention.', code: 'invalid', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        400,
      );
    }
    if (err instanceof HttpError) return c.json({ error: err.message, code: err.code }, err.status);
    if (err instanceof QuotaError) return c.json({ error: err.message, code: 'quota' }, 429);
    console.error(err);
    return c.json({ error: err instanceof Error ? err.message : 'Unexpected error', code: 'server' }, 500);
  });

  // --- status & settings -----------------------------------------------------

  app.get('/api/status', (c) => {
    const settings = repo.getSettings();
    const t = today();
    const log = repo.recentSyncLog(1);
    const status: Status = {
      settings,
      today: t,
      currentPeriod: settings.payAnchor
        ? periodOf(t, { anchor: settings.payAnchor, intervalDays: settings.payIntervalDays }, t)
        : null,
      simplefin: {
        ...sync.connectionInfo(),
        running: sync.running,
        requests24h: sync.requests24h(),
        requestBudget: REQUEST_BUDGET,
        lastSync: log[0] ?? null,
        nextScheduledAt: sync.nextScheduledAt(),
      },
      counts: repo.counts(),
      people: repo.listPeople(),
    };
    return c.json(status);
  });

  app.put('/api/settings', async (c) => c.json(repo.saveSettings(await body(c, settingsSchema))));

  // --- items -----------------------------------------------------------------

  app.get('/api/items', (c) => c.json(repo.listItems()));

  app.post('/api/items', async (c) => {
    const input = await body(c, itemSchema);
    checkRefs(input);
    return c.json(repo.createItem(input), 201);
  });

  app.put('/api/items/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const input = await body(c, itemSchema);
    checkRefs(input);
    const updated = repo.updateItem(id, input);
    if (!updated) throw new HttpError(404, 'No such budget line.');
    return c.json(updated);
  });

  app.delete('/api/items/:id', (c) => {
    if (!repo.deleteItem(Number(c.req.param('id')))) throw new HttpError(404, 'No such budget line.');
    return c.json({ ok: true });
  });

  // --- occurrence moves --------------------------------------------------------

  app.post('/api/items/:id/moves', async (c) => {
    const itemId = Number(c.req.param('id'));
    const item = repo.getItem(itemId);
    if (!item) throw new HttpError(404, 'No such budget line.');
    if (item.allocation !== 'due' || item.kind !== 'expense') throw new HttpError(400, 'Only on-date expense lines can be rescheduled.');
    const input = await body(c, occurrenceMoveSchema);
    return c.json(repo.moveOccurrence(itemId, input.fromDate, input.toDate), 201);
  });

  app.delete('/api/items/:id/moves/:fromDate', (c) => {
    const fromDate = c.req.param('fromDate');
    if (!isISODate(fromDate)) throw new HttpError(400, 'Use a real date in YYYY-MM-DD form.');
    if (!repo.deleteMove(Number(c.req.param('id')), fromDate)) throw new HttpError(404, 'No such move.');
    return c.json({ ok: true });
  });

  // --- period adjustments ------------------------------------------------------

  app.put('/api/items/:id/adjustments/:periodStart', async (c) => {
    const itemId = Number(c.req.param('id'));
    const item = repo.getItem(itemId);
    if (!item) throw new HttpError(404, 'No such budget line.');
    if (item.kind === 'income') throw new HttpError(400, 'Income lines can’t be adjusted for a period.');
    if (item.allocation === 'reserve') throw new HttpError(400, 'Fund lines can’t be adjusted for a period.');
    const s = repo.getSettings();
    if (!s.payAnchor) throw new HttpError(409, 'Set your pay schedule first.');
    const periodStart = c.req.param('periodStart');
    if (!isPeriodStart(periodStart, { anchor: s.payAnchor, intervalDays: s.payIntervalDays })) {
      throw new HttpError(400, 'That date isn’t a payday; pick the start of a pay period.');
    }
    const input = await body(c, adjustmentSchema);
    return c.json(repo.upsertAdjustment(itemId, periodStart, input.amountCents));
  });

  app.delete('/api/items/:id/adjustments/:periodStart', (c) => {
    const periodStart = c.req.param('periodStart');
    if (!isISODate(periodStart)) throw new HttpError(400, 'Use a real date in YYYY-MM-DD form.');
    if (!repo.deleteAdjustment(Number(c.req.param('id')), periodStart)) throw new HttpError(404, 'No such adjustment.');
    return c.json({ ok: true });
  });

  app.get('/api/items/:id/adjustments', (c) => {
    const itemId = Number(c.req.param('id'));
    if (!repo.getItem(itemId)) throw new HttpError(404, 'No such budget line.');
    return c.json(repo.adjustmentsForItem(itemId));
  });

  // --- people ----------------------------------------------------------------

  app.get('/api/people', (c) => c.json(repo.listPeople()));
  app.post('/api/people', async (c) => c.json(repo.savePerson(await body(c, personSchema)), 201));
  app.put('/api/people/:id', async (c) => {
    const saved = repo.savePerson(await body(c, personSchema), Number(c.req.param('id')));
    if (!saved) throw new HttpError(404, 'No such person.');
    return c.json(saved);
  });
  app.delete('/api/people/:id', (c) => {
    if (!repo.deletePerson(Number(c.req.param('id')))) throw new HttpError(404, 'No such person.');
    return c.json({ ok: true });
  });

  // --- cash reserves ---------------------------------------------------------

  app.get('/api/reserves', (c) => c.json(buildReserveDetails(engine(c))));
  app.post('/api/reserves', async (c) => {
    const input = await body(c, reserveSchema);
    checkRefs(input);
    return c.json(repo.saveReserve(input), 201);
  });
  app.put('/api/reserves/:id', async (c) => {
    const input = await body(c, reserveSchema);
    checkRefs(input);
    const saved = repo.saveReserve(input, Number(c.req.param('id')));
    if (!saved) throw new HttpError(404, 'No such reserve.');
    return c.json(saved);
  });
  app.delete('/api/reserves/:id', (c) => {
    if (!repo.deleteReserve(Number(c.req.param('id')))) throw new HttpError(404, 'No such reserve.');
    return c.json({ ok: true });
  });

  // --- periods & views -------------------------------------------------------

  app.get('/api/assessment', (c) => {
    const data = engine(c);
    const date = c.req.query('date') ?? data.today;
    const idx = c.req.query('index');
    const period =
      idx !== undefined && /^-?\d+$/.test(idx)
        ? periodByIndex(Number(idx), data.pay, data.today)
        : periodOf(isISODate(date) ? date : data.today, data.pay, data.today);
    return c.json(assessPeriod(data, period));
  });

  app.get('/api/periods', (c) => {
    const data = engine(c);
    const around = c.req.query('around');
    const center = periodIndexOf(isISODate(around) ? around : data.today, data.pay);
    const count = Math.min(Math.max(Number(c.req.query('count') ?? 6), 1), 52);
    const out = [];
    for (let i = center - count; i <= center + count; i++) {
      const a = assessPeriod(data, periodByIndex(i, data.pay, data.today));
      out.push({ period: a.period, totals: a.totals });
    }
    return c.json(out);
  });

  app.get('/api/calendar', (c) => {
    const r = range(c);
    return c.json(buildCalendar(engine(c), r.from, r.to));
  });

  app.get('/api/ledger', (c) => {
    const r = range(c);
    return c.json(buildLedger(engine(c), r.from, r.to));
  });

  // --- accounts --------------------------------------------------------------

  app.get('/api/accounts', (c) => c.json(repo.listAccounts()));

  app.post('/api/accounts', async (c) => {
    const input = await body(c, accountCreateSchema);
    checkRefs({ ownerId: input.ownerId });
    return c.json(repo.createManualAccount(input.name, input.ownerId, input.inBudget), 201);
  });

  app.patch('/api/accounts/:id', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const patch = await body(c, accountPatchSchema);
    checkRefs({ ownerId: patch.ownerId });
    const updated = repo.updateAccount(id, patch);
    if (!updated) throw new HttpError(404, 'No such account.');
    return c.json(updated);
  });

  app.delete('/api/accounts/:id', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (id === 'manual:cash') throw new HttpError(400, 'This account holds cash entries made elsewhere in the app and can’t be removed.');
    if (!repo.deleteManualAccount(id)) throw new HttpError(404, 'No such account entered by hand.');
    return c.json({ ok: true });
  });

  app.get('/api/accounts/:id/balances', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (!repo.getAccount(id)) throw new HttpError(404, 'No such account.');
    return c.json(repo.listAccountBalances(id));
  });

  app.post('/api/accounts/:id/balances', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const account = repo.getAccount(id);
    if (!account || !account.manual) throw new HttpError(404, 'No such account entered by hand.');
    const b = await body(c, accountBalanceSchema);
    repo.setAccountBalance(id, b.date, b.balanceCents);
    return c.json(repo.getAccount(id), 201);
  });

  app.delete('/api/accounts/:id/balances/:balanceId', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (!repo.getAccount(id)) throw new HttpError(404, 'No such account.');
    repo.deleteAccountBalance(Number(c.req.param('balanceId')), id);
    return c.json(repo.getAccount(id));
  });

  // --- transactions ----------------------------------------------------------

  app.patch('/api/transactions/:id', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const existing = repo.getTxn(id);
    if (!existing) throw new HttpError(404, 'No such transaction.');
    const p = await body(c, txnPatchSchema);
    checkRefs({ itemId: p.itemId, reserveId: p.reserveId });
    repo.tx(() => {
      if (p.reset) {
        repo.assignTxn(id, { itemId: null, reserveId: null, kind: 'normal', assignedBy: null, ruleId: null });
      } else if (p.reserveId != null) {
        // Paid from / into a cash reserve replaces any budget line.
        repo.assignTxn(id, { itemId: null, reserveId: p.reserveId, kind: 'normal', assignedBy: 'manual' });
      } else if (p.itemId !== undefined || p.kind !== undefined || p.reserveId === null) {
        const kind = p.kind ?? (p.itemId != null ? 'normal' : existing.kind);
        const itemId = kind === 'normal' ? (p.itemId !== undefined ? p.itemId : existing.itemId) : null;
        repo.assignTxn(id, { itemId, reserveId: null, kind, assignedBy: 'manual' });
      }
      repo.updateTxnFields(id, { note: p.note, occurrenceDate: p.occurrenceDate });
    });
    if (p.reset) sync.applyRules('unassigned');
    return c.json(repo.getTxn(id));
  });

  app.post('/api/transactions', async (c) => {
    const t = await body(c, manualTxnSchema);
    checkRefs({ itemId: t.itemId, reserveId: t.reserveId });
    repo.ensureManualAccount('manual:cash', 'Cash & manual entries');
    return c.json(repo.createManualTxn({ ...t, accountId: 'manual:cash' }), 201);
  });

  app.delete('/api/transactions/:id', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const t = repo.getTxn(id);
    if (!t) throw new HttpError(404, 'No such transaction.');
    if (!t.manual) throw new HttpError(400, 'Only manual entries can be deleted; mark bank transactions as ignored instead.');
    repo.deleteTxn(id);
    return c.json({ ok: true });
  });

  // --- rules -----------------------------------------------------------------

  app.get('/api/rules', (c) => c.json(repo.listRules()));

  app.post('/api/rules', async (c) => {
    const input = await body(c, ruleSchema);
    checkRefs({ itemId: input.itemId, reserveId: input.reserveId, accountId: input.accountId });
    const rule = repo.createRule(input);
    const changed = sync.applyRules('all');
    return c.json({ rule, changed }, 201);
  });

  app.put('/api/rules/:id', async (c) => {
    const input = await body(c, ruleSchema);
    checkRefs({ itemId: input.itemId, reserveId: input.reserveId, accountId: input.accountId });
    const rule = repo.updateRule(Number(c.req.param('id')), input);
    if (!rule) throw new HttpError(404, 'No such rule.');
    return c.json({ rule, changed: sync.applyRules('all') });
  });

  app.delete('/api/rules/:id', (c) => {
    if (!repo.deleteRule(Number(c.req.param('id')))) throw new HttpError(404, 'No such rule.');
    return c.json({ ok: true, changed: sync.applyRules('all') });
  });

  app.post('/api/rules/preview', async (c) => {
    const r = await body(c, ruleSchema);
    const rule = { ...r, id: 0, enabled: true };
    const all = repo.txnsBetween('0000-01-01', '9999-12-31', { allAccounts: true });
    const hits = all.filter((t) => ruleMatches(rule, t));
    const manualHits = hits.filter((t) => t.assignedBy === 'manual').length;
    return c.json({ count: hits.length, manualSkipped: manualHits, sample: hits.slice(-8).reverse() });
  });

  app.post('/api/rules/apply', (c) => c.json({ changed: sync.applyRules('all') }));

  // --- SimpleFIN -------------------------------------------------------------

  app.post('/api/simplefin/claim', async (c) => {
    const { token } = await body(c, claimSchema);
    if (sync.isConnected()) throw new HttpError(409, 'Already connected. Disconnect first to use a new token.');
    try {
      await sync.claim(token);
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : String(err), 'claim_failed');
    }
    // First pull right away so the accounts list isn't empty.
    try {
      const result = await sync.sync('connect');
      return c.json({ ok: true, result });
    } catch (err) {
      return c.json({ ok: true, syncError: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/simplefin/sync', async (c) => {
    try {
      return c.json(await sync.sync('manual'));
    } catch (err) {
      if (err instanceof QuotaError) throw err;
      throw new HttpError(502, err instanceof Error ? err.message : String(err), 'sync_failed');
    }
  });

  app.delete('/api/simplefin', (c) => {
    sync.disconnect();
    return c.json({ ok: true });
  });

  app.get('/api/simplefin/log', (c) => c.json(repo.recentSyncLog(30)));

  app.all('/api/*', (c) => c.json({ error: 'Not found', code: 'not_found' }, 404));

  // --- static client ---------------------------------------------------------

  if (deps.staticDir && existsSync(path.join(deps.staticDir, 'index.html'))) {
    const root = path.relative(process.cwd(), deps.staticDir) || '.';
    const indexHtml = readFileSync(path.join(deps.staticDir, 'index.html'), 'utf8');
    app.use('/assets/*', async (c, next) => {
      await next();
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    });
    app.use('*', serveStatic({ root }));
    app.get('*', (c) => c.html(indexHtml));
  }

  return app;
}

