import { useApp } from './data';
import { href, useRoute } from './router';
import { BudgetView } from './views/BudgetView';
import { CalendarView } from './views/CalendarView';
import { DialView } from './views/DialView';
import { LedgerView } from './views/LedgerView';
import { PeriodView } from './views/PeriodView';
import { ReservesView } from './views/ReservesView';
import { SankeyView } from './views/SankeyView';
import { SetupView } from './views/SetupView';
import { Loading } from './components/ui';

const NAV = [
  { view: 'period', label: 'This period' },
  { view: 'calendar', label: 'Calendar' },
  { view: 'ledger', label: 'Ledger' },
  { view: 'dial', label: 'Dial' },
  { view: 'sankey', label: 'Sankey' },
  { view: 'reserves', label: 'Reserves' },
  { view: 'budget', label: 'Budget' },
  { view: 'setup', label: 'Setup' },
];

export function App() {
  const route = useRoute();
  const { status, people, personId, setPersonId } = useApp();

  let body;
  if (!status) body = <Loading />;
  else if (!status.settings.payAnchor && route.view !== 'setup') body = <BudgetView firstRun />;
  else {
    switch (route.view) {
      case 'calendar':
        body = <CalendarView params={route.params} />;
        break;
      case 'ledger':
        body = <LedgerView params={route.params} />;
        break;
      case 'dial':
        body = <DialView params={route.params} />;
        break;
      case 'sankey':
        body = <SankeyView params={route.params} />;
        break;
      case 'reserves':
        body = <ReservesView />;
        break;
      case 'budget':
        body = <BudgetView />;
        break;
      case 'setup':
        body = <SetupView />;
        break;
      default:
        body = <PeriodView params={route.params} />;
    }
  }

  return (
    <div className="shell">
      <aside className="rail">
        <a className="brand" href={href('period')}>
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="16" cy="16" r="12" fill="none" stroke="var(--verdigris)" strokeWidth="4" />
            <path d="M16 4a12 12 0 0 1 11.4 8.3" fill="none" stroke="var(--sun)" strokeWidth="4" />
          </svg>
          fortnyt
        </a>
        <nav className="nav" aria-label="Views">
          {NAV.map((n) => (
            <a key={n.view} href={href(n.view)} aria-current={route.view === n.view ? 'page' : undefined}>
              {n.label}
            </a>
          ))}
        </nav>
        {people.length > 0 && (
          <div className="lens">
            <label htmlFor="lens">Showing</label>
            <select
              id="lens"
              value={personId ?? ''}
              onChange={(e) => setPersonId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Whole household</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}’s share
                </option>
              ))}
            </select>
          </div>
        )}
      </aside>
      <main>{body}</main>
    </div>
  );
}
