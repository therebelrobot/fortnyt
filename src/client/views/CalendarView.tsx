import { useState, type ReactNode } from 'react';
import { addDays, addMonths, monthEnd, monthStart, startOfWeek } from '../../shared/dates';
import { periodOf } from '../../shared/recurrence';
import type { CalendarDay, PlannedEntry, Txn } from '../../shared/types';
import { api } from '../api';
import { AssignSelect, ErrorNote, Loading, Money, Segmented, StepNav, SunGlyph, Tag } from '../components/ui';
import { RuleDialog } from '../components/RuleDialog';
import { useApp, useData } from '../data';
import { dateLong, dateShort, money, monthLabel, rangeLabel, weekday } from '../format';
import { href, navigate } from '../router';

type Mode = 'week' | 'period' | 'month';

export function CalendarView({ params }: { params: URLSearchParams }) {
  const { status, pay, personId, items } = useApp();
  const mode = (['week', 'period', 'month'].includes(params.get('view') ?? '') ? params.get('view') : 'month') as Mode;
  const today = status?.today ?? '';
  const d = params.get('d') ?? today;
  const [selected, setSelected] = useState<string | null>(params.get('day'));
  const [ruleFrom, setRuleFrom] = useState<Txn | null>(null);

  // Visible range per mode. Month pads out to whole weeks so the grid stays rectangular.
  let from = d;
  let to = d;
  let label = '';
  let focusFrom = d;
  let focusTo = d;
  if (pay) {
    if (mode === 'week') {
      from = startOfWeek(d);
      to = addDays(from, 6);
      focusFrom = from;
      focusTo = to;
      label = rangeLabel(from, to);
    } else if (mode === 'period') {
      const p = periodOf(d, pay, today);
      from = p.start;
      to = p.end;
      focusFrom = from;
      focusTo = to;
      label = rangeLabel(from, to);
    } else {
      focusFrom = monthStart(d);
      focusTo = monthEnd(d);
      from = startOfWeek(focusFrom);
      to = addDays(startOfWeek(focusTo), 6);
      label = monthLabel(focusFrom);
    }
  }

  const { data, error } = useData(() => api.calendar(from, to, personId), [from, to]);

  const go = (by: number) => {
    const next = mode === 'week' ? addDays(from, 7 * by) : mode === 'period' ? addDays(from, (pay?.intervalDays ?? 14) * by) : addMonths(monthStart(d), by);
    navigate('calendar', { view: mode, d: next });
  };

  if (!pay || !status) return <Loading />;
  const selectedDay = data?.days.find((x) => x.date === selected) ?? null;
  const tall = mode !== 'month';
  const itemName = new Map(items.map((i) => [i.id, i]));

  return (
    <>
      <div className="view-head">
        <StepNav
          label={label}
          onPrev={() => go(-1)}
          onNext={() => go(1)}
          onToday={() => navigate('calendar', { view: mode })}
          isToday={today >= focusFrom && today <= focusTo}
        />
        <Segmented<Mode>
          label="Calendar range"
          value={mode}
          onChange={(v) => navigate('calendar', { view: v, d })}
          options={[
            { value: 'week', label: 'Week' },
            { value: 'period', label: 'Pay period' },
            { value: 'month', label: 'Month' },
          ]}
        />
      </div>

      <ErrorNote error={error} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className={`cal ${tall ? 'tall' : ''}`} role="grid" aria-label={label}>
            {data.days.slice(0, 7).map((day) => (
              <div key={`h-${day.date}`} className="dow" role="columnheader">
                {weekday(day.date)}
              </div>
            ))}
            {data.days.map((day) => (
              <Day
                key={day.date}
                day={day}
                tall={tall}
                today={today}
                outside={day.date < focusFrom || day.date > focusTo}
                selected={selected === day.date}
                onSelect={() => setSelected(selected === day.date ? null : day.date)}
                itemColor={(t) => (t.itemId != null ? itemName.get(t.itemId)?.color ?? null : null)}
              />
            ))}
          </div>

          <div className="period-strip">
            {data.periods.map((p) => (
              <a key={p.period.index} href={href('period', { d: p.period.start })}>
                <span className="band" style={{ background: p.period.index % 2 ? 'var(--band-b)' : 'var(--band-a)' }} />
                {rangeLabel(p.period.start, p.period.end)}:{' '}
                <strong className={p.leftoverCents < 0 ? 'money neg' : 'money'}>
                  {money(Math.abs(p.leftoverCents))} {p.leftoverCents < 0 ? 'over' : 'unspoken for'}
                </strong>
              </a>
            ))}
          </div>
          <div className="legend">
            <span>
              <SunGlyph /> Payday, a new period starts
            </span>
            <span>
              <span className="chip planned" style={{ ['--c' as string]: 'var(--verdigris)' }}>
                Planned
              </span>
            </span>
            <span>
              <span className="chip" style={{ ['--c' as string]: 'var(--verdigris)' }}>
                Happened
              </span>
            </span>
            <span>
              <span className="chip txn unassigned">Not on a line</span>
            </span>
          </div>

          {selectedDay && <DayDetail day={selectedDay} onRule={setRuleFrom} />}
        </>
      )}
      <RuleDialog open={!!ruleFrom} onClose={() => setRuleFrom(null)} fromTxn={ruleFrom} />
    </>
  );
}

