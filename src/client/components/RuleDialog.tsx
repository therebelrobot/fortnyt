import { useEffect, useState } from 'react';
import type { ItemInput, Rule, RuleInput, Txn } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../data';
import { ALLOCATION_LABEL, centsToInput, dateShort, parseMoneyInput } from '../format';
import { CadenceFields, Dialog, ErrorNote, ItemOptions, Money } from './ui';

const blankNewItem = (kind: 'income' | 'expense'): ItemInput => ({
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

/** Bank descriptions end in store numbers and dates; strip them so the rule matches next time. */
export function suggestPattern(description: string): string {
  return description
    .replace(/\b(#|no\.?\s*)?\d[\d\-/*]*\b/gi, ' ')
    .replace(/[*#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join(' ');
}

const blank: RuleInput = {
  name: '',
  priority: 100,
  field: 'any',
  match: 'contains',
  pattern: '',
  accountId: null,
  direction: 'any',
  minCents: null,
  maxCents: null,
  itemId: null,
  reserveId: null,
  setKind: 'normal',
  enabled: true,
};

export function RuleDialog({
  open,
  onClose,
  fromTxn,
  rule,
}: {
  open: boolean;
  onClose: () => void;
  fromTxn?: Txn | null;
  rule?: Rule | null;
}) {
  const { items, reserves, refresh, toast, accounts: accountList } = useApp();
  const accounts = { data: accountList };
  const [r, setR] = useState<RuleInput>(blank);
  const [minText, setMinText] = useState('');
  const [maxText, setMaxText] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [preview, setPreview] = useState<{ count: number; manualSkipped: number; sample: Txn[] } | null>(null);
  const [newItem, setNewItem] = useState<ItemInput | null>(null);
  const [newItemAmount, setNewItemAmount] = useState('');

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNewItem(null);
    setNewItemAmount('');
    if (rule) {
      const { id: _id, ...rest } = rule;
      setR(rest);
      setMinText(rule.minCents != null ? centsToInput(rule.minCents) : '');
      setMaxText(rule.maxCents != null ? centsToInput(rule.maxCents) : '');
    } else {
      setR({
        ...blank,
        pattern: fromTxn ? suggestPattern(fromTxn.description) : '',
        direction: fromTxn ? (fromTxn.amountCents < 0 ? 'out' : 'in') : 'any',
        itemId: fromTxn?.itemId ?? null,
        reserveId: fromTxn?.itemId == null ? (fromTxn?.reserveId ?? null) : null,
        setKind: fromTxn && fromTxn.kind !== 'normal' ? fromTxn.kind : 'normal',
      });
      setMinText('');
      setMaxText('');
    }
  }, [open, rule, fromTxn]);

  const setNI = <K extends keyof ItemInput>(k: K, v: ItemInput[K]) => setNewItem((x) => (x ? { ...x, [k]: v } : x));

  function addNewBudgetLine() {
    const kind = fromTxn && fromTxn.amountCents > 0 ? 'income' : 'expense';
    setR((x) => ({ ...x, setKind: 'normal', itemId: null, reserveId: null }));
    setNewItem({
      ...blankNewItem(kind),
      name: (fromTxn ? suggestPattern(fromTxn.description) : '') || r.pattern,
      anchorDate: fromTxn?.date ?? null,
    });
    setNewItemAmount(fromTxn ? centsToInput(Math.abs(fromTxn.amountCents)) : '');
  }

  const candidate: RuleInput = { ...r, minCents: parseMoneyInput(minText), maxCents: parseMoneyInput(maxText) };
  const target = newItem
    ? 'new'
    : r.setKind !== 'normal'
      ? `kind:${r.setKind}`
      : r.itemId != null
        ? `item:${r.itemId}`
        : r.reserveId != null
          ? `pot:${r.reserveId}`
          : '';

  useEffect(() => {
    if (
      !open ||
      !candidate.pattern.trim() ||
      (candidate.setKind === 'normal' && candidate.itemId == null && candidate.reserveId == null)
    ) {
      setPreview(null);
      return;
    }
    const t = window.setTimeout(() => {
      api.previewRule(candidate).then(setPreview).catch(() => setPreview(null));
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, JSON.stringify(candidate)]);

  async function save() {
    setError(null);
    try {
      let toApply = candidate;
      if (newItem) {
        if (!newItem.name.trim()) throw new Error('Name the new budget line.');
        const cents = parseMoneyInput(newItemAmount);
        if (cents == null) throw new Error('Enter an amount for the new budget line, for example 45.00.');
        const item = await api.createItem({ ...newItem, amountCents: Math.abs(cents) });
        toApply = { ...candidate, setKind: 'normal', itemId: item.id, reserveId: null };
      }
      const res = rule ? await api.updateRule(rule.id, toApply) : await api.createRule(toApply);
      toast(
        newItem
          ? `${newItem.name} added to the budget. Rule saved, ${res.changed} transaction${res.changed === 1 ? '' : 's'} updated.`
          : `Rule saved. ${res.changed} transaction${res.changed === 1 ? '' : 's'} updated.`,
      );
      refresh();
      onClose();
    } catch (err) {
      setError(err as Error);
    }
  }

  const set = <K extends keyof RuleInput>(k: K, v: RuleInput[K]) => setR((x) => ({ ...x, [k]: v }));

  return (
    <Dialog open={open} onClose={onClose} title={rule ? 'Edit rule' : 'New rule'}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {fromTxn && (
          <p className="hint">
            From <strong>{fromTxn.description}</strong> on {dateShort(fromTxn.date)}.
          </p>
        )}
        <div className="row">
          <label className="grow">
            When the text
            <select value={r.match} onChange={(e) => set('match', e.target.value as RuleInput['match'])}>
              <option value="contains">contains</option>
              <option value="starts">starts with</option>
              <option value="exact">is exactly</option>
              <option value="regex">matches the regular expression</option>
            </select>
          </label>
          <label className="grow">
            Look in
            <select value={r.field} onChange={(e) => set('field', e.target.value as RuleInput['field'])}>
              <option value="any">Description, payee, or memo</option>
              <option value="description">Description only</option>
              <option value="payee">Payee only</option>
              <option value="memo">Memo only</option>
            </select>
          </label>
        </div>
        <label>
          Text to match (not case-sensitive)
          <input value={r.pattern} onChange={(e) => set('pattern', e.target.value)} required autoFocus />
        </label>
        <div className="row">
          <label className="grow">
            Direction
            <select value={r.direction} onChange={(e) => set('direction', e.target.value as RuleInput['direction'])}>
              <option value="any">Money in or out</option>
              <option value="out">Money out only</option>
              <option value="in">Money in only</option>
            </select>
          </label>
          <label>
            Amount at least
            <input inputMode="decimal" value={minText} onChange={(e) => setMinText(e.target.value)} placeholder="any" />
          </label>
          <label>
            At most
            <input inputMode="decimal" value={maxText} onChange={(e) => setMaxText(e.target.value)} placeholder="any" />
          </label>
        </div>
        <label>
          Only in account
          <select value={r.accountId ?? ''} onChange={(e) => set('accountId', e.target.value || null)}>
            <option value="">Any account</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.nickname || a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Then put it in
          <select
            value={target}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'new') addNewBudgetLine();
              else if (v.startsWith('kind:'))
                setR((x) => ({ ...x, setKind: v.slice(5) as RuleInput['setKind'], itemId: null, reserveId: null }));
              else if (v.startsWith('pot:')) setR((x) => ({ ...x, setKind: 'normal', itemId: null, reserveId: Number(v.slice(4)) }));
              else setR((x) => ({ ...x, setKind: 'normal', reserveId: null, itemId: v ? Number(v.slice(5)) : null }));
              if (v !== 'new') setNewItem(null);
            }}
            required
          >
            <option value="" disabled>
              Choose a budget line
            </option>
            <option value="new">+ New budget line…</option>
            <ItemOptions items={items} reserves={reserves} includeNone={false} />
          </select>
        </label>
        {newItem && (
          <fieldset className="subform">
            <legend>New budget line</legend>
            <div className="row">
              <label className="grow">
                Name
                <input value={newItem.name} onChange={(e) => setNI('name', e.target.value)} required />
              </label>
              <label>
                Amount
                <input
                  inputMode="decimal"
                  value={newItemAmount}
                  onChange={(e) => setNewItemAmount(e.target.value)}
                  placeholder="0.00"
                  required
                />
              </label>
              <label>
                Type
                <select
                  value={newItem.kind}
                  onChange={(e) => {
                    const kind = e.target.value as ItemInput['kind'];
                    setNewItem((x) => (x ? { ...blankNewItem(kind), name: x.name, group: x.group } : x));
                  }}
                >
                  <option value="expense">Expense</option>
                  <option value="income">Income</option>
                </select>
              </label>
            </div>
            <div className="row">
              <CadenceFields f={newItem} set={setNI} />
            </div>
            <div className="row">
              <label className="grow">
                Group (optional)
                <input list="rule-new-item-groups" value={newItem.group} onChange={(e) => setNI('group', e.target.value)} placeholder="Home, Bills, Everyday…" />
                <datalist id="rule-new-item-groups">
                  {[...new Set(items.map((i) => i.group).filter(Boolean))].map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </label>
              {newItem.kind === 'expense' && (
                <label>
                  How it lands in pay periods
                  <select value={newItem.allocation} onChange={(e) => setNI('allocation', e.target.value as ItemInput['allocation'])}>
                    <option value="due">{ALLOCATION_LABEL.due}</option>
                    <option value="spread">{ALLOCATION_LABEL.spread}</option>
                    <option value="reserve">{ALLOCATION_LABEL.reserve}</option>
                  </select>
                </label>
              )}
            </div>
          </fieldset>
        )}
        <div className="row">
          <label className="grow">
            Name (optional)
            <input value={r.name} onChange={(e) => set('name', e.target.value)} />
          </label>
          <label>
            Priority
            <input
              type="number"
              value={r.priority}
              onChange={(e) => set('priority', Number(e.target.value))}
              title="Lower runs first. The first matching rule wins."
            />
          </label>
        </div>
        {preview && (
          <div className="preview">
            <p>
              Matches <strong>{preview.count}</strong> transaction{preview.count === 1 ? '' : 's'} so far
              {preview.manualSkipped > 0 && <>. {preview.manualSkipped} you set by hand will stay as they are</>}.
            </p>
            {preview.sample.length > 0 && (
              <ul>
                {preview.sample.map((t) => (
                  <li key={t.id}>
                    <span>{dateShort(t.date)}</span>
                    <span className="grow">{t.description}</span>
                    <Money cents={t.amountCents} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <ErrorNote error={error} />
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save rule
          </button>
        </div>
      </form>
    </Dialog>
  );
}
