import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openMemoryDatabase } from '../src/server/db';
import { Repo } from '../src/server/repo';
import { claimAccessUrl, fetchAccounts, sanitize } from '../src/server/simplefin';
import { QuotaError, SyncService } from '../src/server/sync';
import { openSecret } from '../src/server/secrets';

const ACCESS = 'https://user123:s3cret@bridge.example.com/simplefin';
const b64 = (s: string) => Buffer.from(s).toString('base64');

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

describe('SimpleFIN client', () => {
  it('claims an access URL with a POST to the decoded token', async () => {
    const m = mockFetch(() => new Response(ACCESS));
    const url = await claimAccessUrl(b64('https://bridge.example.com/simplefin/claim/abc'), { fetch: m.fn });
    assert.equal(url, ACCESS);
    assert.equal(m.calls[0].init?.method, 'POST');
  });

  it('warns that a 403 claim may mean a compromised token', async () => {
    const m = mockFetch(() => new Response('', { status: 403 }));
    await assert.rejects(claimAccessUrl(b64('https://bridge.example.com/simplefin/claim/abc'), { fetch: m.fn }), /someone else may have/);
  });

  it('refuses non-HTTPS claim URLs', async () => {
    const m = mockFetch(() => new Response(ACCESS));
    await assert.rejects(claimAccessUrl(b64('http://bridge.example.com/claim/x'), { fetch: m.fn }), /HTTPS/);
  });

  it('moves credentials into a Basic header and asks for protocol v2', async () => {
    const m = mockFetch(() => Response.json({ errlist: [], connections: [], accounts: [] }));
    await fetchAccounts(ACCESS, { startDate: 100, endDate: 200, pending: true }, { fetch: m.fn });
    const u = new URL(m.calls[0].url);
    assert.equal(u.username, '');
    assert.equal(u.pathname, '/simplefin/accounts');
    assert.equal(u.searchParams.get('version'), '2');
    assert.equal(u.searchParams.get('pending'), '1');
    assert.equal(u.searchParams.get('start-date'), '100');
    const auth = (m.calls[0].init?.headers as Record<string, string>).Authorization;
    assert.equal(Buffer.from(auth.replace('Basic ', ''), 'base64').toString(), 'user123:s3cret');
  });

  it('sanitizes control characters out of error messages', () => {
    assert.equal(sanitize('bad\u0000\u001b[31m thing\n'), 'bad [31m thing');
  });
});