function Day({
  day,
  tall,
  today,
  outside,
  selected,
  onSelect,
  itemColor,
}: {
  day: CalendarDay;
  tall: boolean;
  today: string;
  outside: boolean;
  selected: boolean;
  onSelect: () => void;
  itemColor: (t: Txn) => string | null;
}) {
  // Planned entries that already happened are shown as their transactions instead.
  const planned = day.planned.filter((p) => !['paid', 'received'].includes(p.status));
  const limit = tall ? 12 : 3;
  const entries: { key: string; node: ReactNode }[] = [
    ...planned.map((p) => ({ key: p.key, node: <PlannedChip p={p} /> })),
    ...day.txns
      .filter((t) => t.kind === 'normal')
      .map((t) => ({ key: t.id, node: <TxnChip t={t} color={itemColor(t)} /> })),
  ];
  const cls = ['day', day.payday && 'payday', outside && 'outside', day.date === today && 'today', selected && 'selected']
    .filter(Boolean)
    .join(' ');
  const dom = Number(day.date.slice(8));
  return (
    <button
      type="button"
      className={cls}
      style={{ ['--band' as string]: day.periodIndex != null && day.periodIndex % 2 ? 'var(--band-b)' : 'var(--band-a)' }}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${dateLong(day.date)}: ${entries.length} entries`}
    >
      <span className="day-top">
        <span>
          {dom === 1 ? dateShort(day.date) : dom} {day.payday && <SunGlyph />}
        </span>
        {day.netCents !== 0 && (
          <span className={`day-net money ${day.netCents > 0 ? 'pos' : ''}`}>{money(day.netCents, { sign: true })}</span>
        )}
      </span>
      {entries.slice(0, limit).map((e) => (
        <span key={e.key} style={{ display: 'contents' }}>
          {e.node}
        </span>
      ))}
      {entries.length > limit && <span className="more">{entries.length - limit} more</span>}
    </button>
  );
}

function PlannedChip({ p }: { p: PlannedEntry }) {
  const late = p.status === 'late' || p.status === 'overdue';
  const deferred = p.status === 'deferred';
  return (
    <span className={`chip planned ${late ? 'late' : ''} ${deferred ? 'deferred' : ''}`} style={{ ['--c' as string]: p.color ?? 'var(--verdigris)' }}>
      <span>{p.name}</span>
      <span className="money">{money(p.kind === 'income' ? p.amountCents : -p.amountCents)}</span>
    </span>
  );
}

function TxnChip({ t, color }: { t: Txn; color: string | null }) {
  const unassigned = t.itemId == null && t.reserveId == null;
  return (
    <span
      className={`chip txn ${t.pending ? 'pending' : ''} ${unassigned ? 'unassigned' : ''}`}
      style={color ? { ['--c' as string]: color } : undefined}
    >
      <span>{t.description}</span>
      <span className="money">{money(t.amountCents)}</span>
    </span>
  );
}

function DayDetail({ day, onRule }: { day: CalendarDay; onRule: (t: Txn) => void }) {
  return (
    <section className="day-detail">
      <header className="sec-head">
        <h2>{dateLong(day.date)}</h2>
      </header>
      {day.planned.length === 0 && day.txns.length === 0 ? (
        <p className="empty">Nothing planned and nothing happened on this day.</p>
      ) : (
        <table className="lines stack">
          <tbody>
            {day.planned.map((p) => (
              <tr key={p.key} className={`planned ${p.status === 'deferred' ? 'deferred' : ''}`}>
                <td className="desc">{p.name}</td>
                <td className="assign-cell">
                  <Tag status={p.status} />
                </td>
                <td className="r">
                  <Money cents={p.kind === 'income' ? p.amountCents : -p.amountCents} />
                </td>
              </tr>
            ))}
            {day.txns.map((t) => (
              <tr key={t.id} className={t.kind !== 'normal' ? 'excluded' : ''}>
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
