import { useEffect, useState } from 'react';
import { diffDays, eachDay } from '../../shared/dates';
import { periodByIndex } from '../../shared/recurrence';
import type { Assessment, ExpenseLine, Txn } from '../../shared/types';
import { api } from '../api';
import { AssignSelect, Dialog, ErrorNote, Loading, Money, StepNav, SunGlyph, Swatch, Tag } from '../components/ui';
import { RuleDialog } from '../components/RuleDialog';
import { useApp, useData } from '../data';
import { centsToInput, dateDay, dateShort, money, parseMoneyInput, rangeLabel } from '../format';
import { shiftPeriod } from '../periods';
import { href, navigate } from '../router';

export function PeriodView({ params }: { params: URLSearchParams }) {
  const { status, pay, personId } = useApp();
  const date = params.get('d') ?? status?.today;
  const { data, error } = useData(() => api.assessment(date ?? undefined, personId), [date]);
  const [ruleFrom, setRuleFrom] = useState<Txn | null>(null);

  if (error && !data) return <ErrorNote error={error} />;
  if (!data || !pay || !status) return <Loading />;
  const a = data;
  const go = (by: number) => navigate('period', { d: shiftPeriod(a.period.start, a.lens.pay, by) });

  return (
    <>
      <div className="view-head">
        <StepNav
          label={rangeLabel(a.period.start, a.period.end)}
          onPrev={() => go(-1)}
          onNext={() => go(1)}
          onToday={() => navigate('period')}
          isToday={a.period.status === 'current'}
        />
        <p className="muted small">
          {a.lens.personId != null ? `${a.lens.name}’s share. ` : ''}
          {a.period.status === 'current'
            ? `Day ${diffDays(a.today, a.period.start) + 1} of ${diffDays(a.period.end, a.period.start) + 1}.`
            : a.period.status === 'past'
              ? 'This period is closed.'
              : 'This period hasn’t started. Everything here is the plan.'}
        </p>
      </div>

      <Hero a={a} />
      <Ribbon a={a} />
      <Accounts />

      {a.uncategorizedCount > 0 && (
        <div className="banner">
          <span>
            {a.uncategorizedCount} transaction{a.uncategorizedCount === 1 ? '' : 's'} in this period{' '}
            {a.uncategorizedCount === 1 ? 'isn’t' : 'aren’t'} on a budget line yet, so{' '}
            {a.uncategorizedCount === 1 ? 'it counts' : 'they count'} as unplanned.
          </span>
          <a className="btn small" href="#unplanned">
            Sort them
          </a>
        </div>
      )}

      <div className="cols section">
        <Income a={a} />
        <Expenses a={a} />
      </div>

      {a.reserves.length > 0 && <Reserves a={a} />}

      <Unplanned a={a} onRule={setRuleFrom} />
      <RuleDialog open={!!ruleFrom} onClose={() => setRuleFrom(null)} fromTxn={ruleFrom} />
    </>
  );
}

function Hero({ a }: { a: Assessment }) {
  const t = a.totals;
  const over = t.leftoverCents < 0;
  return (
    <section className={`hero ${over ? 'over' : ''}`} aria-live="polite">
      <p className="hero-line">
        <span className="hero-figure">{money(Math.abs(t.leftoverCents))}</span>
        {over
          ? 'more is going out than coming in this pay period.'
          : a.period.status === 'past'
            ? 'was left over, not spoken for.'
            : 'isn’t spoken for yet this pay period.'}
      </p>
      <p className="hero-sub">
        Of <strong>{money(t.incomeCountedCents + t.unplannedIncomeCents)}</strong> coming in,{' '}
        <strong>{money(t.committedCents)}</strong> is spoken for by the plan
        {t.unplannedSpendCents > 0 && (
          <>
            {' '}
            and <strong>{money(t.unplannedSpendCents)}</strong> went to things outside it
          </>
        )}
        {t.reserveShortfallCents > 0 && (
          <>
            ; a reserve came up <strong>{money(t.reserveShortfallCents)}</strong> short
          </>
        )}
        .{' '}
        {t.planLeftoverCents !== t.leftoverCents && <>The plan alone left {money(t.planLeftoverCents)}.</>}
      </p>
      {a.cash && (
        <p className="cash">
          The in-budget accounts hold <strong>{money(a.cash.balanceCents)}</strong>
          {a.cash.upcomingIncomeCents > 0 && <>, with {money(a.cash.upcomingIncomeCents)} still expected</>}. After{' '}
          {money(a.cash.remainingCents)} still owed this period and {money(a.cash.reserveHeldCents)} held in reserves,{' '}
          <strong>{money(a.cash.freeCents)}</strong> is actually free right now.
        </p>
      )}
    </section>
  );
}

