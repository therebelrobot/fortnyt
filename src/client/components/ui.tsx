import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Item, Reserve, Txn } from '../../shared/types';
import { api, ApiError } from '../api';
import { useApp } from '../data';
import { money } from '../format';

export function Money({ cents, sign, className }: { cents: number; sign?: boolean; className?: string }) {
  return <span className={`money ${cents < 0 ? 'neg' : ''} ${className ?? ''}`}>{money(cents, { sign })}</span>;
}

const STATUS_TEXT: Record<string, string> = {
  received: 'Received',
  expected: 'Expected',
  late: 'Not arrived',
  extra: 'Unscheduled',
  paid: 'Paid',
  upcoming: 'Upcoming',
  overdue: 'Past due',
  open: 'Open',
  closed: 'Closed',
  funding: 'Saving',
  pending: 'Pending',
  planned: 'Planned',
  deferred: 'Deferred',
};

export function Tag({ status }: { status: string }) {
  return <span className={`tag tag-${status}`}>{STATUS_TEXT[status] ?? status}</span>;
}

export function Swatch({ color }: { color: string | null }) {
  return <span className="swatch" style={{ background: color ?? 'var(--ink-3)' }} aria-hidden="true" />;
}

export function SunGlyph({ title = 'Payday' }: { title?: string }) {
  return (
    <svg className="sun" viewBox="0 0 16 16" role="img" aria-label={title}>
      <title>{title}</title>
      <circle cx="8" cy="8" r="3.2" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <line key={a} x1="8" y1="1.2" x2="8" y2="3" transform={`rotate(${a} 8 8)`} />
      ))}
    </svg>
  );
}

export function ErrorNote({ error }: { error: Error | null | undefined }) {
  if (!error) return null;
  const issues = error instanceof ApiError ? error.issues : [];
  return (
    <div className="error-note" role="alert">
      <p>{error.message}</p>
      {issues.length > 0 && (
        <ul>
          {issues.map((i) => (
            <li key={i.path + i.message}>
              {i.path ? <strong>{i.path}: </strong> : null}
              {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={wide ? 'wide' : ''} onClose={onClose} onCancel={onClose} aria-label={title}>
      <header className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {open ? children : null}
    </dialog>
  );
}

export function StepNav({
  label,
  onPrev,
  onNext,
  onToday,
  isToday,
}: {
  label: ReactNode;
  onPrev: () => void;
  onNext: () => void;
  onToday?: () => void;
  isToday?: boolean;
}) {
  return (
    <div className="stepnav">
      <button type="button" className="icon-btn" onClick={onPrev} aria-label="Previous">
        ‹
      </button>
      <div className="stepnav-label">{label}</div>
      <button type="button" className="icon-btn" onClick={onNext} aria-label="Next">
        ›
      </button>
      {onToday && (
        <button type="button" className="btn ghost small" onClick={onToday} disabled={isToday}>
          Today
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assigning a transaction to a budget line
// ---------------------------------------------------------------------------

export function encodeAssignment(t: Pick<Txn, 'itemId' | 'kind' | 'reserveId'>): string {
  if (t.kind !== 'normal') return `kind:${t.kind}`;
  if (t.itemId != null) return `item:${t.itemId}`;
  if (t.reserveId != null) return `pot:${t.reserveId}`;
  return 'none';
}

export function ItemOptions({
  items,
  reserves = [],
  includeNone = true,
}: {
  items: Item[];
  reserves?: Reserve[];
  includeNone?: boolean;
}) {
  const groups = new Map<string, Item[]>();
  for (const i of items) {
    const g = `${i.kind === 'income' ? 'Money in' : 'Money out'}${i.group ? `: ${i.group}` : ''}`;
    groups.set(g, [...(groups.get(g) ?? []), i]);
  }
  return (
    <>
      {includeNone && <option value="none">Not in the budget</option>}
      {[...groups.entries()].map(([g, list]) => (
        <optgroup key={g} label={g}>
          {list.map((i) => (
            <option key={i.id} value={`item:${i.id}`}>
              {i.name}
            </option>
          ))}
        </optgroup>
      ))}
      {reserves.length > 0 && (
        <optgroup label="Paid from / into a reserve">
          {reserves.map((r) => (
            <option key={r.id} value={`pot:${r.id}`}>
              {r.name}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="Doesn’t count">
        <option value="kind:transfer">Transfer between my accounts</option>
        <option value="kind:ignore">Ignore</option>
      </optgroup>
    </>
  );
}

export function AssignSelect({ txn, onRule }: { txn: Txn; onRule?: (t: Txn) => void }) {
  const { items, reserves, refresh, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const value = encodeAssignment(txn);

  async function change(v: string) {
    setBusy(true);
    try {
      if (v === 'none') await api.patchTxn(txn.id, { itemId: null, kind: 'normal' });
      else if (v.startsWith('kind:')) await api.patchTxn(txn.id, { kind: v.slice(5) as Txn['kind'] });
      else if (v.startsWith('pot:')) await api.patchTxn(txn.id, { reserveId: Number(v.slice(4)) });
      else await api.patchTxn(txn.id, { itemId: Number(v.slice(5)), kind: 'normal' });
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="assign">
      <select
        value={value}
        disabled={busy}
        onChange={(e) => void change(e.target.value)}
        aria-label={`Budget line for ${txn.description}`}
        className={value === 'none' ? 'unassigned' : ''}
      >
        <ItemOptions items={items} reserves={reserves} />
      </select>
      {txn.assignedBy === 'rule' && <span className="by-rule" title="Set by a rule">rule</span>}
      {onRule && (
        <button type="button" className="btn ghost small" onClick={() => onRule(txn)}>
          Make a rule
        </button>
      )}
    </div>
  );
}

export function Loading() {
  return (
    <p className="loading" aria-live="polite">
      Loading…
    </p>
  );
}
