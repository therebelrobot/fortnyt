import { useEffect, useState, type ReactNode } from 'react';
import { addDays } from '../../shared/dates';
import { paydaysBetween, timesPerYear } from '../../shared/recurrence';
import type { Allocation, Cadence, Item, ItemInput } from '../../shared/types';
import { api } from '../api';
import { Dialog, ErrorNote, Money, Swatch } from '../components/ui';
import { useApp } from '../data';
import { ALLOCATION_LABEL, cadenceSummary, centsToInput, dateDay, money, parseMoneyInput } from '../format';
import { personName } from '../periods';
import { navigate, useRoute } from '../router';

export function BudgetView({ firstRun }: { firstRun?: boolean }) {
  const { items, status, people, reserves } = useApp();
  const route = useRoute();
  const [editing, setEditing] = useState<Item | 'new-income' | 'new-expense' | null>(null);
  const interval = status?.settings.payIntervalDays ?? 14;

  useEffect(() => {
    const id = Number(route.params.get('edit'));
    if (id) {
      const item = items.find((i) => i.id === id);
      if (item) setEditing(item);
    }
  }, [route.params, items]);

  const income = items.filter((i) => i.kind === 'income');
  const expenses = items.filter((i) => i.kind === 'expense');
  const groups = new Map<string, Item[]>();
  for (const i of expenses) groups.set(i.group || 'Other', [...(groups.get(i.group || 'Other') ?? []), i]);
  const perPeriod = (i: Item) => Math.round((i.amountCents * timesPerYear(i.cadence, i.intervalMonths, interval)) / (365.25 / interval));
  const sumPer = (list: Item[]) => list.reduce((s, i) => s + perPeriod(i), 0);
  const reserveName = new Map(reserves.map((r) => [r.id, r.name]));

  const rows = (list: Item[]) =>
    list.map((i) => (
      <tr key={i.id} onClick={() => setEditing(i)} style={{ cursor: 'pointer' }}>
        <td>
          <div className="name">
            <Swatch color={i.color} />
            <span>{i.name}</span>
          </div>
          <div className="desc-sub">
            {cadenceSummary(i)}
            {i.kind === 'expense' && `, ${ALLOCATION_LABEL[i.allocation].toLowerCase()}`}
            {i.reserveId != null && `, into ${reserveName.get(i.reserveId) ?? 'a reserve'}`}
          </div>
        </td>
        <td className="hide-sm">{people.length > 0 && <span className="owner">{personName(people, i.ownerId)}</span>}</td>
        <td className="r">
          <Money cents={i.amountCents} />
        </td>
        <td className="r muted hide-sm">
          <Money cents={perPeriod(i)} />
        </td>
      </tr>
    ));

  return (
    <>
      <div className="view-head">
        <h1>{firstRun ? 'Set up your budget' : 'Budget'}</h1>
      </div>
      <PaySchedule firstRun={firstRun} />

      {!firstRun && (
        <>
          <section className="section">
            <header>
              <h2>Money in</h2>
              <button type="button" className="btn small" onClick={() => setEditing('new-income')}>
                Add income
              </button>
            </header>
            {income.length === 0 ? (
              <p className="empty">Add each paycheck as its own line. Use “Every payday” for the one that sets the schedule.</p>
            ) : (
              <table className="lines">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th className="hide-sm" />
                    <th className="r">Amount</th>
                    <th className="r hide-sm" title="Average per pay period over a year">
                      ≈ per period
                    </th>
                  </tr>
                </thead>
                <tbody>{rows(income)}</tbody>
              </table>
            )}
          </section>

          <section className="section">
            <header>
              <h2>Money out</h2>
              <button type="button" className="btn small" onClick={() => setEditing('new-expense')}>
                Add a line
              </button>
            </header>
            {expenses.length === 0 ? (
              <p className="empty">Start with rent, the regular bills, and an envelope for groceries.</p>
            ) : (
              <table className="lines">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th className="hide-sm" />
                    <th className="r">Amount</th>
                    <th className="r hide-sm">≈ per period</th>
                  </tr>
                </thead>
                <tbody>
                  {[...groups.entries()].map(([g, list]) => (
                    <GroupBlock key={g} label={g} total={sumPer(list)}>
                      {rows(list)}
                    </GroupBlock>
                  ))}
                </tbody>
              </table>
            )}
            {items.length > 0 && (
              <p className="totals-line">
                <span>
                  On average a pay period brings in <strong className="money">{money(sumPer(income))}</strong> and the plan
                  spends <strong className="money">{money(sumPer(expenses))}</strong>, leaving{' '}
                  <strong className="money">{money(sumPer(income) - sumPer(expenses))}</strong>. Individual periods vary with
                  where bill dates land.
                </span>
              </p>
            )}
          </section>
        </>
      )}

      <ItemDialog
        editing={editing}
        onClose={() => {
          setEditing(null);
          if (route.params.get('edit')) navigate('budget', {}, true);
        }}
      />
    </>
  );
}

