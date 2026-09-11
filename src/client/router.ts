import { useEffect, useState } from 'react';

// Hash routing: #/ledger?from=2026-09-04&to=2026-09-17. No dependency, survives reloads,
// and every view state is a bookmarkable URL.

export interface Route {
  view: string;
  params: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [view, query = ''] = raw.split('?');
  return { view: view || 'period', params: new URLSearchParams(query) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function href(view: string, params: Record<string, string | undefined> = {}): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const qs = s.toString();
  return `#/${view}${qs ? `?${qs}` : ''}`;
}

export function navigate(view: string, params: Record<string, string | undefined> = {}, replace = false): void {
  const next = href(view, params);
  if (replace) window.history.replaceState(null, '', next);
  else window.location.hash = next.slice(1);
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}
