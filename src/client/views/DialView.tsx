import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { ErrorNote, Loading, Segmented, StepNav } from '../components/ui';
import { useApp, useData } from '../data';
import { buildFlows, type FlowGroup, type FlowMode } from '../flows';
import { money, rangeLabel } from '../format';
import { shiftPeriod } from '../periods';
import { navigate } from '../router';

type Mode = FlowMode;

type Group = FlowGroup;

const TAU = Math.PI * 2;
const C = 200;

/** Annular sector, angles in radians clockwise from 12 o'clock. */
function sector(r0: number, r1: number, a0: number, a1: number): string {
  if (a1 - a0 >= TAU - 1e-6) {
    // A full ring can't be one arc; draw it as two halves.
    return sector(r0, r1, a0, a0 + Math.PI) + sector(r0, r1, a0 + Math.PI, a1);
  }
  const p = (r: number, a: number) => `${(C + r * Math.sin(a)).toFixed(2)} ${(C - r * Math.cos(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)} A${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L${p(r0, a1)} A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

export function DialView({ params }: { params: URLSearchParams }) {
  const { status, personId, items, reserves } = useApp();
  const date = params.get('d') ?? status?.today;
  const mode = (params.get('mode') === 'plan' ? 'plan' : 'now') as Mode;
  const [hot, setHot] = useState<string | null>(null);
  const { data: a, error } = useData(() => api.assessment(date ?? undefined, personId), [date]);

  if (error && !a) return <ErrorNote error={error} />;
  if (!a) return <Loading />;

  const flows = buildFlows(a, mode, items, reserves);
  const { groups, income, out, leftover } = flows;
  const total = Math.max(income, out, 1);
  const angle = (cents: number) => (cents / total) * TAU;

  const paths: ReactNode[] = [];
  let cursor = 0;
  for (const g of groups) {
    const g0 = cursor;
    const g1 = cursor + angle(g.cents);
    paths.push(
      <path
        key={g.key}
        d={sector(86, 126, g0, g1)}
        fill={g.color}
        fillOpacity={0.55}
        className={hot === g.key ? 'hot' : ''}
        tabIndex={0}
        aria-label={`${g.label}: ${money(g.cents)}`}
        onMouseEnter={() => setHot(g.key)}
        onFocus={() => setHot(g.key)}
      >
        <title>{`${g.label}: ${money(g.cents)}`}</title>
      </path>,
    );
    if (g.terminal) {
      paths.push(
        <path key={`${g.key}:outer`} d={sector(130, 186, g0, g1)} fill={g.color} className={hot === g.key ? 'hot' : ''}>
          <title>{`${g.label}: ${money(g.cents)}`}</title>
        </path>,
      );
    }
    let lc = g0;
    for (const l of g.lines) {
      const l1 = lc + angle(l.cents);
      paths.push(
        <path
          key={l.key}
          d={sector(130, 186, lc, l1)}
          fill={l.color}
          fillOpacity={l.deferred ? 0.4 : undefined}
          className={hot === l.key || hot === g.key ? 'hot' : ''}
          tabIndex={0}
          aria-label={`${l.label}: ${money(l.cents)}`}
          onMouseEnter={() => setHot(l.key)}
          onFocus={() => setHot(l.key)}
        >
          <title>{`${l.label}: ${money(l.cents)}`}</title>
        </path>,
      );
      lc = l1;
    }
    cursor = g1;
  }
  if (leftover > 0) {
    paths.push(
      <path
        key="leftover"
        d={sector(86, 186, cursor, cursor + angle(leftover))}
        fill="var(--sun)"
        className={hot === 'leftover' ? 'hot' : ''}
        tabIndex={0}
        aria-label={`Not spoken for: ${money(leftover)}`}
        onMouseEnter={() => setHot('leftover')}
        onFocus={() => setHot('leftover')}
      >
        <title>{`Not spoken for: ${money(leftover)}`}</title>
      </path>,
    );
  }
  // Deferred bills get their own outer ring, swept over their own total — kept separate from the
  // main ring's angle math since that money never moved through this period at all.
  if (flows.deferred.length > 0) {
    let dc = 0;
    for (const d of flows.deferred) {
      const d0 = (dc / flows.deferredCents) * TAU;
      dc += d.cents;
      const d1 = (dc / flows.deferredCents) * TAU;
      paths.push(
        <path
          key={`def:${d.key}`}
          d={sector(190, 196, d0, d1)}
          fill="var(--ink-3)"
          fillOpacity={hot === `def:${d.key}` ? 0.7 : 0.4}
          tabIndex={0}
          aria-label={`${d.label}: deferred, ${money(d.cents)}`}
          onMouseEnter={() => setHot(`def:${d.key}`)}
          onFocus={() => setHot(`def:${d.key}`)}
        >
          <title>{`${d.label}: deferred${d.movedTo ? ` to ${d.movedTo}` : ''} — ${money(d.cents)}`}</title>
        </path>,
      );
    }
  }

  // When more goes out than comes in, mark where the income runs out.
  const incomeMark = leftover < 0 ? angle(income) : null;

  const pct = (c: number) => `${Math.round((c / total) * 100)}%`;
  const go = (by: number) => navigate('dial', { d: shiftPeriod(a.period.start, a.lens.pay, by), mode });

  return (
    <>
      <div className="view-head">
        <StepNav
          label={rangeLabel(a.period.start, a.period.end)}
          onPrev={() => go(-1)}
          onNext={() => go(1)}
          onToday={() => navigate('dial', { mode })}
          isToday={a.period.status === 'current'}
        />
        <Segmented<Mode>
          label="Dial shows"
          value={mode}
          onChange={(v) => navigate('dial', { d: date ?? undefined, mode: v === 'now' ? undefined : v })}
          options={[
            { value: 'now', label: 'As it stands' },
            { value: 'plan', label: 'The plan' },
          ]}
        />
      </div>
      <p className="muted" style={{ marginBottom: '1.5rem' }}>
        The whole ring is {mode === 'plan' ? 'the income the plan expects' : 'the money coming in'} this pay period
        {a.lens.personId != null ? ` (${a.lens.name}’s share)` : ''}. Inner ring: groups. Outer ring: budget lines. Gold:
        what isn’t spoken for.
        {flows.deferred.length > 0 && ' Grey outer ring: bills deferred to a later period — not part of this ring’s money.'}
      </p>

      <div className="dial-wrap">
        <div className={`dial ${hot ? 'hovering' : ''}`} onMouseLeave={() => setHot(null)} onBlur={() => setHot(null)}>
          <svg viewBox="0 0 400 400" role="img" aria-label={`Where ${money(income)} goes`}>
            {paths}
            {incomeMark != null && (
              <g>
                <line
                  x1={C + 80 * Math.sin(incomeMark)}
                  y1={C - 80 * Math.cos(incomeMark)}
                  x2={C + 196 * Math.sin(incomeMark)}
                  y2={C - 196 * Math.cos(incomeMark)}
                  stroke="var(--berry)"
                  strokeWidth={3}
                />
                <path d={sector(190, 196, incomeMark, TAU)} fill="var(--berry)" />
              </g>
            )}
            <text x={C} y={C - 6} textAnchor="middle" className="dial-center" fontSize="34" fontWeight="600" fill={leftover < 0 ? 'var(--berry)' : 'var(--sun-ink)'}>
              {money(Math.abs(leftover))}
            </text>
            <text x={C} y={C + 22} textAnchor="middle" fontSize="14" fill="var(--ink-2)">
              {leftover < 0 ? 'more out than in' : 'not spoken for'}
            </text>
          </svg>
        </div>

        <ul className="legend-list" onMouseLeave={() => setHot(null)}>
          <li>
            <span>Coming in</span>
            <span className="money">{money(income)}</span>
            <span />
          </li>
          {groups.map((g) => (
            <GroupRows key={g.key} g={g} hot={hot} setHot={setHot} pct={pct} />
          ))}
          <li className={`group ${hot === 'leftover' ? 'hot' : ''}`} onMouseEnter={() => setHot('leftover')}>
            <span className="name">
              <span className="swatch" style={{ background: 'var(--sun)' }} />
              <span>Not spoken for</span>
            </span>
            <span className="money">{money(leftover)}</span>
            <span className="muted small">{leftover > 0 ? pct(leftover) : ''}</span>
          </li>
          {flows.deferred.length > 0 && (
            <li className="group" style={{ opacity: 0.55 }}>
              <span className="name">
                <span className="swatch" style={{ background: 'var(--ink-3)' }} />
                <span>Deferred to a later period</span>
              </span>
              <span className="money">{money(flows.deferredCents)}</span>
              <span className="muted small" />
            </li>
          )}
          {flows.deferred.map((d) => (
            <li key={d.key} className={hot === `def:${d.key}` ? 'hot' : ''} style={{ opacity: 0.55 }} onMouseEnter={() => setHot(`def:${d.key}`)}>
              <span className="name" style={{ paddingLeft: '1.1rem' }}>
                <span className="swatch" style={{ background: d.color }} />
                <span>{d.label}</span>
              </span>
              <span className="money">{money(d.cents)}</span>
              <span className="muted small">{d.movedTo ? `→ ${d.movedTo}` : ''}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function GroupRows({
  g,
  hot,
  setHot,
  pct,
}: {
  g: Group;
  hot: string | null;
  setHot: (k: string | null) => void;
  pct: (c: number) => string;
}) {
  return (
    <>
      <li className={`group ${hot === g.key ? 'hot' : ''}`} onMouseEnter={() => setHot(g.key)}>
        <span className="name">
          <span className="swatch" style={{ background: g.color, opacity: 0.6 }} />
          <span>{g.label}</span>
        </span>
        <span className="money">{money(g.cents)}</span>
        <span className="muted small">{pct(g.cents)}</span>
      </li>
      {g.lines.map((l) => (
        <li key={l.key} className={hot === l.key ? 'hot' : ''} style={l.deferred ? { opacity: 0.55 } : undefined} onMouseEnter={() => setHot(l.key)}>
          <span className="name" style={{ paddingLeft: '1.1rem' }}>
            <span className="swatch" style={{ background: l.color }} />
            <span>{l.label}</span>
          </span>
          <span className="money">{money(l.cents)}</span>
          <span className="muted small">{pct(l.cents)}</span>
        </li>
      ))}
    </>
  );
}
