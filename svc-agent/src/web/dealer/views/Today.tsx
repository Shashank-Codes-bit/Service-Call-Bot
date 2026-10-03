import { useEffect, useState } from 'react';
import { api, type CallRow, type DayBooking, type DayView, type DropSlot, type FollowUpPage, type Me, type StripDay } from '../api.ts';
import type { BookPreset } from './BookDrawer.tsx';
import {
  callOutcome,
  clock,
  CopyButton,
  dayNum,
  dow,
  dur,
  isWeekend,
  jobText,
  longDay,
  ord,
  Plate,
  plural,
  POOL_NAME,
  shortDay,
  SLOT,
  TeamDot,
  TEAMS,
} from '../ui.tsx';

type Props = {
  me: Me;
  version: number;
  changed: () => void;
  openBook: (p?: BookPreset) => void;
  openDetail: (reference: string) => void;
  go: (page: 'conversations' | 'followups', arg?: string) => void;
  say: (t: string) => void;
};

export function Today({ me, version, changed, openBook, openDetail, go, say }: Props) {
  const [date, setDate] = useState(me.today);
  const [strip, setStrip] = useState<StripDay[]>();
  const [day, setDay] = useState<DayView>();
  const [calls, setCalls] = useState<CallRow[]>();
  const [queue, setQueue] = useState<FollowUpPage>();
  const [yesterdayOpen, setYesterdayOpen] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.days(14).then(setStrip, (e: Error) => setError(e.message));
    api.calls(1).then((c) => setCalls(c.rows), () => {});
    api.followUps({ status: 'open', when: 'all', teams: [], q: '', sort: 'oldest' }, 0, 6).then(setQueue, () => {});
    // Open, but raised before today: the open total less today's open.
    api
      .followUps({ status: 'open', when: 'today', teams: [], q: '', sort: 'oldest' }, 0, 1)
      .then((p) => setYesterdayOpen(p.openTotal - p.total), () => {});
  }, [version]);

  useEffect(() => {
    api.day(date).then(setDay, (e: Error) => setError(e.message));
  }, [date, version]);

  const isToday = date === me.today;
  const list = day?.date === date ? day.bookings : [];
  const arrived = list.filter((b) => b.arrived_at).length;
  const late = list.filter((b) => b.late).length;
  const booked = (calls ?? []).filter((c) => c.booking_reference).length;

  return (
    <>
      {error && <p className="err">{error}</p>}
      <div className="days" role="group" aria-label="Day">
        {(strip ?? []).map((d, i) => (
          <button
            type="button"
            key={d.date}
            className={`day ${isWeekend(d.date) ? 'wknd' : ''}`}
            aria-pressed={d.date === date}
            aria-label={`${shortDay(d.date)}, ${plural(d.cars, 'booking')}`}
            onClick={() => setDate(d.date)}
          >
            <small>{i === 0 ? 'Today' : dow(d.date)}</small>
            <b className="nums">{dayNum(d.date)}</b>
            <i className="nums">{d.cars ? plural(d.cars, 'car') : '–'}</i>
          </button>
        ))}
      </div>

      <div className="dayline">
        <h2>
          {longDay(date)}
          {isToday && <span className="chip">Today</span>}
        </h2>
        {isToday ? (
          <div className="summary">
            <span className="pill nums">
              <b>{list.length}</b> cars due in
            </span>
            <span className="pill ok nums">
              <b>{arrived}</b> arrived
            </span>
            <span className="pill alert nums">
              <b>{late}</b> late
            </span>
            <span className="sep" aria-hidden="true" />
            <button type="button" className="pill nums" onClick={() => go('conversations')}>
              Agent: <b>{calls?.length ?? 0}</b> calls · <b>{booked}</b> booked
            </button>
            <button type="button" className="pill nums" onClick={() => go('followups')}>
              <b>{queue?.openTotal ?? 0}</b> to call back
            </button>
          </div>
        ) : (
          <div className="summary">
            <span className="pill nums">
              <b>{list.length}</b> cars booked
            </span>
          </div>
        )}
      </div>

      <div className="layout">
        <div className="board">
          {(['morning', 'afternoon'] as DropSlot[]).map((slot) => (
            <Column
              key={slot}
              slot={slot}
              date={date}
              isToday={isToday}
              day={day?.date === date ? day : undefined}
              openBook={openBook}
              openDetail={openDetail}
              changed={changed}
              say={say}
            />
          ))}
        </div>
        <aside className="rail">
          <section className="panel">
            <h3>
              Call back{' '}
              <span className="nums">
                {queue?.openTotal ?? 0} open{yesterdayOpen ? ` · ${yesterdayOpen} from before today` : ''}
              </span>
            </h3>
            {(queue?.rows ?? []).map((l) => (
              <div className="cb" key={l.id}>
                <input
                  className="tick"
                  type="checkbox"
                  id={`lead-${l.id}`}
                  aria-label={`Close ${l.customer_name ?? 'this caller'} as called, will call back`}
                  onChange={async () => {
                    await api.changeFollowUp(l.id, { close: { outcome: 'will_call_back' } });
                    say('Closed as “Called – will call back”. Reopen it from Follow-ups.');
                    changed();
                  }}
                />
                <label className="name" htmlFor={`lead-${l.id}`}>
                  {l.customer_name ?? 'Not registered'}
                </label>
                {l.vehicle_registration ? <Plate reg={l.vehicle_registration} /> : <span />}
                <span className="what">{l.reason_label}</span>
                <span className="meta">
                  <span className={`nums ${l.waited_min >= 1440 ? 'old' : ''}`}>
                    <TeamDot team={l.team} />
                    {TEAMS[l.team].name} · waiting {dur(l.waited_min)}
                  </span>
                  <CopyButton text={l.mobile_number} />
                </span>
              </div>
            ))}
            {queue && queue.openTotal === 0 && <p className="muted small">Nothing waiting. All caught up.</p>}
            <button type="button" className="linklike small" onClick={() => go('followups')} style={{ justifySelf: 'start' }}>
              {queue && queue.openTotal > queue.rows.length ? `${queue.openTotal - queue.rows.length} more · ` : ''}Open the follow-up queue
            </button>
          </section>
          <section className="panel">
            <h3>
              Latest calls <span className="nums">{calls?.length ?? 0} today</span>
            </h3>
            <div className="calls">
              {(calls ?? []).slice(0, 5).map((c) => {
                const o = callOutcome(c);
                const who = c.customer_name ?? c.known_name ?? 'Not registered';
                return (
                  <button type="button" key={c.id} onClick={() => go('conversations', c.id)}>
                    <span className="muted nums">{clock(c.started_at)}</span>
                    <span>
                      {who}: {o.text.charAt(0).toLowerCase() + o.text.slice(1)}
                    </span>
                  </button>
                );
              })}
              {calls?.length === 0 && <p className="muted small">No calls yet today.</p>}
            </div>
            <button type="button" className="linklike small" onClick={() => go('conversations')} style={{ justifySelf: 'start' }}>
              All conversations
            </button>
          </section>
        </aside>
      </div>
    </>
  );
}

