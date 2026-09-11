import { useEffect, useState } from 'react';
import type { ReserveDetail, ReserveInput } from '../../shared/types';
import { api } from '../api';
import { Dialog, ErrorNote, Loading, Swatch } from '../components/ui';
import { useApp, useData } from '../data';
import { centsToInput, dateShort, money, parseMoneyInput } from '../format';
import { personName } from '../periods';
import { href } from '../router';

export function ReservesView() {
  const { personId, people, accounts } = useApp();
  const { data, error } = useData(() => api.reserves(personId), []);
  const [editing, setEditing] = useState<ReserveDetail | 'new' | null>(null);

  if (error && !data) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const real = data.filter((r) => !r.virtual);
  const privateFunds = data.filter((r) => r.virtual);

  // Account check: how much of each holding account the reserves claim.
  const holding = new Map<string, number>();
  for (const r of real) if (r.accountId) holding.set(r.accountId, (holding.get(r.accountId) ?? 0) + r.balanceTodayCents);

  return (
    <>
      <div className="view-head">
        <h1>Reserves</h1>
        <button type="button" className="btn primary" onClick={() => setEditing('new')}>
          New reserve
        </button>
      </div>
      <p className="muted">
        Money set aside for something specific. Fund lines on the budget feed a reserve a little every day; bills on those
        lines and anything you mark “paid from this reserve” come out of it instead of the pay period.
      </p>

      {real.length === 0 ? (
        <div className="empty">
          <p>No named reserves yet. Common ones: an emergency fund, a car fund, travel.</p>
        </div>
      ) : (
        <div className="section">
          {real.map((r) => (
            <ReserveRow key={r.key} r={r} owner={personName(people, r.ownerId)} accountName={accounts.find((a) => a.id === r.accountId)} onEdit={() => setEditing(r)} />
          ))}
        </div>
      )}

      {holding.size > 0 && (
        <section className="section">
          <header>
            <h2>Where reserve money sits</h2>
          </header>
          <table className="lines">
            <thead>
              <tr>
                <th>Account</th>
                <th className="r">Bank balance</th>
                <th className="r">Claimed by reserves</th>
                <th className="r">Unclaimed</th>
              </tr>
            </thead>
            <tbody>
              {[...holding.entries()].map(([id, claimed]) => {
                const a = accounts.find((x) => x.id === id);
                const bal = a?.balanceCents ?? null;
                return (
                  <tr key={id}>
                    <td>
                      {a?.nickname || a?.name || id}
                      <div className="desc-sub">{a?.inBudget ? 'Counts toward the budget' : 'Outside the budget'}</div>
                    </td>
                    <td className="r money">{bal == null ? '–' : money(bal)}</td>
                    <td className="r money">{money(claimed)}</td>
                    <td className={`r money ${bal != null && bal - claimed < 0 ? 'neg' : ''}`}>{bal == null ? '–' : money(bal - claimed)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="small muted" style={{ marginTop: '0.5rem' }}>
            A negative unclaimed amount means the reserves say more is set aside than the account holds.
          </p>
        </section>
      )}

      {privateFunds.length > 0 && (
        <section className="section">
          <header>
            <h2>Private funds</h2>
            <p>Fund lines that save into their own pot. Pick a reserve on the line to pool it with others.</p>
          </header>
          {privateFunds.map((r) => (
            <ReserveRow key={r.key} r={r} owner={personName(people, r.ownerId)} accountName={undefined} />
          ))}
        </section>
      )}

      <ReserveDialog editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function ReserveRow({
  r,
  owner,
  accountName,
  onEdit,
}: {
  r: ReserveDetail;
  owner: string;
  accountName: { name: string; nickname: string | null; inBudget: boolean } | undefined;
  onEdit?: () => void;
}) {
  const pct = r.targetCents ? Math.min(100, (r.balanceTodayCents / r.targetCents) * 100) : null;
  return (
    <article className="reserve">
      <div>
        <h3>
          <Swatch color={r.color} />
          {r.name} <span className="owner">{owner}</span>
        </h3>
        <p className="small muted" style={{ marginTop: '0.35rem' }}>
          {r.virtual
            ? 'Held inside the in-budget accounts.'
            : accountName
              ? `In ${accountName.nickname || accountName.name}${accountName.inBudget ? ', so the cash check holds it back.' : ', outside the budget.'}`
              : 'Held inside the in-budget accounts, so the cash check holds it back.'}
        </p>
        <p className="small muted">
          {r.lines.length === 0
            ? 'No budget line feeds it yet.'
            : r.lines.map((l, i) => (
                <span key={l.itemId}>
                  {i > 0 && ', '}
                  <a href={href('budget', { edit: String(l.itemId) })}>{l.name}</a> {l.role === 'saves' ? '(saves into it)' : '(contributes)'}
                </span>
              ))}
        </p>
        {onEdit && (
          <button type="button" className="btn ghost small" onClick={onEdit} style={{ marginLeft: '-0.55rem' }}>
            Edit reserve
          </button>
        )}
      </div>
      <div>
        <div className="balance money">{money(r.balanceTodayCents)}</div>
        {r.targetCents != null && (
          <>
            <div className="target" title={`${Math.round(pct!)}% of target`}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <p className="small muted">
              {Math.round(pct!)}% of {money(r.targetCents)}
            </p>
          </>
        )}
      </div>
      <Spark r={r} />
    </article>
  );
}

function Spark({ r }: { r: ReserveDetail }) {
  const w = 220;
  const h = 56;
  const vals = r.history.map((x) => x.balanceCents);
  const max = Math.max(...vals, r.targetCents ?? 0, 1);
  const x = (i: number) => (i / (vals.length - 1)) * (w - 4) + 2;
  const y = (v: number) => h - 4 - (v / max) * (h - 8);
  const firstFuture = r.history.findIndex((p) => p.projected);
  const split = firstFuture === -1 ? vals.length : firstFuture;
  const pts = (from: number, to: number) =>
    vals
      .slice(from, to)
      .map((v, i) => `${x(i + from).toFixed(1)},${y(v).toFixed(1)}`)
      .join(' ');
  const label = `Balance by pay period, ${dateShort(r.history[0].date)} to ${dateShort(r.history[r.history.length - 1].date)}; dashed part is projected`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      <title>{label}</title>
      {r.targetCents != null && <line x1="0" x2={w} y1={y(r.targetCents)} y2={y(r.targetCents)} stroke="var(--sun)" strokeDasharray="2 3" />}
      <polyline points={pts(0, split)} fill="none" stroke={r.color ?? 'var(--verdigris)'} strokeWidth="2.25" />
      {split < vals.length && (
        <polyline points={pts(Math.max(0, split - 1), vals.length)} fill="none" stroke={r.color ?? 'var(--verdigris)'} strokeWidth="2" strokeDasharray="4 3" opacity="0.7" />
      )}
    </svg>
  );
}

const blank = (today: string): ReserveInput => ({
  name: '',
  color: '#4f6d8a',
  ownerId: null,
  accountId: null,
  targetCents: null,
  openingCents: 0,
  openingDate: today,
  notes: '',
  sort: 0,
});

function ReserveDialog({ editing, onClose }: { editing: ReserveDetail | 'new' | null; onClose: () => void }) {
  const { status, people, accounts, refresh, toast } = useApp();
  const today = status?.today ?? '';
  const [r, setR] = useState<ReserveInput>(blank(today));
  const [opening, setOpening] = useState('0.00');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setError(null);
    if (editing && editing !== 'new') {
      const { id: _i, key: _k, virtual: _v, balanceTodayCents: _b, history: _h, lines: _l, accountBalanceCents: _a, ...rest } = editing;
      setR(rest);
      setOpening(centsToInput(editing.openingCents));
      setTarget(editing.targetCents != null ? centsToInput(editing.targetCents) : '');
    } else if (editing === 'new') {
      setR(blank(today));
      setOpening('0.00');
      setTarget('');
    }
  }, [editing, today]);

  const id = editing && editing !== 'new' ? editing.id : undefined;

  async function save() {
    setError(null);
    try {
      await api.saveReserve({ ...r, openingCents: parseMoneyInput(opening) ?? 0, targetCents: parseMoneyInput(target) }, id);
      toast('Reserve saved.');
      refresh();
      onClose();
    } catch (err) {
      setError(err as Error);
    }
  }

  async function remove() {
    if (id == null || !window.confirm(`Delete “${r.name}”? Lines that feed it fall back to their own private funds.`)) return;
    await api.deleteReserve(id);
    toast('Reserve deleted.');
    refresh();
    onClose();
  }

  return (
    <Dialog open={editing != null} onClose={onClose} title={id != null ? 'Edit reserve' : 'New reserve'}>
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
            <input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} required autoFocus />
          </label>
          <label>
            Color
            <input type="color" value={r.color ?? '#4f6d8a'} onChange={(e) => setR({ ...r, color: e.target.value })} />
          </label>
        </div>
        <div className="row">
          <label>
            Balance on the start date
            <input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />
          </label>
          <label>
            Start date
            <input type="date" value={r.openingDate} onChange={(e) => setR({ ...r, openingDate: e.target.value })} required />
          </label>
          <label>
            Target (optional)
            <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="none" />
          </label>
        </div>
        <label>
          Where the money sits
          <select value={r.accountId ?? ''} onChange={(e) => setR({ ...r, accountId: e.target.value || null })}>
            <option value="">Inside the in-budget accounts (earmarked, not moved)</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nickname || a.name}
                {a.inBudget ? '' : ' (outside the budget)'}
              </option>
            ))}
          </select>
          <span className="hint">
            In a separate savings account? Feed it with an on-date line matched to the transfer. Earmarked inside checking?
            Feed it with a fund line.
          </span>
        </label>
        <label>
          Belongs to
          <select value={r.ownerId ?? ''} onChange={(e) => setR({ ...r, ownerId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Shared by the household</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Notes
          <textarea rows={2} value={r.notes} onChange={(e) => setR({ ...r, notes: e.target.value })} />
        </label>
        <ErrorNote error={error} />
        <div className="actions">
          {id != null && (
            <button type="button" className="btn ghost danger spacer" onClick={() => void remove()}>
              Delete reserve
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save reserve
          </button>
        </div>
      </form>
    </Dialog>
  );
}