function Ribbon({ a }: { a: Assessment }) {
  const days = [...eachDay(a.period.start, a.period.end)];
  const byDate = new Map<string, { color: string | null; open: boolean }[]>();
  for (const l of [...a.income, ...a.expenses]) {
    if (!l.date) continue;
    const open = l.status === 'upcoming' || l.status === 'expected' || l.status === 'overdue' || l.status === 'late';
    byDate.set(l.date, [...(byDate.get(l.date) ?? []), { color: l.color, open }]);
  }
  return (
    <nav className="ribbon" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }} aria-label="Days in this period">
      {days.map((d) => (
        <a
          key={d}
          href={href('calendar', { view: 'period', d, day: d })}
          className={d === a.today ? 'today' : d < a.today ? 'past' : ''}
          title={dateDay(d)}
        >
          <span>{dateShort(d).replace(/^\D+\s/, '')}</span>
          {d === a.period.payday ? <SunGlyph /> : <span style={{ height: 15 }} />}
          <span className="dots">
            {(byDate.get(d) ?? []).map((x, i) => (
              <span key={i} className={`dot ${x.open ? 'open' : ''}`} style={{ background: x.color ?? 'var(--ink-3)', ['--c' as string]: x.color ?? 'var(--ink-3)' }} />
            ))}
          </span>
        </a>
      ))}
    </nav>
  );
}