function Column({
  slot,
  date,
  isToday,
  day,
  openBook,
  openDetail,
  changed,
  say,
}: {
  slot: DropSlot;
  date: string;
  isToday: boolean;
  day?: DayView;
  openBook: (p?: BookPreset) => void;
  openDetail: (reference: string) => void;
  changed: () => void;
  say: (t: string) => void;
}) {
  const items = (day?.bookings ?? []).filter((b) => b.drop_slot === slot);
  const arrived = items.filter((b) => b.arrived_at).length;
  const places = (['minor', 'major', 'complaint'] as const).map((p) => {
    const cell = day?.places.find((x) => x.pool === p && x.drop_slot === slot);
    return { pool: p, used: cell?.used ?? 0, total: cell?.total ?? 0 };
  });
  return (
    <section className={`col ${slot === 'afternoon' ? 'pm' : 'am'}`} aria-label={`${SLOT[slot].name} drop`}>
      <header>
        <div className="t">
          <h3>
            {SLOT[slot].name} drop · {SLOT[slot].time}
          </h3>
          <span className="muted small">{SLOT[slot].back}</span>
        </div>
        <div className="t">
          <span className="small nums">
            {isToday ? `${plural(items.length, 'car')} · ${arrived} arrived · ${items.length - arrived} expected` : plural(items.length, 'car')}
          </span>
          <span className="places">
            {places.map((p) => (
              <span key={p.pool} className={`place nums ${p.total && p.used >= p.total ? 'full' : ''}`}>
                {POOL_NAME[p.pool]}{' '}
                <b>
                  {p.used}/{p.total}
                </b>
              </span>
            ))}
          </span>
        </div>
      </header>
      {!day ? (
        <p className="loading">Loading…</p>
      ) : items.length ? (
        items.map((b) => <Card key={b.reference} b={b} isToday={isToday} openDetail={openDetail} changed={changed} say={say} />)
      ) : (
        <div className="empty">
          No {SLOT[slot].name.toLowerCase()} drops on {shortDay(date)}.{' '}
          <button type="button" className="linklike" onClick={() => openBook()}>
            Book one
          </button>
        </div>
      )}
    </section>
  );
}

