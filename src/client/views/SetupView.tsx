import { useEffect, useState } from 'react';
import type { Account, AccountInput, Person, PersonInput, Rule } from '../../shared/types';
import { api } from '../api';
import { Dialog, ErrorNote, Money, Swatch } from '../components/ui';
import { RuleDialog } from '../components/RuleDialog';
import { useApp, useData } from '../data';
import { dateShort, money, parseMoneyInput } from '../format';

export function SetupView() {
  return (
    <>
      <div className="view-head">
        <h1>Setup</h1>
      </div>
      <Connection />
      <Accounts />
      <People />
      <Rules />
      <Preferences />
    </>
  );
}

// ---------------------------------------------------------------------------

function Connection() {
  const { status, refresh, toast } = useApp();
  const log = useData(() => api.syncLog(), []);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  if (!status) return null;
  const sf = status.simplefin;

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(done);
      refresh();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <header>
        <h2>Bank connection</h2>
        <p>Through SimpleFIN Bridge. Read-only: nothing here can move money.</p>
      </header>
      {!sf.connected ? (
        <form
          className="form"
          style={{ padding: '0.75rem 0 0' }}
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.claim(token), 'Connected. First sync done.').then(() => setToken(''));
          }}
        >
          <ol className="steps">
            <li>
              In the SimpleFIN Bridge (<a href="https://beta-bridge.simplefin.org/" target="_blank" rel="noreferrer">beta-bridge.simplefin.org</a>),
              connect your banks, then create a new app connection. It gives you a Setup Token.
            </li>
            <li>Paste the token below. It works once: fortnyt trades it for a private access key and stores that instead.</li>
          </ol>
          <label>
            Setup Token
            <textarea rows={3} value={token} onChange={(e) => setToken(e.target.value)} required spellCheck={false} />
          </label>
          <ErrorNote error={error} />
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>
      ) : (
        <>
          <dl className="kv">
            <dt>Connected to</dt>
            <dd>{sf.host ?? 'SimpleFIN'}</dd>
            <dt>Stored</dt>
            <dd>{sf.encrypted ? 'Encrypted with FORTNYT_SECRET' : 'Unencrypted. Set FORTNYT_SECRET and reconnect to encrypt it.'}</dd>
            <dt>Requests, last 24 h</dt>
            <dd>
              {sf.requests24h} of {sf.requestBudget} (the Bridge disables tokens that go far past 24 a day)
            </dd>
            <dt>Last sync</dt>
            <dd>
              {sf.lastSync
                ? `${new Date(sf.lastSync.at).toLocaleString()}: ${sf.lastSync.ok ? 'OK' : 'had problems'}, ${sf.lastSync.added} new, ${sf.lastSync.updated} changed`
                : 'Never'}
            </dd>
            <dt>Next automatic sync</dt>
            <dd>{sf.nextScheduledAt ? new Date(sf.nextScheduledAt).toLocaleString() : 'Off'}</dd>
          </dl>
          {sf.lastSync && sf.lastSync.errors.length > 0 && (
            <div className="error-note" style={{ marginTop: '0.75rem' }}>
              <p>The bank connection reported:</p>
              <ul>
                {sf.lastSync.errors.map((e, i) => (
                  <li key={i}>
                    {e.msg} <span className="muted">({e.code})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ErrorNote error={error} />
          <div className="toolbar" style={{ marginTop: '1rem' }}>
            <button type="button" className="btn primary" disabled={busy || sf.running} onClick={() => void run(() => api.sync(), 'Synced.')}>
              {busy || sf.running ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              type="button"
              className="btn ghost danger"
              onClick={() => {
                if (window.confirm('Disconnect SimpleFIN? Transactions already imported stay. You will need a new Setup Token to reconnect.'))
                  void run(() => api.disconnect(), 'Disconnected.');
              }}
            >
              Disconnect
            </button>
          </div>
          {log.data && log.data.length > 1 && (
            <details style={{ marginTop: '1rem' }}>
              <summary className="small">Sync history</summary>
              <table className="lines small">
                <tbody>
                  {log.data.map((l) => (
                    <tr key={l.id}>
                      <td>{new Date(l.at).toLocaleString()}</td>
                      <td>{l.trigger}</td>
                      <td>{l.ok ? 'OK' : 'Problems'}</td>
                      <td className="r num">
                        {l.requests} req, +{l.added} ~{l.updated} −{l.removed}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function Accounts() {
  const { accounts, reserves, people, refresh, toast } = useApp();
  const [adding, setAdding] = useState(false);
  const [balanceEditing, setBalanceEditing] = useState<Account | null>(null);
  const patch = async (id: string, p: Parameters<typeof api.patchAccount>[1]) => {
    try {
      await api.patchAccount(id, p);
      refresh();
    } catch (err) {
      toast((err as Error).message);
    }
  };
  const holdingName = (id: string | null) => {
    if (!id) return null;
    const a = accounts.find((x) => x.id === id);
    return a ? (a.nickname || a.name) + (a.inBudget ? '' : ' (outside the budget)') : null;
  };
  return (
    <section className="section">
      <header>
        <h2>Accounts</h2>
        <button type="button" className="btn small" onClick={() => setAdding(true)}>
          Add account
        </button>
      </header>
      <p className="small muted" style={{ marginTop: '0.5rem' }}>
        Turn off accounts that aren’t day-to-day money (long-term savings, investments). Their transactions still show in the
        ledger. Cash reserves are listed here too, so balances read like one list — edit a reserve itself on the Reserves page.
      </p>
      {accounts.length === 0 && reserves.length === 0 ? (
        <p className="empty">Nothing yet. Connect a bank above, or add an account by hand.</p>
      ) : (
        <table className="lines">
          <thead>
            <tr>
              <th>Account</th>
              <th className="r">Balance</th>
              {people.length > 0 && <th>Belongs to</th>}
              <th>Counts toward budget</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>
                  <input
                    defaultValue={a.nickname ?? a.name}
                    aria-label={`Name for ${a.name}`}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (a.nickname ?? a.name)) void patch(a.id, { nickname: v && v !== a.name ? v : null });
                    }}
                  />
                  <div className="desc-sub">
                    {a.connName ?? (a.manual ? 'Entered by hand' : '')}
                    {a.lastError && <span style={{ color: 'var(--berry)' }}> {a.lastError}</span>}
                  </div>
                </td>
                <td className="r">
                  {a.balanceCents != null ? <Money cents={a.balanceCents} /> : '–'}
                  {a.manual && a.id !== 'manual:cash' && (
                    <div>
                      <button type="button" className="btn ghost small" onClick={() => setBalanceEditing(a)}>
                        Update balance
                      </button>
                    </div>
                  )}
                </td>
                {people.length > 0 && (
                  <td>
                    <select
                      value={a.ownerId ?? ''}
                      onChange={(e) => void patch(a.id, { ownerId: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">Joint</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
                <td>
                  <input
                    type="checkbox"
                    checked={a.inBudget}
                    onChange={(e) => void patch(a.id, { inBudget: e.target.checked })}
                    aria-label={`${a.name} counts toward the budget`}
                  />
                </td>
              </tr>
            ))}
            {reserves.map((r) => (
              <tr key={r.key} className="muted">
                <td>
                  <div className="name">
                    <Swatch color={r.color} />
                    <span>{r.name}</span>
                  </div>
                  <div className="desc-sub">Cash reserve · {holdingName(r.accountId) ?? 'earmarked inside budget accounts'}</div>
                </td>
                <td className="r">
                  <Money cents={r.balanceTodayCents} />
                </td>
                {people.length > 0 && <td>{people.find((p) => p.id === r.ownerId)?.name ?? 'Joint'}</td>}
                <td className="small">Reserve</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <AccountDialog open={adding} onClose={() => setAdding(false)} />
      <BalanceDialog account={balanceEditing} onClose={() => setBalanceEditing(null)} />
    </section>
  );
}

function AccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { people, refresh, toast } = useApp();
  const [a, setA] = useState<AccountInput>({ name: '', ownerId: null, inBudget: true });
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (open) {
      setA({ name: '', ownerId: null, inBudget: true });
      setError(null);
    }
  }, [open]);

  async function save() {
    setError(null);
    try {
      await api.createAccount(a);
      toast(`${a.name} added.`);
      refresh();
      onClose();
    } catch (err) {
      setError(err as Error);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add an account">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="hint">
          For a bank fortnyt can’t sync — one the Bridge doesn’t reach, or one you’d rather not connect. Its balance is a
          history you enter by hand, not a live feed.
        </p>
        <label>
          Name
          <input value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} required autoFocus />
        </label>
        <div className="row">
          {people.length > 0 && (
            <label>
              Belongs to
              <select value={a.ownerId ?? ''} onChange={(e) => setA({ ...a, ownerId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Joint</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={a.inBudget} onChange={(e) => setA({ ...a, inBudget: e.target.checked })} />
            Counts toward budget
          </label>
        </div>
        <ErrorNote error={error} />
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Add account
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function BalanceDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const { refresh, toast } = useApp();
  const balances = useData(() => (account ? api.accountBalances(account.id) : Promise.resolve([])), [account?.id]);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (account) {
      setDate(new Date().toISOString().slice(0, 10));
      setAmount('');
      setError(null);
    }
  }, [account?.id]);

  async function add() {
    if (!account) return;
    setError(null);
    const cents = parseMoneyInput(amount);
    if (cents == null) {
      setError(new Error('Enter a balance, for example 1200.00.'));
      return;
    }
    try {
      await api.setAccountBalance(account.id, { date, balanceCents: cents });
      setAmount('');
      refresh();
    } catch (err) {
      setError(err as Error);
    }
  }

  async function removeEntry(id: number) {
    if (!account) return;
    await api.deleteAccountBalance(account.id, id);
    refresh();
  }

  async function removeAccount() {
    if (!account || !window.confirm(`Remove ${account.name}? Its balance history goes with it.`)) return;
    try {
      await api.deleteAccount(account.id);
      toast(`${account.name} removed.`);
      refresh();
      onClose();
    } catch (err) {
      toast((err as Error).message);
    }
  }

  return (
    <Dialog open={account != null} onClose={onClose} title={account ? `${account.name} balance` : 'Balance'}>
      {account && (
        <>
          <form
            className="form"
            style={{ padding: '0.75rem 1.25rem 0' }}
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <p className="hint">Log the balance as of a date. The most recent one is the account’s current balance.</p>
            <div className="row">
              <label>
                Date
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </label>
              <label>
                Balance
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
              </label>
            </div>
            <ErrorNote error={error} />
            <div className="actions" style={{ justifyContent: 'flex-start' }}>
              <button type="submit" className="btn primary">
                Add balance
              </button>
            </div>
          </form>
          {balances.data && balances.data.length > 0 && (
            <table className="lines small" style={{ margin: '0 1.25rem 1rem', width: 'calc(100% - 2.5rem)' }}>
              <tbody>
                {[...balances.data].reverse().map((b) => (
                  <tr key={b.id}>
                    <td>{dateShort(b.date)}</td>
                    <td className="r">
                      <Money cents={b.balanceCents} />
                    </td>
                    <td className="r">
                      <button type="button" className="btn ghost small" onClick={() => void removeEntry(b.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="actions" style={{ padding: '0 1.25rem 1.25rem' }}>
            <button type="button" className="btn ghost danger" onClick={() => void removeAccount()}>
              Remove account
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

function People() {
  const { people } = useApp();
  const [editing, setEditing] = useState<Person | 'new' | null>(null);
  const total = people.reduce((s, p) => s + p.sharePct, 0);
  return (
    <section className="section">
      <header>
        <h2>People</h2>
        <button type="button" className="btn small" onClick={() => setEditing('new')}>
          Add a person
        </button>
      </header>
      <p className="small muted" style={{ marginTop: '0.5rem' }}>
        Lines, accounts, and reserves can belong to one person or be shared. Shared ones split by each person’s share. Pick a
        person under “Showing” in the sidebar to see only their share of everything.
      </p>
      {people.length === 0 ? (
        <p className="empty">Just you? Nothing to set up. Add people when more than one person shares the budget.</p>
      ) : (
        <>
          <table className="lines">
            <tbody>
              {people.map((p) => (
                <tr key={p.id} onClick={() => setEditing(p)} style={{ cursor: 'pointer' }}>
                  <td>
                    <div className="name">
                      <Swatch color={p.color} />
                      <span>{p.name}</span>
                    </div>
                  </td>
                  <td>{p.sharePct}% of shared costs</td>
                  <td className="muted small">
                    {p.payAnchor && p.payIntervalDays ? `Own pay periods from ${dateShort(p.payAnchor)}` : 'Household pay periods'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {Math.round(total) !== 100 && (
            <p className="error-note" style={{ marginTop: '0.75rem' }}>
              Shares add up to {total}%, not 100%. Shared costs will be over- or under-counted across people’s views.
            </p>
          )}
        </>
      )}
      <PersonDialog editing={editing} onClose={() => setEditing(null)} />
    </section>
  );
}

function PersonDialog({ editing, onClose }: { editing: Person | 'new' | null; onClose: () => void }) {
  const { people, refresh, toast } = useApp();
  const [p, setP] = useState<PersonInput>({ name: '', color: '#2f6f73', sharePct: 50, payAnchor: null, payIntervalDays: null, sort: 0 });
  const [error, setError] = useState<Error | null>(null);
  const id = editing && editing !== 'new' ? editing.id : undefined;
  useEffect(() => {
    setError(null);
    if (editing && editing !== 'new') {
      const { id: _i, ...rest } = editing;
      setP(rest);
    } else if (editing === 'new') {
      setP({ name: '', color: '#8a5a8c', sharePct: people.length ? Math.max(0, 100 - people.reduce((s, x) => s + x.sharePct, 0)) : 100, payAnchor: null, payIntervalDays: null, sort: people.length });
    }
  }, [editing, people]);

  async function save() {
    setError(null);
    try {
      await api.savePerson({ ...p, payIntervalDays: p.payAnchor ? (p.payIntervalDays ?? 14) : null }, id);
      toast(`${p.name} saved.`);
      refresh();
      onClose();
    } catch (err) {
      setError(err as Error);
    }
  }
  async function remove() {
    if (id == null || !window.confirm(`Remove ${p.name}? Their lines, accounts, and reserves become shared.`)) return;
    await api.deletePerson(id);
    refresh();
    onClose();
  }

  return (
    <Dialog open={editing != null} onClose={onClose} title={id != null ? `Edit ${p.name}` : 'Add a person'}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="row">
          <label className="grow">
            Name
            <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} required autoFocus />
          </label>
          <label>
            Color
            <input type="color" value={p.color ?? '#2f6f73'} onChange={(e) => setP({ ...p, color: e.target.value })} />
          </label>
        </div>
        <label>
          Share of shared costs (%)
          <input type="number" min={0} max={100} step={0.5} value={p.sharePct} onChange={(e) => setP({ ...p, sharePct: Number(e.target.value) })} />
          <span className="hint">Applies to shared lines, joint accounts, and shared reserves.</span>
        </label>
        <div className="row">
          <label>
            Own payday (optional)
            <input type="date" value={p.payAnchor ?? ''} onChange={(e) => setP({ ...p, payAnchor: e.target.value || null })} />
          </label>
          <label>
            Paid every
            <select value={p.payIntervalDays ?? 14} onChange={(e) => setP({ ...p, payIntervalDays: Number(e.target.value) })} disabled={!p.payAnchor}>
              <option value={14}>2 weeks</option>
              <option value={7}>week</option>
              <option value={28}>4 weeks</option>
            </select>
          </label>
        </div>
        <p className="hint">
          With an own payday, this person’s view uses their pay periods. Paid monthly or twice a month? Leave it empty: their
          paychecks are ordinary income lines and they use the household periods.
        </p>
        <ErrorNote error={error} />
        <div className="actions">
          {id != null && (
            <button type="button" className="btn ghost danger spacer" onClick={() => void remove()}>
              Remove person
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save person
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

function Rules() {
  const { items, reserves, refresh, toast } = useApp();
  const rules = useData(() => api.rules(), []);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const target = (r: Rule) =>
    r.setKind === 'transfer'
      ? 'Transfer (doesn’t count)'
      : r.setKind === 'ignore'
        ? 'Ignore'
        : r.itemId != null
          ? items.find((i) => i.id === r.itemId)?.name ?? 'a line'
          : `Paid from ${reserves.find((x) => x.id === r.reserveId)?.name ?? 'a reserve'}`;
  return (
    <section className="section">
      <header>
        <h2>Rules</h2>
        <div className="toolbar">
          <button
            type="button"
            className="btn small ghost"
            onClick={() => void api.applyRules().then((r) => (toast(`${r.changed} transaction${r.changed === 1 ? '' : 's'} updated.`), refresh()))}
          >
            Re-run all rules
          </button>
          <button type="button" className="btn small" onClick={() => setEditing('new')}>
            Add a rule
          </button>
        </div>
      </header>
      {!rules.data || rules.data.length === 0 ? (
        <p className="empty">No rules yet. The quickest way to make one: “Make a rule” next to any transaction.</p>
      ) : (
        <table className="lines">
          <tbody>
            {rules.data.map((r) => (
              <tr key={r.id} className={r.enabled ? '' : 'excluded'}>
                <td className="num small muted">{r.priority}</td>
                <td>
                  {r.match === 'regex' ? 'matches' : r.match === 'exact' ? 'is' : r.match === 'starts' ? 'starts with' : 'contains'}{' '}
                  <strong>{r.pattern}</strong>
                  {r.direction !== 'any' && <span className="muted"> (money {r.direction})</span>}
                  {(r.minCents != null || r.maxCents != null) && (
                    <span className="muted">
                      {' '}
                      {r.minCents != null ? `from ${money(r.minCents)}` : ''} {r.maxCents != null ? `up to ${money(r.maxCents)}` : ''}
                    </span>
                  )}
                </td>
                <td>{target(r)}</td>
                <td className="r">
                  <button type="button" className="btn ghost small" onClick={() => setEditing(r)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn ghost small danger"
                    onClick={() => {
                      if (window.confirm('Delete this rule? Transactions it assigned go back to “not in the budget” unless another rule matches.'))
                        void api.deleteRule(r.id).then(() => refresh());
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <RuleDialog open={editing != null} onClose={() => setEditing(null)} rule={editing && editing !== 'new' ? editing : null} />
    </section>
  );
}

// ---------------------------------------------------------------------------

function Preferences() {
  const { status, refresh, toast } = useApp();
  const [tz, setTz] = useState(status?.settings.timezone ?? '');
  const [hours, setHours] = useState(String(status?.settings.syncIntervalHours ?? 6));
  const [backfill, setBackfill] = useState(String(status?.settings.backfillDays ?? 89));
  const [currency, setCurrency] = useState(status?.settings.currency ?? 'USD');
  const [error, setError] = useState<Error | null>(null);
  if (!status) return null;
  return (
    <section className="section">
      <header>
        <h2>Preferences</h2>
      </header>
      <form
        className="form"
        style={{ padding: '0.75rem 0 0' }}
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          api
            .saveSettings({ ...status.settings, timezone: tz, syncIntervalHours: Number(hours), backfillDays: Number(backfill), currency })
            .then(() => (toast('Preferences saved.'), refresh()))
            .catch((err: Error) => setError(err));
        }}
      >
        <div className="row">
          <label>
            Time zone
            <input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="America/New_York" />
            <span className="hint">Decides which calendar day a bank transaction lands on.</span>
          </label>
          <label>
            Currency
            <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
          </label>
        </div>
        <div className="row">
          <label>
            Sync every (hours)
            <input type="number" min={2} max={24} value={hours} onChange={(e) => setHours(e.target.value)} />
            <span className="hint">Every 6 hours is 4 requests a day; the Bridge allows about 24.</span>
          </label>
          <label>
            History on first sync (days)
            <input type="number" min={1} max={366} value={backfill} onChange={(e) => setBackfill(e.target.value)} />
            <span className="hint">89 days is one request. Each further 89 days is one more.</span>
          </label>
        </div>
        <ErrorNote error={error} />
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          <button type="submit" className="btn primary">
            Save preferences
          </button>
        </div>
      </form>
    </section>
  );
}
