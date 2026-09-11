import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openMemoryDatabase } from '../src/server/db';
import { Repo } from '../src/server/repo';

function repo() {
  return new Repo(openMemoryDatabase());
}

describe('manual accounts', () => {
  it('creates an account entered by hand with no balance until one is logged', () => {
    const r = repo();
    const a = r.createManualAccount('Credit union savings', null, true);
    assert.equal(a.manual, true);
    assert.equal(a.inBudget, true);
    assert.equal(a.balanceCents, null);
    assert.equal(a.balanceDate, null);
  });

  it('tracks the latest balance entry as the account balance, regardless of entry order', () => {
    const r = repo();
    const a = r.createManualAccount('Credit union savings', null, true);
    r.setAccountBalance(a.id, '2026-01-01', 100000);
    r.setAccountBalance(a.id, '2026-03-01', 150000);
    r.setAccountBalance(a.id, '2026-02-01', 120000);
    const current = r.getAccount(a.id)!;
    assert.equal(current.balanceCents, 150000);
    assert.ok(current.balanceDate != null);
    assert.deepEqual(
      r.listAccountBalances(a.id).map((b) => b.date),
      ['2026-01-01', '2026-02-01', '2026-03-01'],
    );
  });

  it('replaces an existing entry rather than duplicating it when the same date is logged again', () => {
    const r = repo();
    const a = r.createManualAccount('Cash envelope', null, true);
    r.setAccountBalance(a.id, '2026-01-01', 5000);
    r.setAccountBalance(a.id, '2026-01-01', 7500);
    const entries = r.listAccountBalances(a.id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].balanceCents, 7500);
    assert.equal(r.getAccount(a.id)!.balanceCents, 7500);
  });

  it('falls back to no balance once the last entry is removed', () => {
    const r = repo();
    const a = r.createManualAccount('Cash envelope', null, true);
    r.setAccountBalance(a.id, '2026-01-01', 5000);
    const [entry] = r.listAccountBalances(a.id);
    r.deleteAccountBalance(entry.id, a.id);
    const current = r.getAccount(a.id)!;
    assert.equal(current.balanceCents, null);
    assert.equal(current.balanceDate, null);
  });

  it('lets a hand-entered account be removed, but not the ad hoc cash bucket', () => {
    const r = repo();
    const a = r.createManualAccount('Credit union savings', null, true);
    assert.equal(r.deleteManualAccount(a.id), true);
    assert.equal(r.getAccount(a.id), null);

    r.ensureManualAccount('manual:cash', 'Cash & manual entries');
    assert.equal(r.deleteManualAccount('manual:cash'), false);
    assert.notEqual(r.getAccount('manual:cash'), null);
  });

  it("won't remove a synced account", () => {
    const r = repo();
    r.upsertSimplefinAccount({
      id: 'conn:acct1',
      sfId: 'acct1',
      connId: 'conn',
      connName: 'Bank',
      name: 'Checking',
      currency: 'USD',
      balanceCents: 10000,
      availableCents: null,
      balanceDate: null,
    });
    assert.equal(r.deleteManualAccount('conn:acct1'), false);
    assert.notEqual(r.getAccount('conn:acct1'), null);
  });
});