function Card({
  b,
  isToday,
  openDetail,
  changed,
  say,
}: {
  b: DayBooking;
  isToday: boolean;
  openDetail: (reference: string) => void;
  changed: () => void;
  say: (t: string) => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const arrived = Boolean(b.arrived_at);
  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (msg) say(msg);
      changed();
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(false);
      setCancelling(false);
    }
  };

  let foot;
  if (cancelling) {
    foot = (
      <div className="confirmrow">
        Cancel {b.reference}? The place goes back on sale.
        <button type="button" className="btn sm" onClick={() => setCancelling(false)}>
          Keep it
        </button>
        <button
          type="button"
          className="btn sm danger"
          disabled={busy}
          onClick={() => act(() => api.setStatus(b.reference, 'cancelled'), `Cancelled ${b.reference}. The place is free again.`)}
        >
          Cancel booking
        </button>
      </div>
    );
  } else if (arrived) {
    foot = (
      <>
        <span className="muted nums small">
          Arrived {clock(b.arrived_at!)} · {b.reference}
        </span>
        <button type="button" className="btn sm" disabled={busy} onClick={() => act(() => api.arrived(b.reference, false))}>
          Undo
        </button>
      </>
    );
  } else if (isToday && b.status === 'open') {
    foot = (
      <>
        {b.late ? (
          <span className="late-note nums">Not here yet · {dur(b.late_min)} late</span>
        ) : (
          <span className="muted nums small">{b.reference}</span>
        )}
        <span style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn sm ok" disabled={busy} onClick={() => act(() => api.arrived(b.reference, true))}>
            Arrived
          </button>
          <button type="button" className="btn sm" onClick={() => setCancelling(true)}>
            Cancel
          </button>
        </span>
      </>
    );
  } else {
    foot = (
      <>
        <span className="muted nums small">
          {b.reference}
          {b.status === 'completed' ? ' · completed' : ''}
        </span>
        {b.status === 'open' && (
          <button type="button" className="btn sm" onClick={() => setCancelling(true)}>
            Cancel
          </button>
        )}
      </>
    );
  }

  return (
    <article className={`card ${arrived ? 'arrived' : ''} ${b.late ? 'late' : ''}`}>
      <button type="button" className="open" aria-label={`Open booking ${b.reference}`} onClick={() => openDetail(b.reference)} />
      <span className="tab">
        <Plate reg={b.registration_number} />
      </span>
      <div className="who">
        <span>
          <strong>{b.customer_name}</strong> <span className="muted">· {b.model}</span>
        </span>
        <span className="src">{b.source === 'ai' ? 'Agent' : 'Desk'}</span>
      </div>
      <div>
        <span className="job">
          {arrived
            ? 'In the workshop'
            : `${jobText(b.service_type, b.is_free)}${b.service_number ? ` · ${ord(b.service_number)} service` : ''}`}
        </span>
        {b.pool === 'complaint' && !arrived && <> <span className="job fault">Fault reported</span></>}
      </div>
      {b.note && <p className="quote">“{b.note}”</p>}
      <div className="foot">{foot}</div>
    </article>
  );
}
