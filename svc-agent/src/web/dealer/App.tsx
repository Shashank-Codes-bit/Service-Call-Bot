import { useCallback, useEffect, useRef, useState } from 'react';
import { api, whenSignedOut, type Hit, type Me } from './api.ts';
import { Plate, shortDay, SLOT } from './ui.tsx';
import { Gate } from './views/Gate.tsx';
import { Today } from './views/Today.tsx';
import { FollowUps } from './views/FollowUps.tsx';
import { Conversations } from './views/Conversations.tsx';
import { Agent } from './views/Agent.tsx';
import { BookDrawer, type BookPreset } from './views/BookDrawer.tsx';
import { DetailDrawer } from './views/DetailDrawer.tsx';
import { PlacesDrawer } from './views/PlacesDrawer.tsx';

type Page = 'today' | 'conversations' | 'followups' | 'agent';
type Route = { page: Page; arg?: string };
type DrawerState = { kind: 'book'; preset?: BookPreset } | { kind: 'detail'; reference: string } | { kind: 'places' } | null;

const PAGES: Page[] = ['today', 'conversations', 'followups', 'agent'];

/** The page lives in the hash, so a reload or the back button stays put. */
function readRoute(): Route {
  const [page, arg] = location.hash.replace(/^#\/?/, '').split('/');
  return PAGES.includes(page as Page) ? { page: page as Page, arg: arg || undefined } : { page: 'today' };
}

export function App() {
  const [me, setMe] = useState<Me | null>();
  const [fresh, setFresh] = useState(false);

  useEffect(() => {
    whenSignedOut(() => setMe(null));
    api.me().then(setMe, () => setMe(null));
  }, []);

  if (me === undefined) return <p className="loading wrap">Loading…</p>;
  if (me === null)
    return (
      <Gate
        onIn={(m, isNew) => {
          setFresh(isNew);
          location.hash = '#/today';
          setMe(m);
        }}
      />
    );
  return <Portal me={me} fresh={fresh} onOut={() => setMe(null)} />;
}

function Portal({ me, fresh, onOut }: { me: Me; fresh: boolean; onOut: () => void }) {
  const [route, setRoute] = useState<Route>(readRoute);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [menu, setMenu] = useState(false);
  const [version, setVersion] = useState(0);
  const [openCount, setOpenCount] = useState<number>();
  const [banner, setBanner] = useState(fresh);
  const [toast, setToast] = useState<string>();
  const finder = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const on = () => setRoute(readRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  /** Anything that changed data bumps this, and every view re-reads. */
  const changed = useCallback(() => setVersion((v) => v + 1), []);
  const say = useCallback((t: string) => {
    setToast(t);
    setTimeout(() => setToast(undefined), 2600);
  }, []);

  useEffect(() => {
    api
      .followUps({ status: 'open', when: 'all', teams: [], q: '', sort: 'oldest' }, 0, 1)
      .then((p) => setOpenCount(p.openTotal), () => {});
  }, [version]);

  const go = (page: Page, arg?: string) => {
    setDrawer(null);
    location.hash = `#/${page}${arg ? `/${arg}` : ''}`;
  };
  const openBook = useCallback((preset?: BookPreset) => setDrawer({ kind: 'book', preset }), []);
  const openDetail = useCallback((reference: string) => setDrawer({ kind: 'detail', reference }), []);
  const closeDrawer = useCallback(() => setDrawer(null), []);

  // N for a new booking, / to find. Never while typing, never over a drawer.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && menu) return setMenu(false);
      if (drawer || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/INPUT|TEXTAREA|SELECT/.test((document.activeElement as HTMLElement | null)?.tagName ?? '')) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        openBook();
      } else if (e.key === '/') {
        e.preventDefault();
        finder.current?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [drawer, menu, openBook]);

  async function signOut() {
    await api.logout().catch(() => {});
    onOut();
  }

  const nav: [Page, string][] = [
    ['today', 'Today'],
    ['conversations', 'Conversations'],
    ['followups', 'Follow-ups'],
  ];

  return (
    <>
      <header className="top">
        <div className="wrap">
          <div className="brand">
            <h1>{me.name}</h1>
            <p className="muted">Front desk</p>
          </div>
          <nav className="nav" aria-label="Sections">
            {nav.map(([id, label]) => (
              <button key={id} type="button" aria-current={route.page === id ? 'page' : undefined} onClick={() => go(id)}>
                {label}
                {id === 'followups' && openCount ? <span className="count nums">{openCount}</span> : null}
              </button>
            ))}
          </nav>
          <Finder
            inputRef={finder}
            onPick={(h) =>
              h.open_reference
                ? openDetail(h.open_reference)
                : openBook({ customerId: h.customer_id, vehicleId: h.vehicle_id, q: h.registration_number })
            }
          />
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => openBook()}>
              New booking <kbd>N</kbd>
            </button>
            <div className="me">
              <button
                type="button"
                className="avatar"
                aria-haspopup="menu"
                aria-expanded={menu}
                aria-label={`Profile menu for ${me.name}`}
                onClick={() => setMenu((m) => !m)}
              >
                {me.initials}
              </button>
              {menu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 19 }} onClick={() => setMenu(false)} />
                  <div className="menu" role="menu" aria-label="Profile">
                    <div className="whoami">
                      <span className="avatar lg" aria-hidden="true">
                        {me.initials}
                      </span>
                      <span>
                        <b>{me.name}</b>
                        <span className="muted small">Signed in as {me.userId}</span>
                      </span>
                    </div>
                    <button type="button" className="item" role="menuitem" onClick={() => { setMenu(false); setDrawer({ kind: 'places' }); }}>
                      <span>Places and booking window</span>
                      <small>How many cars each drop-off can take</small>
                    </button>
                    <button type="button" className="item" role="menuitem" onClick={() => { setMenu(false); go('agent'); }}>
                      <span>Your agent</span>
                      <small>Talk to it the way a customer would</small>
                    </button>
                    <hr />
                    <button type="button" className="item" role="menuitem" onClick={signOut}>
                      <span>Sign out</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="wrap">
        {banner && route.page === 'today' && (
          <div className="banner">
            <span>
              <b>{me.name}</b> is ready with sample customers, bookings and follow-ups. Try anything: it’s your own copy.
            </span>
            <button type="button" className="btn sm" onClick={() => setBanner(false)}>
              Got it
            </button>
          </div>
        )}
        {route.page === 'today' && (
          <Today me={me} version={version} changed={changed} openBook={openBook} openDetail={openDetail} go={go} say={say} />
        )}
        {route.page === 'conversations' && <Conversations me={me} version={version} selected={route.arg} go={go} />}
        {route.page === 'followups' && <FollowUps me={me} version={version} changed={changed} go={go} say={say} />}
        {route.page === 'agent' && <Agent me={me} changed={changed} />}
      </main>

      {drawer?.kind === 'book' && (
        <BookDrawer
          me={me}
          preset={drawer.preset}
          onClose={closeDrawer}
          onBooked={changed}
          onNew={() => setDrawer({ kind: 'book' })}
          openDetail={openDetail}
        />
      )}
      {drawer?.kind === 'detail' && (
        <DetailDrawer
          me={me}
          reference={drawer.reference}
          onClose={closeDrawer}
          changed={changed}
          go={go}
          say={say}
        />
      )}
      {drawer?.kind === 'places' && <PlacesDrawer me={me} onClose={closeDrawer} changed={changed} />}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

/** The header search: plate, phone, name or reference, as you type. */
function Finder({ inputRef, onPick }: { inputRef: React.RefObject<HTMLInputElement | null>; onPick: (h: Hit) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>();
  useEffect(() => {
    const term = q.trim();
    if (term.replace(/\s/g, '').length < 2) return setHits(undefined);
    let live = true;
    const t = setTimeout(() => api.search(term).then((h) => live && setHits(h), () => {}), 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  const pick = (h: Hit) => {
    setQ('');
    setHits(undefined);
    inputRef.current?.blur();
    onPick(h);
  };
  return (
    <div className="finder">
      <input
        ref={inputRef}
        type="search"
        autoComplete="off"
        placeholder="Find a plate or phone   /"
        aria-label="Find a plate, phone or name"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setQ('');
          if (e.key === 'Enter' && hits?.[0]) pick(hits[0]);
        }}
      />
      {hits && (
        <div className="drop" role="listbox">
          {hits.length ? (
            hits.slice(0, 6).map((h) => (
              <button type="button" key={h.vehicle_id} onClick={() => pick(h)}>
                <Plate reg={h.registration_number} />
                <span>{h.name}</span>
                <span className="muted small">
                  {h.open_date && h.open_slot ? `booked ${shortDay(h.open_date)}, ${SLOT[h.open_slot].time}` : 'no open booking'}
                </span>
              </button>
            ))
          ) : (
            <span className="muted small" style={{ padding: 6 }}>
              No match. Try a plate, phone or name.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