function GroupBlock({ label, total, children }: { label: string; total: number; children: ReactNode }) {
  return (
    <>
      <tr className="subhead">
        <td colSpan={3}>{label}</td>
        <td className="r hide-sm money">{money(total)}</td>
      </tr>
      {children}
    </>
  );
}

function PaySchedule({ firstRun }: { firstRun?: boolean }) {
  const { status, refresh, toast } = useApp();
  const s = status?.settings;
  const [anchor, setAnchor] = useState(s?.payAnchor ?? status?.today ?? '');
  const [interval, setInterval] = useState(String(s?.payIntervalDays ?? 14));
  const [error, setError] = useState<Error | null>(null);
  if (!s || !status) return null;

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(anchor);
  const upcoming = valid ? paydaysBetween(status.today, addDays(status.today, 60), { anchor, intervalDays: Number(interval) }).slice(0, 4) : [];

  async function save() {
    setError(null);
    try {
      await api.saveSettings({ ...s!, payAnchor: anchor, payIntervalDays: Number(interval) });
      toast('Pay schedule saved.');
      refresh();
      if (firstRun) navigate('budget');
    } catch (err) {
      setError(err as Error);
    }
  }

  return (
    <section>
      <header className="sec-head">
        <h2>Pay schedule</h2>
      </header>
      <form
        className="form"
        style={{ padding: '0.75rem 0 0' }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="hint">
          Every pay period starts on a payday and runs until the day before the next one. Monthly bills land in whichever period
          contains their date. This is the household schedule; each person can have their own in Setup.
        </p>
        <div className="row">
          <label>
            Any real payday
            <input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} required />
          </label>
          <label>
            Paid every
            <select value={interval} onChange={(e) => setInterval(e.target.value)}>
              <option value="14">2 weeks</option>
              <option value="7">week</option>
              <option value="28">4 weeks</option>
            </select>
          </label>
          <div className="field">
            Next paydays
            <span style={{ color: 'var(--ink)', fontWeight: 400, paddingTop: '0.45rem' }}>
              {upcoming.map(dateDay).join(', ') || '–'}
            </span>
          </div>
        </div>
        <ErrorNote error={error} />
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          <button type="submit" className="btn primary">
            {firstRun ? 'Save and continue' : 'Save pay schedule'}
          </button>
        </div>
      </form>
    </section>
  );
}

const ALLOCATIONS: { value: Allocation; title: string; body: string }[] = [
  {
    value: 'due',
    title: 'On its date',
    body: 'The whole amount lands in the pay period that contains the due date. Rent, phone, subscriptions.',
  },
  {
    value: 'spread',
    title: 'Envelope',
    body: 'Spread evenly per day. Each period gets its share and spending counts in the period it happens. Groceries, gas, fun money.',
  },
  {
    value: 'reserve',
    title: 'Fund',
    body: 'Every period saves its share into a reserve; the bill is paid from the reserve, not from the period it lands in. Insurance, annual renewals.',
  },
];

