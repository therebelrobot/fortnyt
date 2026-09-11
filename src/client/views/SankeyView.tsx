import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { ErrorNote, Loading, Segmented, StepNav } from '../components/ui';
import { useApp, useData } from '../data';
import { buildFlows, type FlowMode, type Seg } from '../flows';
import { money, rangeLabel } from '../format';
import { shiftPeriod } from '../periods';
import { navigate } from '../router';

// Hand-rolled layout. Every flow here is a tree (a line belongs to exactly one group, a group
// to the one pay period), so stacking each column in parent order gives a Sankey with no
// crossing bands and no layout solver.

interface Node extends Seg {
  col: number;
  x: number;
  y: number;
  h: number;
  inOff: number;
  outOff: number;
}

interface Link {
  key: string;
  from: string;
  to: string;
  cents: number;
  color: string;
}

const W = 1080;
const NODE_W = 14;
const GAP = 12;
const TOP = 36;
const LEFT = 190;
const RIGHT = 200;

export function SankeyView({ params }: { params: URLSearchParams }) {
  const { status, personId, items, reserves } = useApp();
  const date = params.get('d') ?? status?.today;
  const mode = (params.get('mode') === 'plan' ? 'plan' : 'now') as FlowMode;
  const [hot, setHot] = useState<string | null>(null);
  const { data: a, error } = useData(() => api.assessment(date ?? undefined, personId), [date]);

  if (error && !a) return <ErrorNote error={error} />;
  if (!a) return <Loading />;

  const f = buildFlows(a, mode, items, reserves);
  const total = Math.max(f.income, f.out, 1);

  // --- columns ---------------------------------------------------------------
  const col0: Seg[] = [...f.sources];
  if (f.leftover < 0) col0.push({ key: 'in:short', label: 'More out than in', cents: -f.leftover, color: 'var(--berry)' });
  const pool: Seg = { key: 'pool', label: 'This pay period', cents: total, color: 'var(--ink-2)' };
  const col2: Seg[] = [...f.groups];
  if (f.leftover > 0) col2.push({ key: 'leftover', label: 'Not spoken for', cents: f.leftover, color: 'var(--sun)' });
  const col3: Seg[] = f.groups.flatMap((g) => g.lines);
  const col4: Seg[] = f.reserves;
  const columns = col4.length ? [col0, [pool], col2, col3, col4] : [col0, [pool], col2, col3];

  const maxNodes = Math.max(...columns.map((c) => c.length));
  // Gaps between many small nodes eat height; reserve 360px for the money itself on top of them.
  const H = Math.min(1600, TOP + 24 + (maxNodes - 1) * GAP + 360);
  const usable = H - TOP - 24 - (maxNodes - 1) * GAP;
  const k = usable / total;
  const span = W - LEFT - RIGHT - NODE_W;
  const colX = (i: number) => LEFT + (span * i) / (columns.length - 1);

  const nodes = new Map<string, Node>();
  columns.forEach((col, ci) => {
    const heights = col.map((s) => Math.max(2, s.cents * k));
    const used = heights.reduce((s, h) => s + h, 0) + (col.length - 1) * GAP;
    // Centre each column on the pay-period node so the picture reads as one flow.
    let y = TOP + Math.max(0, (H - TOP - 24 - used) / 2);
    col.forEach((s, i) => {
      nodes.set(s.key, { ...s, col: ci, x: colX(ci), y, h: heights[i], inOff: 0, outOff: 0 });
      y += heights[i] + GAP;
    });
  });

  // --- links (in stacking order, so bands never cross) -----------------------
  const links: Link[] = [];
  for (const s of col0) links.push({ key: `${s.key}>pool`, from: s.key, to: 'pool', cents: s.cents, color: s.color });
  for (const g of col2) links.push({ key: `pool>${g.key}`, from: 'pool', to: g.key, cents: g.cents, color: g.color });
  for (const g of f.groups) for (const l of g.lines) links.push({ key: `${g.key}>${l.key}`, from: g.key, to: l.key, cents: l.cents, color: l.color });
  for (const g of f.groups)
    for (const l of g.lines)
      if (l.reserveId != null && nodes.has(`r:${l.reserveId}`))
        links.push({ key: `${l.key}>r:${l.reserveId}`, from: l.key, to: `r:${l.reserveId}`, cents: l.cents, color: nodes.get(`r:${l.reserveId}`)!.color });

  const bands: ReactNode[] = [];
  for (const link of links) {
    const s = nodes.get(link.from)!;
    const t = nodes.get(link.to)!;
    const h = Math.max(1, link.cents * k);
    const x0 = s.x + NODE_W;
    const x1 = t.x;
    const y0 = s.y + s.outOff;
    const y1 = t.y + t.inOff;
    s.outOff += h;
    t.inOff += h;
    const xm = (x0 + x1) / 2;
    const d = `M${x0} ${y0} C${xm} ${y0} ${xm} ${y1} ${x1} ${y1} L${x1} ${y1 + h} C${xm} ${y1 + h} ${xm} ${y0 + h} ${x0} ${y0 + h} Z`;
    const lit = hot && (hot === link.from || hot === link.to || hot === link.key);
    bands.push(
      <path
        key={link.key}
        d={d}
        fill={link.color}
        fillOpacity={lit ? 0.62 : hot ? 0.12 : 0.32}
        onMouseEnter={() => setHot(link.key)}
      >
        <title>{`${s.label} → ${t.label}: ${money(link.cents)}`}</title>
      </path>,
    );
  }

  const lastCol = columns.length - 1;
  const nodeEls = [...nodes.values()].map((n) => {
    const lit = !hot || hot === n.key || links.some((l) => (l.from === n.key || l.to === n.key) && (hot === l.key || hot === l.from || hot === l.to));
    const labelLeft = n.col === 0;
    const labelAbove = n.key === 'pool';
    const tx = labelLeft ? n.x - 8 : n.x + NODE_W + 8;
    const ty = labelAbove ? n.y - 12 : n.y + n.h / 2;
    return (
      <g
        key={n.key}
        opacity={lit ? 1 : 0.4}
        tabIndex={0}
        role="img"
        aria-label={`${n.label}: ${money(n.cents)}`}
        onMouseEnter={() => setHot(n.key)}
        onFocus={() => setHot(n.key)}
        style={{ cursor: 'default' }}
      >
        <rect x={n.x} y={n.y} width={NODE_W} height={n.h} rx={2} fill={n.color} />
        <text
          x={labelAbove ? n.x + NODE_W / 2 : tx}
          y={ty}
          textAnchor={labelAbove ? 'middle' : labelLeft ? 'end' : 'start'}
          dominantBaseline="middle"
          className="sankey-label"
        >
          <tspan fontWeight={n.col === 2 || n.col === lastCol || labelAbove ? 650 : 500}>{n.label}</tspan>
          <tspan className="sankey-value" dx="6">
            {money(n.key === 'pool' ? f.income : n.cents)}
          </tspan>
        </text>
        <title>{`${n.label}: ${money(n.cents)}`}</title>
      </g>
    );
  });

  const go = (by: number) => navigate('sankey', { d: shiftPeriod(a.period.start, a.lens.pay, by), mode: mode === 'now' ? undefined : mode });

  return (
    <>
      <div className="view-head">
        <StepNav
          label={rangeLabel(a.period.start, a.period.end)}
          onPrev={() => go(-1)}
          onNext={() => go(1)}
          onToday={() => navigate('sankey', { mode: mode === 'now' ? undefined : mode })}
          isToday={a.period.status === 'current'}
        />
        <Segmented<FlowMode>
          label="Sankey shows"
          value={mode}
          onChange={(v) => navigate('sankey', { d: date ?? undefined, mode: v === 'now' ? undefined : v })}
          options={[
            { value: 'now', label: 'As it stands' },
            { value: 'plan', label: 'The plan' },
          ]}
        />
      </div>
      <p className="muted" style={{ marginBottom: '1.25rem' }}>
        Left to right: where this pay period’s money comes from, the groups and budget lines it goes to
        {col4.length ? ', and the reserves those lines feed' : ''}. Band width is money
        {a.lens.personId != null ? ` (${a.lens.name}’s share)` : ''}.
      </p>
      <div className="sankey" onMouseLeave={() => setHot(null)}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Money flow: ${money(f.income)} in, ${money(f.out)} out, ${money(f.leftover)} left`}
        >
          <g>{bands}</g>
          <g>{nodeEls}</g>
        </svg>
      </div>
      {f.deferred.length > 0 && (
        <div className="section" style={{ opacity: 0.65 }}>
          <p className="muted small" style={{ marginBottom: '0.5rem' }}>
            Deferred to a later period — this money never moved through this period, so it isn’t part of the flow above.
          </p>
          <table className="lines">
            <tbody>
              {f.deferred.map((d) => (
                <tr key={d.key}>
                  <td>
                    <span className="swatch" style={{ background: d.color }} /> {d.label}
                  </td>
                  <td className="r hide-sm">{d.movedTo ? `→ ${d.movedTo}` : ''}</td>
                  <td className="r money">{money(d.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="section">
        <summary>The same flows as a table</summary>
        <table className="lines">
          <thead>
            <tr>
              <th>From</th>
              <th>To</th>
              <th className="r">Amount</th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.key}>
                <td>{nodes.get(l.from)!.label}</td>
                <td>{nodes.get(l.to)!.label}</td>
                <td className="r money">{money(l.cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}
