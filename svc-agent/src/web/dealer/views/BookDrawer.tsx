import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Booked, type Car, type Customer, type DropSlot, type FreeDay, type Hit, type Me, type Pool } from '../api.ts';
import { dayNum, dow, Drawer, jobText, ord, phone, Plate, shortDay, SLOT } from '../ui.tsx';

export type BookPreset = { customerId: number; vehicleId?: number; q?: string };

/** Free places, morning / afternoon, for one pool over the next fortnight. */
export function DayPicker({
  free,
  pool,
  today,
  chosen,
  onPick,
}: {
  free: FreeDay[] | undefined;
  pool: Pool;
  today: string;
  chosen: string | undefined;
  onPick: (date: string) => void;
}) {
  if (!free) return <p className="loading">Loading free places…</p>;
  return (
    <>
      <p className="muted small">Free {pool === 'complaint' ? 'fault-check' : pool} places, morning / afternoon.</p>
      <div className="strip">
        {free.map((d) => {
          const am = d.pools[pool].morning;
          const pm = d.pools[pool].afternoon;
          return (
            <button
              type="button"
              key={d.date}
              className="slotday"
              aria-pressed={chosen === d.date}
              disabled={am + pm === 0}
              aria-label={`${shortDay(d.date)}: ${am} morning, ${pm} afternoon places`}
              onClick={() => onPick(d.date)}
            >
              <small>{d.date === today ? 'Today' : dow(d.date)}</small>
              <b className="nums">{dayNum(d.date)}</b>
              <span className="free nums">
                <i className={am ? '' : 'z'}>{am}</i> / <i className={pm ? '' : 'z'}>{pm}</i>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export function SlotPicker({
  free,
  pool,
  date,
  chosen,
  onPick,
}: {
  free: FreeDay[] | undefined;
  pool: Pool;
  date: string;
  chosen: DropSlot | undefined;
  onPick: (s: DropSlot) => void;
}) {
  const day = free?.find((d) => d.date === date);
  return (
    <div className="slots">
      {(['morning', 'afternoon'] as DropSlot[]).map((s) => {
        const n = day?.pools[pool][s] ?? 0;
        const back = pool === 'minor' || (pool === 'major' && s === 'morning') ? 'Back the same evening' : 'Back the next day';
        return (
          <button type="button" key={s} className="slot" aria-pressed={chosen === s} disabled={!n} onClick={() => onPick(s)}>
            <b>{SLOT[s].time}</b>
            <span>{back}</span>
            <span className="muted nums small">{n} free</span>
          </button>
        );
      })}
    </div>
  );
}

export function BookDrawer({
  me,
  preset,
  onClose,
  onBooked,
  onNew,
  openDetail,
}: {
  me: Me;
  preset?: BookPreset;
  onClose: () => void;
  onBooked: () => void;
  onNew: () => void;
  openDetail: (reference: string) => void;
}) {
  const [q, setQ] = useState(preset?.q ?? '');
  const [hits, setHits] = useState<Hit[]>();
  const [customer, setCustomer] = useState<Customer>();
  const [carId, setCarId] = useState<number>();
  const [fault, setFault] = useState(false);
  const [free, setFree] = useState<FreeDay[]>();
  const [date, setDate] = useState<string>();
  const [slot, setSlot] = useState<DropSlot>();
  const [note, setNote] = useState('');
  const [race, setRace] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ booked: Booked; car: Car; customer: Customer }>();

  // Search as you type, by phone, plate or name.
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

  const pickCustomer = async (id: number, vehicleId?: number) => {
    const c = await api.customer(id);
    setCustomer(c);
    setDate(undefined);
    setSlot(undefined);
    const usable = c.cars.filter((v) => !v.blocker);
    const want = vehicleId != null ? c.cars.find((v) => v.id === vehicleId && !v.blocker) : undefined;
    setCarId(want?.id ?? (c.cars.length === 1 && usable.length === 1 ? usable[0]!.id : undefined));
  };

  useEffect(() => {
    if (preset) pickCustomer(preset.customerId, preset.vehicleId).catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshFree = () => api.free(14).then(setFree, (e: Error) => setError(e.message));
  useEffect(() => {
    refreshFree();
  }, []);

  const customers = useMemo(() => {
    const by = new Map<number, { id: number; name: string; mobile: string; plates: string[] }>();
    for (const h of hits ?? []) {
      const c = by.get(h.customer_id) ?? { id: h.customer_id, name: h.name, mobile: h.mobile_number, plates: [] };
      c.plates.push(h.registration_number);
      by.set(h.customer_id, c);
    }
    return [...by.values()];
  }, [hits]);

  const car = customer?.cars.find((v) => v.id === carId);
  const pool: Pool | undefined = car ? (fault ? 'complaint' : (car.service_type ?? undefined)) : undefined;
  const ready = Boolean(car && pool && date && slot);

  async function book() {
    if (!car || !pool || !date || !slot) return;
    setBusy(true);
    setError(undefined);
    setRace(false);
    try {
      const booked = await api.book({ vehicleId: car.id, pool, bookingDate: date, dropSlot: slot, complaintNote: note.trim() || null });
      setDone({ booked, car, customer: customer! });
      onBooked();
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'slot_full') {
        // Someone else — the phone agent, another desk — took the last place
        // first. Nothing was double-booked; show the fresh numbers.
        setRace(true);
        setSlot(undefined);
        refreshFree();
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const { booked, car: v, customer: c } = done;
    return (
      <Drawer
        title="Booked"
        onClose={onClose}
        foot={
          <>
            <button type="button" className="btn" onClick={() => openDetail(booked.reference)}>
              Open booking
            </button>
            <button type="button" className="btn primary" onClick={onNew} data-autofocus>
              New booking
            </button>
          </>
        }
      >
        <div className="ticket">
          <Plate reg={v.registration_number} />
          <span className="ref nums">{booked.reference}</span>
          <span>
            {c.name}, {v.model} · {shortDay(booked.bookingDate)}, drop {SLOT[booked.dropSlot].time},{' '}
            {booked.expectedPickup === booked.bookingDate ? 'back the same evening' : 'back the next day'}
          </span>
          <div className="notice ok">It’s on the board, and the phone agent now sees the place as taken.</div>
        </div>
      </Drawer>
    );
  }

  return (
    <Drawer
      title="New booking"
      onClose={onClose}
      foot={
        <>
          <span className="muted small">{ready ? `${shortDay(date!)}, ${SLOT[slot!].time}` : 'Find, pick, book.'}</span>
          <button type="button" className="btn primary" disabled={!ready || busy} onClick={book}>
            {busy ? 'Booking…' : 'Book'}
          </button>
        </>
      }
    >
      <section className="step">
        <h3>
          <span className="n">1</span> Find the customer
        </h3>
        <input
          className="field big"
          type="search"
          autoComplete="off"
          placeholder="Phone, plate or name"
          aria-label="Phone, plate or name"
          value={q}
          data-autofocus
          onChange={(e) => {
            setQ(e.target.value);
            setCustomer(undefined);
            setCarId(undefined);
          }}
        />
        <div className="results">
          {customer && !hits ? null : customers.length ? (
            customers.map((c) => (
              <button type="button" key={c.id} className="pick" aria-pressed={customer?.id === c.id} onClick={() => pickCustomer(c.id)}>
                <div className="row">
                  <strong>{c.name}</strong>
                  <span className="nums muted">{phone(c.mobile)}</span>
                </div>
                <div className="row" style={{ justifyContent: 'flex-start' }}>
                  {c.plates.map((p) => (
                    <Plate key={p} reg={p} />
                  ))}
                </div>
              </button>
            ))
          ) : hits ? (
            <div className="empty">No customer matches. A new number is registered by the agent on its first call.</div>
          ) : (
            <p className="muted small">Try 98100, HR26 or Priya.</p>
          )}
        </div>
      </section>

      <section className={`step ${customer ? '' : 'locked'}`}>
        <h3>
          <span className="n">2</span> Car
        </h3>
        {customer ? (
          <>
            <div className="carpick">
              {customer.cars.map((v) => (
                <button
                  type="button"
                  key={v.id}
                  className={`pick ${v.blocker ? 'blocked' : ''}`}
                  aria-pressed={carId === v.id}
                  aria-disabled={v.blocker ? true : undefined}
                  onClick={() => {
                    if (v.blocker) return;
                    setCarId(v.id);
                    setDate(undefined);
                    setSlot(undefined);
                  }}
                >
                  <div className="row" style={{ justifyContent: 'flex-start' }}>
                    <Plate reg={v.registration_number} />
                    <strong>{v.model}</strong>
                  </div>
                  <span>
                    {v.service_type && <span className="job">{jobText(v.service_type, v.is_free)}</span>}{' '}
                    {v.service_number ? `${ord(v.service_number)} service` : 'No service on record'}
                    {v.due_date ? `, due ${shortDay(v.due_date)}` : v.service_number ? ', no due date on record' : ''}
                  </span>
                  {v.blocker && <span className="blocker">{v.blocker}</span>}
                </button>
              ))}
            </div>
            {car && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={fault}
                  onChange={(e) => {
                    setFault(e.target.checked);
                    setDate(undefined);
                    setSlot(undefined);
                  }}
                />{' '}
                Customer reports a fault (uses the fault-check places)
              </label>
            )}
          </>
        ) : (
          <p className="muted">Pick a customer first.</p>
        )}
      </section>

      <section className={`step ${car && pool ? '' : 'locked'}`}>
        <h3>
          <span className="n">3</span> Day
        </h3>
        {car && pool ? (
          <DayPicker
            free={free}
            pool={pool}
            today={me.today}
            chosen={date}
            onPick={(d) => {
              setDate(d);
              setSlot(undefined);
              setRace(false);
            }}
          />
        ) : (
          <p className="muted">Pick a car first.</p>
        )}
      </section>

      <section className={`step ${car && pool && date ? '' : 'locked'}`}>
        <h3>
          <span className="n">4</span> Drop-off and note
        </h3>
        {car && pool && date ? (
          <>
            <SlotPicker free={free} pool={pool} date={date} chosen={slot} onPick={(s) => { setSlot(s); setRace(false); }} />
            <label htmlFor="bk-note" className="muted small">
              Note for the workshop (optional)
            </label>
            <textarea id="bk-note" placeholder="What the customer said, e.g. AC not cooling" value={note} onChange={(e) => setNote(e.target.value)} />
            {race && (
              <div className="notice alert" role="alert">
                Someone else booked that last place a moment ago, so nothing was double-booked. Pick another drop-off or day.
              </div>
            )}
          </>
        ) : (
          <p className="muted">Pick a day first.</p>
        )}
        {error && <p className="err">{error}</p>}
      </section>
    </Drawer>
  );
}
