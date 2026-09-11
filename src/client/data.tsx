import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Account, Item, Person, ReserveDetail, Status } from '../shared/types';
import type { PaySchedule } from '../shared/recurrence';
import { api } from './api';
import { setCurrency } from './format';

// One global "version" number. Any mutation bumps it; every useData hook refetches.
// Coarse, but the whole dataset is one person's budget — refetching is cheap and it
// removes a whole class of stale-view bugs.

interface Ctx {
  version: number;
  refresh: () => void;
  status: Status | null;
  items: Item[];
  reserves: ReserveDetail[];
  accounts: Account[];
  people: Person[];
  /** whose share every view shows; null = the whole household */
  personId: number | null;
  setPersonId: (id: number | null) => void;
  /** the pay schedule framing periods in the current view */
  pay: PaySchedule | null;
  toast: (msg: string) => void;
}

const DataCtx = createContext<Ctx>({
  version: 0,
  refresh: () => {},
  status: null,
  items: [],
  reserves: [],
  accounts: [],
  people: [],
  personId: null,
  setPersonId: () => {},
  pay: null,
  toast: () => {},
});

const LENS_KEY = 'fortnyt.person';

export function DataProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [reserves, setReserves] = useState<ReserveDetail[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [personId, setPersonIdState] = useState<number | null>(() => {
    const v = Number(window.localStorage.getItem(LENS_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  });
  const setPersonId = useCallback((id: number | null) => {
    setPersonIdState(id);
    if (id == null) window.localStorage.removeItem(LENS_KEY);
    else window.localStorage.setItem(LENS_KEY, String(id));
  }, []);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToastMsg(null), 4000);
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([api.status(), api.items(), api.reserves(null), api.accounts()])
      .then(([s, i, r, a]) => {
        if (!live) return;
        setCurrency(s.settings.currency);
        setStatus(s);
        setItems(i);
        setReserves(r.filter((x) => !x.virtual));
        setAccounts(a);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [version]);

  const people = status?.people ?? [];
  const lensPerson = people.find((p) => p.id === personId) ?? null;
  const effectivePersonId = lensPerson ? lensPerson.id : null;
  const pay: PaySchedule | null =
    lensPerson?.payAnchor && lensPerson.payIntervalDays
      ? { anchor: lensPerson.payAnchor, intervalDays: lensPerson.payIntervalDays }
      : status?.settings.payAnchor
        ? { anchor: status.settings.payAnchor, intervalDays: status.settings.payIntervalDays }
        : null;

  return (
    <DataCtx.Provider
      value={{
        version,
        refresh,
        status,
        items,
        reserves,
        accounts,
        people,
        personId: effectivePersonId,
        setPersonId,
        pay,
        toast,
      }}
    >
      {children}
      <div className="toast" role="status" aria-live="polite">
        {toastMsg}
      </div>
    </DataCtx.Provider>
  );
}

export const useApp = () => useContext(DataCtx);

export function useData<T>(fetcher: () => Promise<T>, deps: unknown[]): {
  data: T | null;
  error: Error | null;
  loading: boolean;
} {
  const { version, personId } = useApp();
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fetcher()
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((error: Error) => live && setState((s) => ({ data: s.data, error, loading: false })));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, personId, ...deps]);
  return state;
}
