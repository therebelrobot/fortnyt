import { useState } from 'react';
import { addDays, addMonths, monthEnd, monthStart } from '../../shared/dates';
import { periodOf } from '../../shared/recurrence';
import type { PlannedEntry, Txn, TxnKind } from '../../shared/types';
import { api } from '../api';
import { AssignSelect, Dialog, ErrorNote, ItemOptions, Loading, Money, Segmented, Tag } from '../components/ui';
import { RuleDialog } from '../components/RuleDialog';
import { useApp, useData } from '../data';
import { dateLong, money, parseMoneyInput } from '../format';
import { navigate } from '../router';

type Filter = 'all' | 'unassigned' | 'planned' | 'excluded';

type Row =
  | { type: 'txn'; date: string; txn: Txn }
  | { type: 'planned'; date: string; p: PlannedEntry };

export function LedgerView({ params }: { params: URLSearchParams }) {
  const { status, pay, personId, accounts, refresh } = useApp();
  const today = status?.today ?? '';
  const current = pay ? periodOf(today, pay, today) : null;
  const from = params.get('from') ?? current?.start ?? today;
  const to = params.get('to') ?? current?.end ?? today;
  const filter = (params.get('filter') ?? 'all') as Filter;
  const account = params.get('account') ?? '';
  const [q, setQ] = useState('');
  const [ruleFrom, setRuleFrom] = useState<Txn | null>(null);
  const [adding, setAdding] = useState(false);

  const { data, error } = useData(() => api.ledger(from, to, personId), [from, to]);
  const set = (next: Record<string, string | undefined>) =>
    navigate('ledger', { from, to, filter: filter === 'all' ? undefined : filter, account: account || undefined, ...next }, true);

  if (!pay || !status) return <Loading />;

  const presets = (() => {
    const last = periodOf(addDays(current!.start, -1), pay, today);
    const lastMonth = addMonths(monthStart(today), -1);
    return [
      { label: 'This period', from: current!.start, to: current!.end },
      { label: 'Last period', from: last.start, to: last.end },
      { label: 'This month', from: monthStart(today), to: monthEnd(today) },
      { label: 'Last month', from: lastMonth, to: monthEnd(lastMonth) },
    ];
  })();

  const accountName = new Map(accounts.map((a) => [a.id, a.nickname || a.name]));
  const inBudget = new Map(accounts.map((a) => [a.id, a.inBudget]));
  const needle = q.trim().toLowerCase();

  let rows: Row[] = [];
  if (data) {
    const txns = data.transactions.filter((t) => {
      if (account && t.accountId !== account) return false;
      if (needle && !t.description.toLowerCase().includes(needle)) return false;
      const excluded = t.kind !== 'normal' || inBudget.get(t.accountId) === false;
      if (filter === 'unassigned') return !excluded && t.itemId == null && t.reserveId == null;
      if (filter === 'excluded') return excluded;
      if (filter === 'planned') return false;
      return true;
    });
    rows = txns.map((t) => ({ type: 'txn' as const, date: t.date, txn: t }));
    if (filter === 'all' || filter === 'planned') {
      rows.push(
        ...data.planned
          .filter((p) => !needle || p.name.toLowerCase().includes(needle))
          .filter(() => !account)
          .map((p) => ({ type: 'planned' as const, date: p.date, p })),
      );
    }
    rows.sort((a, b) => (a.date === b.date ? (a.type === 'planned' ? -1 : 1) : a.date < b.date ? 1 : -1));
  }

  const counted = rows.filter(
    (r): r is Extract<Row, { type: 'txn' }> => r.type === 'txn' && r.txn.kind === 'normal' && inBudget.get(r.txn.accountId) !== false,
  );
  const moneyIn = counted.filter((r) => r.txn.amountCents > 0).reduce((s, r) => s + r.txn.amountCents, 0);
  const moneyOut = counted.filter((r) => r.txn.amountCents < 0).reduce((s, r) => s + r.txn.amountCents, 0);

  let lastDate = '';
  return (
    <>
      <div className="view-head">
        <h1>Ledger</h1>
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          Add a cash entry
        </button>
      </div>

      <div className="toolbar">
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`btn small ${p.from === from && p.to === to ? 'primary' : ''}`}
            onClick={() => set({ from: p.from, to: p.to })}
          >
            {p.label}
          </button>
        ))}
        <input type="date" value={from} aria-label="From" onChange={(e) => e.target.value && set({ from: e.target.value })} />
        <input type="date" value={to} aria-label="To" onChange={(e) => e.target.value && set({ to: e.target.value })} />
      </div>
      <div className="toolbar" style={{ marginTop: '0.75rem' }}>
        <Segmented<Filter>
          label="Show"
          value={filter}
          onChange={(v) => set({ filter: v === 'all' ? undefined : v })}
          options={[
            { value: 'all', label: 'Everything' },
            { value: 'unassigned', label: 'Needs a line' },
            { value: 'planned', label: 'Still planned' },
            { value: 'excluded', label: 'Not counted' },
          ]}
        />
        <select value={account} onChange={(e) => set({ account: e.target.value || undefined })} aria-label="Account">
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.nickname || a.name}
            </option>
          ))}
        </select>
        <input type="search" placeholder="Search descriptions" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {personId != null && (
        <p className="small muted" style={{ marginTop: '0.75rem' }}>
          Amounts are this person’s share: shared lines and joint accounts count at their share percentage. The full bank amount
          shows underneath when it differs.
        </p>
      )}

      <ErrorNote error={error} />
      {!data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="empty">Nothing matches these filters.</p>
      ) : (
        <table className="lines stack" style={{ marginTop: '1rem' }}>
          <tbody>
            {rows.flatMap((r) => {
              const out = [];
              if (r.date !== lastDate) {
                lastDate = r.date;
                out.push(
                  <tr key={`d-${r.date}`} className="ledger-date">
                    <td colSpan={3}>{dateLong(r.date)}</td>
                  </tr>,
                );
              }
              if (r.type === 'planned') {
                out.push(
                  <tr key={r.p.key} className="planned">
                    <td>
                      <div className="desc">{r.p.name}</div>
                      <div className="desc-sub">From the budget, not yet matched to a transaction</div>
                    </td>
                    <td className="assign-cell">
                      <Tag status={r.p.status} />
                    </td>
                    <td className="r">
                      <Money cents={r.p.kind === 'income' ? r.p.amountCents : -r.p.amountCents} />
                    </td>
                  </tr>,
                );
              } else {
                const t = r.txn;
                const excluded = t.kind !== 'normal' || inBudget.get(t.accountId) === false;
                out.push(
                  <tr key={t.id} className={excluded ? 'excluded' : ''}>
                    <td>
                      <div>
                        {t.description} {t.pending && <Tag status="pending" />}
                      </div>
                      <div className="desc-sub">
                        {accountName.get(t.accountId) ?? t.accountId}
                        {inBudget.get(t.accountId) === false && ' (outside the budget)'}
                        {t.manual && (
                          <>
                            {' '}
                            <button
                              type="button"
                              className="btn ghost small danger"
                              onClick={() => void api.deleteTxn(t.id).then(refresh)}
                            >
                              Delete entry
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="assign-cell">
                      {inBudget.get(t.accountId) === false ? (
                        <span className="small">Account is outside the budget</span>
                      ) : (
                        <AssignSelect txn={t} onRule={setRuleFrom} />
                      )}
                    </td>
                    <td className="r">
                      <Money cents={t.amountCents} />
                      {t.fullAmountCents != null && <div className="desc-sub">of {money(t.fullAmountCents)}</div>}
                    </td>
                  </tr>,
                );
              }
              return out;
            })}
          </tbody>
        </table>
      )}

      {data && (
        <p className="totals-line">
          <span>
            In: <strong className="money">{money(moneyIn)}</strong>
          </span>
          <span>
            Out: <strong className="money">{money(moneyOut)}</strong>
          </span>
          <span>
            Net: <strong className="money">{money(moneyIn + moneyOut, { sign: true })}</strong>
          </span>
          <span>Transfers, ignored entries, accounts outside the budget, and planned rows are not in these totals.</span>
        </p>
      )}

      <RuleDialog open={!!ruleFrom} onClose={() => setRuleFrom(null)} fromTxn={ruleFrom} />
      <ManualEntry open={adding} onClose={() => setAdding(false)} today={today} />
    </>
  );
}