const blankItem = (kind: 'income' | 'expense'): ItemInput => ({
  name: '',
  kind,
  group: '',
  color: kind === 'income' ? '#4f8a4b' : '#2f6f73',
  amountCents: 0,
  cadence: kind === 'income' ? 'paycheck' : 'monthly',
  anchorDate: null,
  dayOfMonth: 1,
  dayOfMonth2: 15,
  intervalMonths: 1,
  startDate: null,
  endDate: null,
  allocation: 'due',
  toleranceDays: 5,
  reserveOpeningCents: 0,
  notes: '',
  sort: 0,
  ownerId: null,
  reserveId: null,
});

function ItemDialog({ editing, onClose }: { editing: Item | 'new-income' | 'new-expense' | null; onClose: () => void }) {
  const { items, people, reserves, status, refresh, toast } = useApp();
  const [f, setF] = useState<ItemInput>(blankItem('expense'));
  const [amount, setAmount] = useState('');
  const [opening, setOpening] = useState('0.00');
  const [error, setError] = useState<Error | null>(null);
  const id = editing && typeof editing === 'object' ? editing.id : undefined;

  useEffect(() => {
    setError(null);
    if (!editing) return;
    if (typeof editing === 'object') {
      const { id: _i, createdAt: _c, ...rest } = editing;
      setF(rest);
      setAmount(centsToInput(editing.amountCents));
      setOpening(centsToInput(editing.reserveOpeningCents));
    } else {
      setF({ ...blankItem(editing === 'new-income' ? 'income' : 'expense'), anchorDate: status?.today ?? null });
      setAmount('');
      setOpening('0.00');
    }
  }, [editing, status?.today]);

  const set = <K extends keyof ItemInput>(k: K, v: ItemInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const groups = [...new Set(items.map((i) => i.group).filter(Boolean))];
  const needsDate = ['weekly', 'biweekly', 'yearly', 'once'].includes(f.cadence);

  async function save() {
    setError(null);
    const cents = parseMoneyInput(amount);
    if (cents == null) {
      setError(new Error('Enter an amount, for example 1400.00.'));
      return;
    }
    const input: ItemInput = {
      ...f,
      amountCents: Math.abs(cents),
      reserveOpeningCents: parseMoneyInput(opening) ?? 0,
      allocation: f.kind === 'income' ? 'due' : f.allocation,
      reserveId: f.kind === 'income' || f.allocation === 'spread' ? null : f.reserveId,
      anchorDate: needsDate || f.cadence === 'monthly' ? f.anchorDate : null,
    };
    try {
      if (id != null) await api.updateItem(id, input);
      else await api.createItem(input);
      toast(`${input.name} saved.`);
      refresh();
      onClose();
    } catch (err) {
      setError(err as Error);
    }
  }

  async function remove() {
    if (id == null || !window.confirm(`Delete “${f.name}”? Its transactions stay but become “not in the budget”.`)) return;
    await api.deleteItem(id);
    toast(`${f.name} deleted.`);
    refresh();
    onClose();
  }

  return (
    <Dialog open={editing != null} onClose={onClose} wide title={id != null ? `Edit ${f.name}` : f.kind === 'income' ? 'New income' : 'New budget line'}>
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
            <input value={f.name} onChange={(e) => set('name', e.target.value)} required autoFocus />
          </label>
          <label>
            Amount
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
          </label>
          <label>
            Color
            <input type="color" value={f.color ?? '#2f6f73'} onChange={(e) => set('color', e.target.value)} />
          </label>
        </div>

        <div className="row">
          <label>
            How often
            <select value={f.cadence} onChange={(e) => set('cadence', e.target.value as Cadence)}>
              <option value="paycheck">Every payday</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Every two weeks (own schedule)</option>
              <option value="semimonthly">Twice a month</option>
              <option value="monthly">Monthly, or every few months</option>
              <option value="yearly">Yearly</option>
              <option value="once">Once</option>
            </select>
          </label>
          {(f.cadence === 'monthly' || f.cadence === 'semimonthly') && (
            <label>
              {f.cadence === 'semimonthly' ? 'First day' : 'Day of the month'}
              <input
                type="number"
                min={1}
                max={31}
                value={f.dayOfMonth ?? 1}
                onChange={(e) => set('dayOfMonth', Number(e.target.value))}
                title="31 means the last day of every month"
              />
            </label>
          )}
          {f.cadence === 'semimonthly' && (
            <label>
              Second day
              <input type="number" min={1} max={31} value={f.dayOfMonth2 ?? 15} onChange={(e) => set('dayOfMonth2', Number(e.target.value))} />
            </label>
          )}
          {f.cadence === 'monthly' && (
            <label>
              Every
              <select value={f.intervalMonths} onChange={(e) => set('intervalMonths', Number(e.target.value))}>
                <option value={1}>month</option>
                <option value={2}>2 months</option>
                <option value={3}>3 months</option>
                <option value={6}>6 months</option>
                <option value={12}>12 months</option>
              </select>
            </label>
          )}
          {(needsDate || (f.cadence === 'monthly' && f.intervalMonths > 1)) && (
            <label>
              {f.cadence === 'once' ? 'Date' : 'A date it falls on'}
              <input type="date" value={f.anchorDate ?? ''} onChange={(e) => set('anchorDate', e.target.value || null)} required />
            </label>
          )}
        </div>

        {f.kind === 'expense' && (
          <fieldset className="choices" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field" style={{ marginBottom: '0.35rem' }}>
              How it lands in pay periods
            </legend>
            {ALLOCATIONS.map((a) => (
              <label key={a.value} className="choice">
                <input type="radio" name="allocation" checked={f.allocation === a.value} onChange={() => set('allocation', a.value)} />
                <strong>{a.title}</strong>
                <span>{a.body}</span>
              </label>
            ))}
          </fieldset>
        )}

        {f.kind === 'expense' && f.allocation !== 'spread' && (
          <div className="row">
            <label className="grow">
              {f.allocation === 'reserve' ? 'Save into' : 'Payments go into a reserve'}
              <select value={f.reserveId ?? ''} onChange={(e) => set('reserveId', e.target.value ? Number(e.target.value) : null)}>
                <option value="">{f.allocation === 'reserve' ? 'Its own private fund' : 'No, it’s just a bill'}</option>
                {reserves.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            {f.allocation === 'reserve' && f.reserveId == null && (
              <label>
                Already saved
                <input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />
              </label>
            )}
          </div>
        )}

        <div className="row">
          <label>
            Group
            <input list="groups" value={f.group} onChange={(e) => set('group', e.target.value)} placeholder="Home, Bills, Everyday…" />
            <datalist id="groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
          {people.length > 0 && (
            <label>
              Responsible
              <select value={f.ownerId ?? ''} onChange={(e) => set('ownerId', e.target.value ? Number(e.target.value) : null)}>
                <option value="">Shared (split by share %)</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(f.kind === 'income' || f.allocation === 'due') && (
            <label title="A matching transaction this many days before or after the date counts for it — even across a period boundary.">
              Match window (± days)
              <input type="number" min={0} max={31} value={f.toleranceDays} onChange={(e) => set('toleranceDays', Number(e.target.value))} />
            </label>
          )}
        </div>

        <div className="row">
          <label>
            Starts (optional)
            <input type="date" value={f.startDate ?? ''} onChange={(e) => set('startDate', e.target.value || null)} />
          </label>
          <label>
            Ends (optional)
            <input type="date" value={f.endDate ?? ''} onChange={(e) => set('endDate', e.target.value || null)} />
          </label>
        </div>
        <label>
          Notes
          <textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>

        <ErrorNote error={error} />
        <div className="actions">
          {id != null && (
            <button type="button" className="btn ghost danger spacer" onClick={() => void remove()}>
              Delete line
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save line
          </button>
        </div>
      </form>
    </Dialog>
  );
}