function Accounts() {
  const { accounts } = useApp();
  if (accounts.length === 0) return null;
  const rows = [...accounts].sort((x, y) => (x.nickname || x.name).localeCompare(y.nickname || y.name));
  return (
    <section className="section">
      <header className="sec-head">
        <h2>All accounts</h2>
        <p>Every account, at its current balance.</p>
      </header>
      <table className="lines">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col" className="r">
              Balance
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.id}>
              <td>
                {x.nickname || x.name}
                <div className="desc-sub">
                  {x.inBudget ? 'Counts toward the budget' : 'Outside the budget'}
                  {x.lastError ? ` · ${x.lastError}` : ''}
                </div>
              </td>
              <td className="r">{x.balanceCents == null ? '–' : <Money cents={x.balanceCents} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Income({ a }: { a: Assessment }) {
  return (
    <section>
      <header className="sec-head">
        <h2>Coming in</h2>
      </header>
      {a.income.length === 0 && a.unplanned.incomeCents === 0 ? (
        <p className="empty">No income lands in this period.</p>
      ) : (
        <table className="lines">
          <thead>
            <tr>
              <th>Line</th>
              <th className="r hide-sm">Expected</th>
              <th className="r">Counted</th>
            </tr>
          </thead>
          <tbody>
            {a.income.map((l) => (
              <tr key={l.key}>
                <td>
                  <div className="name">
                    <Swatch color={l.color} />
                    <span>{l.name}</span>
                  </div>
                  <div className="desc-sub">
                    {l.date ? dateDay(l.date) : 'Off schedule'} <Tag status={l.status} />
                  </div>
                </td>
                <td className="r hide-sm">
                  <Money cents={l.expectedCents} />
                </td>
                <td className="r">
                  <Money cents={l.countedCents} />
                </td>
              </tr>
            ))}
            {a.unplanned.incomeCents > 0 && (
              <tr>
                <td>Other money in</td>
                <td className="r hide-sm">–</td>
                <td className="r">
                  <Money cents={a.unplanned.incomeCents} />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Expenses({ a }: { a: Assessment }) {
  const groups: [string, ExpenseLine[]][] = [
    ['On their dates', a.expenses.filter((l) => l.allocation === 'due')],
    ['Envelopes', a.expenses.filter((l) => l.allocation === 'spread')],
    ['Funds (saved into reserves)', a.expenses.filter((l) => l.allocation === 'reserve')],
  ];
  return (
    <section>
      <header className="sec-head">
        <h2>Going out</h2>
      </header>
      <table className="lines">
        <thead>
          <tr>
            <th>Line</th>
            <th className="r hide-sm">Plan</th>
            <th className="r hide-sm">Spent</th>
            <th className="r" title="What the leftover math uses for this line right now">
              Counts as
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map(([label, lines]) =>
            lines.length === 0 ? null : (
              <FragmentRows key={label} label={label} lines={lines} a={a} />
            ),
          )}
          {a.unplanned.spendCents > 0 && (
            <tr>
              <td>
                <a href="#unplanned">Not in the budget</a>
              </td>
              <td className="r hide-sm">–</td>
              <td className="r hide-sm">
                <Money cents={a.unplanned.spendCents} />
              </td>
              <td className="r">
                <Money cents={a.unplanned.spendCents} />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function FragmentRows({ label, lines, a }: { label: string; lines: ExpenseLine[]; a: Assessment }) {
  return (
    <>
      <tr className="subhead">
        <td colSpan={4}>{label}</td>
      </tr>
      {lines.map((l) => {
        const pct = l.budgetCents > 0 ? Math.min(100, (l.actualCents / l.budgetCents) * 100) : 0;
        return (
          <tr key={l.key} className={l.status === 'deferred' ? 'deferred' : ''}>
            <td>
              <div className="name">
                <Swatch color={l.color} />
                <span>{l.name}</span>
              </div>
              <div className="desc-sub">
                {l.date ? `${dateDay(l.date)} ` : ''}
                <Tag status={l.status} />
                {l.carriedOver && <> · from an earlier period, still unpaid</>}
                {l.movedFrom && <> · moved from {dateDay(l.movedFrom)}</>}
                {l.movedTo && <> · moved to {dateDay(l.movedTo)}, doesn’t count here anymore</>}
                {l.fundBalanceCents != null && <> reserve holds {money(l.fundBalanceCents)}</>}
                {l.adjustedCents != null && (
                  <>
                    {' '}
                    · adjusted to <Money cents={l.adjustedCents} /> this period
                  </>
                )}
                {l.allocation === 'due' && <MoveAction l={l} a={a} />}
                {l.allocation !== 'reserve' && <AdjustAction l={l} a={a} />}
              </div>
              {l.allocation === 'spread' && (
                <div className={`meter ${l.actualCents > l.budgetCents ? 'over' : ''}`} title={`${Math.round(pct)}% used`}>
                  <span style={{ width: `${pct}%` }} />
                </div>
              )}
            </td>
            <td className="r hide-sm">
              <Money cents={l.budgetCents} />
              {l.adjustedCents != null && l.baseBudgetCents != null && (
                <s className="muted small" style={{ marginLeft: 6 }}>
                  {money(l.baseBudgetCents)}
                </s>
              )}
            </td>
            <td className="r hide-sm">
              <Money cents={l.actualCents} />
            </td>
            <td className="r">
              <Money cents={l.committedCents} />
            </td>
          </tr>
        );
      })}
    </>
  );
}

function MoveAction({ l, a }: { l: ExpenseLine; a: Assessment }) {
  const { refresh, toast } = useApp();
  const [busy, setBusy] = useState(false);
  if (!l.date) return null;

  async function move() {
    setBusy(true);
    try {
      const nextPayday = periodByIndex(a.period.index + 1, a.lens.pay, a.today).start;
      await api.moveOccurrence(l.itemId, l.date!, nextPayday);
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // A deferred line's own date *is* the move's fromDate; a moved-in line carries it separately.
  const undoFrom = l.movedTo ? l.date : l.movedFrom;

  async function undo() {
    setBusy(true);
    try {
      await api.undoMove(l.itemId, undoFrom!);
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (undoFrom) {
    return (
      <>
        {' · '}
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => void undo()}>
          Undo move
        </button>
      </>
    );
  }
  if (l.status !== 'upcoming' && l.status !== 'overdue') return null;
  return (
    <>
      {' · '}
      <button type="button" className="btn ghost small" disabled={busy} onClick={() => void move()}>
        Move to next period →
      </button>
    </>
  );
}

function AdjustAction({ l, a }: { l: ExpenseLine; a: Assessment }) {
  const { refresh, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(amountCents: number) {
    setBusy(true);
    try {
      await api.setAdjustment(l.itemId, a.period.start, amountCents);
      refresh();
      toast(`${l.name} adjusted for this period.`);
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.removeAdjustment(l.itemId, a.period.start);
      refresh();
      toast(`${l.name} is back to its regular budget for this period.`);
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {' · '}
      <button type="button" className="btn ghost small" onClick={() => setOpen(true)}>
        Adjust for this period
      </button>
      <AdjustDialog l={l} a={a} open={open} onClose={() => setOpen(false)} busy={busy} onSave={save} onRemove={remove} />
    </>
  );
}

function AdjustDialog({
  l,
  a,
  open,
  onClose,
  busy,
  onSave,
  onRemove,
}: {
  l: ExpenseLine;
  a: Assessment;
  open: boolean;
  onClose: () => void;
  busy: boolean;
  onSave: (amountCents: number) => void;
  onRemove: () => void;
}) {
  // The base for this period: the engine reports it on the line (item amount for due lines,
  // the daily-rate sum for envelopes).
  const base = l.baseBudgetCents ?? l.budgetCents;
  const [text, setText] = useState(centsToInput(l.adjustedCents ?? base));
  // Re-sync the input whenever the dialog opens, so it always shows the current effective amount.
  useEffect(() => {
    if (open) setText(centsToInput(l.adjustedCents ?? base));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, l.key]);
  const cents = parseMoneyInput(text);
  const delta = cents != null ? cents - base : null;

  return (
    <Dialog open={open} onClose={onClose} title={`Adjust ${l.name} for ${rangeLabel(a.period.start, a.period.end)}`}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (cents != null) void onSave(cents);
        }}
      >
        <p className="hint">
          Regular budget for this period: <s>{money(base)}</s>
        </p>
        <label>
          Budget for this period
          <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} required autoFocus />
        </label>
        {cents != null && delta != null && delta !== 0 && (
          <p className="hint" aria-live="polite">
            {delta < 0
              ? `This releases ${money(-delta)} for this period.`
              : `This adds ${money(delta)} to this period’s plan.`}
          </p>
        )}
        <div className="actions">
          {l.adjustedCents != null && (
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void onRemove()}>
              Remove adjustment
            </button>
          )}
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || cents == null}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Reserves({ a }: { a: Assessment }) {
  return (
    <section className="section">
      <header>
        <h2>Reserves</h2>
        <p>
          <a href={href('reserves')}>All reserves</a>
        </p>
      </header>
      <table className="lines">
        <thead>
          <tr>
            <th>Reserve</th>
            <th className="r hide-sm">Start</th>
            <th className="r hide-sm">In</th>
            <th className="r hide-sm">Out</th>
            <th className="r">End</th>
          </tr>
        </thead>
        <tbody>
          {a.reserves.map((r) => (
            <tr key={r.key}>
              <td>
                <div className="name">
                  <Swatch color={r.color} />
                  <span>{r.name}</span>
                </div>
                {r.shortfallCents > 0 && (
                  <div className="desc-sub" style={{ color: 'var(--berry)' }}>
                    Came up {money(r.shortfallCents)} short; that amount counts against this period.
                  </div>
                )}
              </td>
              <td className="r hide-sm">
                <Money cents={r.startCents} />
              </td>
              <td className="r hide-sm">
                <Money cents={r.inCents} />
              </td>
              <td className="r hide-sm">
                <Money cents={r.outCents} />
              </td>
              <td className="r">
                <strong>
                  <Money cents={r.endCents} />
                </strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Unplanned({ a, onRule }: { a: Assessment; onRule: (t: Txn) => void }) {
  const ids = new Set(a.unplanned.txnIds);
  const txns = a.transactions.filter((t) => ids.has(t.id)).sort((x, y) => (x.date < y.date ? 1 : -1));
  return (
    <section className="section" id="unplanned">
      <header>
        <h2>Not in the budget</h2>
        <p>Assign these to a line, a reserve, or mark them as transfers. A rule does it automatically next time.</p>
      </header>
      {txns.length === 0 ? (
        <p className="empty">Everything this period is on a budget line.</p>
      ) : (
        <table className="lines stack">
          <tbody>
            {txns.map((t) => (
              <tr key={t.id}>
                <td className="num small hide-sm">{dateShort(t.date)}</td>
                <td>
                  {t.description} {t.pending && <Tag status="pending" />}
                </td>
                <td className="assign-cell">
                  <AssignSelect txn={t} onRule={onRule} />
                </td>
                <td className="r">
                  <Money cents={t.amountCents} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