function ManualEntry({ open, onClose, today }: { open: boolean; onClose: () => void; today: string }) {
  const { items, reserves, refresh, toast } = useApp();
  const [date, setDate] = useState(today);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'out' | 'in'>('out');
  const [target, setTarget] = useState('none');
  const [error, setError] = useState<Error | null>(null);

  async function save() {
    setError(null);
    const cents = parseMoneyInput(amount);
    if (cents == null || cents === 0) {
      setError(new Error('Enter an amount, for example 12.50.'));
      return;
    }
    const kind: TxnKind = target.startsWith('kind:') ? (target.slice(5) as TxnKind) : 'normal';
    try {
      await api.addTxn({
        date,
        description,
        amountCents: direction === 'out' ? -Math.abs(cents) : Math.abs(cents),
        itemId: target.startsWith('item:') ? Number(target.slice(5)) : null,
        reserveId: target.startsWith('pot:') ? Number(target.slice(4)) : null,
        kind,
        note: '',
      });
      toast('Entry added.');
      refresh();
      setDescription('');
      setAmount('');
      onClose();
    } catch (err) {
      setError(err as Error);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add a cash entry">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="hint">For spending the bank never sees, like cash at a market. It lands in “Cash &amp; manual entries”.</p>
        <div className="row">
          <label>
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label>
            Amount
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
          </label>
          <label>
            Direction
            <select value={direction} onChange={(e) => setDirection(e.target.value as 'out' | 'in')}>
              <option value="out">Money out</option>
              <option value="in">Money in</option>
            </select>
          </label>
        </div>
        <label>
          Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} required />
        </label>
        <label>
          Budget line
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <ItemOptions items={items} reserves={reserves} />
          </select>
        </label>
        <ErrorNote error={error} />
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Add entry
          </button>
        </div>
      </form>
    </Dialog>
  );
}