describe('sync', () => {
  function setup(responses: unknown[]) {
    const repo = new Repo(openMemoryDatabase());
    repo.saveSettings({ ...repo.getSettings(), payAnchor: '2026-09-04', timezone: 'America/New_York' });
    let i = 0;
    const m = mockFetch((url) => {
      if (url.includes('/claim/')) return new Response(ACCESS);
      return Response.json(responses[Math.min(i++, responses.length - 1)]);
    });
    const now = new Date('2026-09-11T15:00:00Z');
    const sync = new SyncService({ repo, fetch: m.fn, now: () => now, log: () => {}, secret: 'test-secret' });
    return { repo, sync, m };
  }

  const acct = (txns: unknown[]) => ({
    errlist: [],
    connections: [{ conn_id: 'CON-1', name: 'Demo Bank' }],
    accounts: [
      {
        id: 'ACT-1',
        name: 'Checking',
        conn_id: 'CON-1',
        currency: 'USD',
        balance: '1204.55',
        'balance-date': 1789138800,
        transactions: txns,
      },
    ],
  });

  it('stores the access URL encrypted when a secret is configured', async () => {
    const { repo, sync } = setup([acct([])]);
    await sync.claim(b64('https://bridge.example.com/simplefin/claim/abc'));
    const stored = repo.getMeta('simplefin_access')!;
    assert.ok(stored.startsWith('enc:v1:'));
    assert.equal(openSecret(repo, stored, 'test-secret'), ACCESS);
  });

  it('imports accounts and transactions, then carries a manual assignment from pending to posted', async () => {
    const { repo, sync } = setup([
      acct([{ id: 'P1', posted: 0, transacted_at: 1789052400, amount: '-42.10', description: 'GREEN LEAF MKT', pending: true }]),
      acct([{ id: 'T9', posted: 1789138800, transacted_at: 1789052400, amount: '-42.10', description: 'GREEN LEAF MARKET #12' }]),
    ]);
    await sync.claim(b64('https://bridge.example.com/simplefin/claim/abc'));
    const first = await sync.sync('manual');
    assert.equal(first.added, 1);
    const account = repo.listAccounts()[0];
    assert.equal(account.id, 'CON-1:ACT-1');
    assert.equal(account.balanceCents, 120455);

    const item = repo.createItem({
      name: 'Groceries', kind: 'expense', group: '', color: null, amountCents: 60000, cadence: 'monthly',
      anchorDate: null, dayOfMonth: 1, dayOfMonth2: null, intervalMonths: 1, startDate: null, endDate: null,
      allocation: 'spread', toleranceDays: 5, reserveOpeningCents: 0, notes: '', sort: 0, ownerId: null, reserveId: null,
    });
    repo.assignTxn('CON-1:ACT-1:P1', { itemId: item.id, kind: 'normal', assignedBy: 'manual' });

    const second = await sync.sync('manual');
    assert.equal(second.removed, 1);
    const posted = repo.getTxn('CON-1:ACT-1:T9')!;
    assert.equal(posted.itemId, item.id);
    assert.equal(posted.assignedBy, 'manual');
    assert.equal(repo.getTxn('CON-1:ACT-1:P1'), null);
  });

  it('keeps pending transactions when the bank reports the account as incomplete', async () => {
    const incomplete = acct([]);
    incomplete.errlist = [{ code: 'act.missingdata', msg: 'Incomplete', account_id: 'ACT-1' }] as never;
    const { repo, sync } = setup([
      acct([{ id: 'P1', posted: 0, transacted_at: 1789052400, amount: '-5.00', description: 'COFFEE', pending: true }]),
      incomplete,
    ]);
    await sync.claim(b64('https://bridge.example.com/simplefin/claim/abc'));
    await sync.sync('manual');
    const res = await sync.sync('manual');
    assert.equal(res.removed, 0);
    assert.ok(repo.getTxn('CON-1:ACT-1:P1'));
    assert.equal(res.errors[0].code, 'act.missingdata');
  });

  it('refuses a manual sync that would exceed the daily request budget', async () => {
    const { repo, sync } = setup([acct([])]);
    await sync.claim(b64('https://bridge.example.com/simplefin/claim/abc'));
    for (let i = 0; i < 20; i++) repo.addSyncLog({ ok: true, trigger: 'manual', requests: 1, added: 0, updated: 0, removed: 0, errors: [] });
    await assert.rejects(sync.sync('manual'), QuotaError);
  });

  it('applies rules to new transactions and never overrides manual choices', async () => {
    const { repo, sync } = setup([
      acct([
        { id: 'A', posted: 1789138800, amount: '-12.00', description: 'STREAMFLIX SUBSCRIPTION' },
        { id: 'B', posted: 1789138800, amount: '-13.00', description: 'STREAMFLIX GIFT' },
      ]),
    ]);
    const item = repo.createItem({
      name: 'Streaming', kind: 'expense', group: '', color: null, amountCents: 1200, cadence: 'monthly',
      anchorDate: null, dayOfMonth: 9, dayOfMonth2: null, intervalMonths: 1, startDate: null, endDate: null,
      allocation: 'due', toleranceDays: 5, reserveOpeningCents: 0, notes: '', sort: 0, ownerId: null, reserveId: null,
    });
    repo.createRule({
      name: '', priority: 100, field: 'any', match: 'contains', pattern: 'streamflix', accountId: null,
      direction: 'out', minCents: null, maxCents: null, itemId: item.id, reserveId: null, setKind: 'normal', enabled: true,
    });
    await sync.claim(b64('https://bridge.example.com/simplefin/claim/abc'));
    await sync.sync('manual');
    assert.equal(repo.getTxn('CON-1:ACT-1:A')!.assignedBy, 'rule');
    repo.assignTxn('CON-1:ACT-1:B', { itemId: null, kind: 'ignore', assignedBy: 'manual' });
    sync.applyRules('all');
    assert.equal(repo.getTxn('CON-1:ACT-1:B')!.kind, 'ignore');
  });
});
