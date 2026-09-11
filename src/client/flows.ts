import type { Assessment, ISODate, Item, Reserve } from '../shared/types';

// One money-flow model shared by the Dial and the Sankey, so both charts always agree.

export type FlowMode = 'now' | 'plan';

export interface Seg {
  key: string;
  label: string;
  cents: number;
  color: string;
}

export interface FlowLine extends Seg {
  /** real reserve this line's money ends up in, if any */
  reserveId: number | null;
  /** deferred to a later period — shown muted, already excluded from cents/totals in 'now' mode */
  deferred: boolean;
}

export interface FlowGroup extends Seg {
  lines: FlowLine[];
  /** groups that end here (unplanned, shortfall) instead of splitting into lines */
  terminal: boolean;
}

export interface DeferredLine extends Seg {
  movedTo: ISODate | null;
}

export interface Flows {
  sources: Seg[];
  income: number;
  groups: FlowGroup[];
  out: number;
  /** income − out; negative means more out than in */
  leftover: number;
  reserves: Seg[];
  /**
   * 'now' mode only: bills deferred out of this period. Deliberately not part of `out`/`leftover` —
   * that money is genuinely free this period — so they're reported separately rather than folded
   * into the flow (the Sankey especially can't show them as a real flow without breaking the tree's
   * money conservation, since this money never moved through this period at all).
   */
  deferred: DeferredLine[];
  deferredCents: number;
}

export function buildFlows(a: Assessment, mode: FlowMode, items: Item[], reserves: Reserve[]): Flows {
  const itemById = new Map(items.map((i) => [i.id, i]));

  // Money in, one source per income line.
  const sources: Seg[] = [];
  for (const l of a.income) {
    const cents = mode === 'plan' ? l.expectedCents : l.countedCents;
    if (cents <= 0) continue;
    const existing = sources.find((s) => s.key === `in:${l.itemId}`);
    if (existing) existing.cents += cents;
    else sources.push({ key: `in:${l.itemId}`, label: l.name, cents, color: l.color ?? 'var(--moss)' });
  }
  if (mode === 'now' && a.totals.unplannedIncomeCents > 0) {
    sources.push({ key: 'in:other', label: 'Other money in', cents: a.totals.unplannedIncomeCents, color: 'var(--moss)' });
  }
  sources.sort((x, y) => y.cents - x.cents);
  const income = sources.reduce((s, x) => s + x.cents, 0);

  // Money out, grouped.
  const byGroup = new Map<string, FlowGroup>();
  const deferred: DeferredLine[] = [];
  for (const l of a.expenses) {
    const isDeferred = l.status === 'deferred';
    if (mode === 'now' && isDeferred) {
      if (l.budgetCents > 0) {
        deferred.push({ key: `i:${l.itemId}`, label: l.name, cents: l.budgetCents, color: l.color ?? 'var(--verdigris)', movedTo: l.movedTo });
      }
      continue; // this money never moved through this period — report it separately, not as a flow
    }
    const cents = mode === 'plan' ? l.budgetCents : l.committedCents;
    if (cents <= 0) continue;
    const g = l.group || 'Other';
    const group = byGroup.get(g) ?? { key: `g:${g}`, label: g, cents: 0, color: '', lines: [], terminal: false };
    group.cents += cents;
    const existing = group.lines.find((x) => x.key === `i:${l.itemId}`);
    if (existing) existing.cents += cents;
    else
      group.lines.push({
        key: `i:${l.itemId}`,
        label: l.name,
        cents,
        color: l.color ?? 'var(--verdigris)',
        reserveId: itemById.get(l.itemId)?.reserveId ?? null,
        deferred: isDeferred,
      });
    byGroup.set(g, group);
  }
  const deferredCents = deferred.reduce((s, d) => s + d.cents, 0);
  const groups = [...byGroup.values()].sort((x, y) => y.cents - x.cents);
  for (const g of groups) {
    g.lines.sort((x, y) => y.cents - x.cents);
    g.color = g.lines[0]?.color ?? 'var(--verdigris)';
  }
  if (mode === 'now' && a.totals.unplannedSpendCents > 0) {
    groups.push({ key: 'g:unplanned', label: 'Not in the budget', cents: a.totals.unplannedSpendCents, color: 'var(--berry)', lines: [], terminal: true });
  }
  if (mode === 'now' && a.totals.reserveShortfallCents > 0) {
    groups.push({ key: 'g:shortfall', label: 'Reserve shortfall', cents: a.totals.reserveShortfallCents, color: 'var(--berry)', lines: [], terminal: true });
  }
  const out = groups.reduce((s, g) => s + g.cents, 0);

  // Where reserve-bound lines end up.
  const potTotals = new Map<number, number>();
  for (const g of groups) for (const l of g.lines) if (l.reserveId != null) potTotals.set(l.reserveId, (potTotals.get(l.reserveId) ?? 0) + l.cents);
  const reserveSegs: Seg[] = [...potTotals.entries()]
    .map(([id, cents]) => {
      const r = reserves.find((x) => x.id === id);
      return { key: `r:${id}`, label: r?.name ?? 'Reserve', cents, color: r?.color ?? 'var(--verdigris)' };
    })
    .sort((x, y) => y.cents - x.cents);

  return { sources, income, groups, out, leftover: income - out, reserves: reserveSegs, deferred, deferredCents };
}
