import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { Capacity } from './views/Capacity.tsx';
import { Arrivals } from './views/Arrivals.tsx';
import { Reports } from './views/Reports.tsx';
import { Calls } from './views/Calls.tsx';
import { Chat } from './views/Chat.tsx';

type Tab = 'capacity' | 'arrivals' | 'calls' | 'reports';

const TABS: { id: Tab; label: string }[] = [
  { id: 'capacity', label: 'Capacity' },
  { id: 'arrivals', label: 'Arrivals' },
  { id: 'calls', label: 'Calls' },
  { id: 'reports', label: 'Reports' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('capacity');
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof api.summary>>>();
  const [chatOpen, setChatOpen] = useState(false);
  // Bumped when a conversation ends or a booking closes, so the open tab
  // re-reads — a booking made in the side panel shows up beside it.
  const [version, setVersion] = useState(0);

  // Refetched on every tab change and after a booking — the counts are the
  // first thing anyone reads, so a stale "1 open booking" next to two visible
  // bookings undermines the whole screen.
  const refresh = useCallback(() => {
    api.summary().then(setSummary).catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh, tab]);

  const changed = useCallback(() => {
    refresh();
    setVersion((v) => v + 1);
  }, [refresh]);

  return (
    // On a wide screen the panel sits beside the portal rather than over it.
    <div className={`min-h-screen bg-stone-100 text-stone-900 ${chatOpen ? 'lg:pr-[26rem]' : ''}`}>
      <header className="border-b border-stone-300 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-baseline gap-x-6 gap-y-2 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              {summary?.centre.name ?? 'Service Desk'}
            </h1>
            <p className="nums text-xs text-stone-500">
              {summary
                ? `${summary.centre.opens_at}–${summary.centre.closes_at}, seven days · ${summary.centre.landline}`
                : 'loading…'}
            </p>
          </div>
          <div className="nums ml-auto flex gap-6 text-xs text-stone-500">
            {summary &&
              Object.entries(summary.counts).map(([k, v]) => (
                <div key={k}>
                  <div className="text-base font-medium text-stone-900">{v}</div>
                  <div>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</div>
                </div>
              ))}
          </div>
        </div>

        <nav className="mx-auto flex max-w-7xl gap-1 px-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                tab === t.id
                  ? 'border-stone-900 font-medium text-stone-900'
                  : 'border-transparent text-stone-500 hover:text-stone-800'
              }`}
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={() => setChatOpen((o) => !o)}
            aria-expanded={chatOpen}
            className="mb-1.5 ml-auto self-center rounded bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-700"
          >
            {chatOpen ? 'Hide chat' : 'Chat with the agent'}
          </button>
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">
        {tab === 'capacity' && <Capacity today={summary?.today} onChange={refresh} version={version} />}
        {tab === 'arrivals' && <Arrivals today={summary?.today} version={version} onChange={changed} />}
        {tab === 'calls' && <Calls today={summary?.today} version={version} />}
        {tab === 'reports' && <Reports today={summary?.today} />}
      </main>

      {/* Always mounted, so closing the panel mid-conversation loses nothing. */}
      <Chat open={chatOpen} onClose={() => setChatOpen(false)} onEnded={changed} />
    </div>
  );
}
