import { useEffect, useState } from 'react';
import { api, ApiError, type DayBooking, type DropSlot, type FreeDay, type Me } from '../api.ts';
import { clock, Drawer, jobText, ord, phone, Plate, shortDay, SLOT } from '../ui.tsx';
import { DayPicker, SlotPicker } from './BookDrawer.tsx';

type Detail = DayBooking & { call: { id: string; started_at: string } | null };

/** One booking: who, when, what — and move it, cancel it, or tick it in. */
export function DetailDrawer({
  me,
  reference,
  onClose,
  changed,
  go,
  say,
}: {
  me: Me;
  reference: string;
  onClose: () => void;
  changed: () => void;
  go: (page: 'conversations', arg?: string) => void;
  say: (t: string) => void;
}) {
  const [b, setB] = useState<Detail>();
  const [free, setFree] = useState<FreeDay[]>();
  const [date, setDate] = useState<string>();
  const [slot, setSlot] = useState<DropSlot>();
  const [moved, setMoved] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = () =>
    Promise.all([api.booking(reference), api.free(14)]).then(
      ([d, f]) => {
        setB(d);
        setFree(f);
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference]);

  async function act(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      after?.();
      changed();
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'slot_full') {
        setError('Someone else took that place a moment ago. Pick another drop-off or day.');
        setSlot(undefined);
        await load();
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!b) {
    return (
      <Drawer title="Booking" onClose={onClose}>
        {error ? <p className="err">{error}</p> : <p className="loading">Loading…</p>}
      </Drawer>
    );
  }

  const open = b.status === 'open';
  const ctx = (
    <>
      <Plate reg={b.registration_number} />
      <span className="nums">
        {b.reference} · {shortDay(b.booking_date)}, {SLOT[b.drop_slot].time}
      </span>
      <span className="src">{b.source === 'ai' ? 'Agent' : 'Desk'}</span>
    </>
  );

  return (
    <Drawer
      title={`${b.customer_name} · ${b.model}`}
      ctx={ctx}
      onClose={onClose}
      foot={
        open ? (
          cancelling ? (
            <div className="confirmrow" style={{ width: '100%' }}>
              Cancel {b.reference}? The place goes back on sale.
              <button type="button" className="btn sm" onClick={() => setCancelling(false)}>
                Keep it
              </button>
              <button
                type="button"
                className="btn sm danger"
                disabled={busy}
                onClick={() =>
                  act(() => api.setStatus(b.reference, 'cancelled'), () => {
                    say(`Cancelled ${b.reference}. The place is free again.`);
                    onClose();
                  })
                }
              >
                Cancel booking
              </button>
            </div>
          ) : (
            <>
              <button type="button" className="btn danger" onClick={() => setCancelling(true)}>
                Cancel booking
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!date || !slot || busy}
                onClick={() =>
                  act(() => api.reschedule(b.reference, date!, slot!), () => {
                    setMoved(true);
                    setDate(undefined);
                    setSlot(undefined);
                  })
                }
              >
                {busy ? 'Moving…' : 'Move booking'}
              </button>
            </>
          )
        ) : (
          <span className="muted small">This booking is {b.status}.</span>
        )
      }
    >
      <dl className="dl nums">
        <dt>Customer</dt>
        <dd>
          {b.customer_name} · <span style={{ userSelect: 'all' }}>{phone(b.mobile_number)}</span>
        </dd>
        <dt>Drop-off</dt>
        <dd>
          {shortDay(b.booking_date)}, {SLOT[b.drop_slot].time},{' '}
          {b.expected_pickup === b.booking_date ? 'back the same evening' : 'back the next day'}
        </dd>
        <dt>Job</dt>
        <dd>
          {jobText(b.service_type, b.is_free)}
          {b.service_number ? ` · ${ord(b.service_number)} service` : ''}
          {b.pool === 'complaint' ? ' · fault reported' : ''}
        </dd>
        {b.note && (
          <>
            <dt>Note</dt>
            <dd>“{b.note}”</dd>
          </>
        )}
        <dt>Reference</dt>
        <dd>
          {b.reference}
          {b.arrived_at ? ` · arrived ${clock(b.arrived_at)}` : ''}
          {b.status !== 'open' ? ` · ${b.status}` : ''}
        </dd>
        <dt>Made by</dt>
        <dd>
          {b.source === 'ai' ? (
            <>
              Phone agent{b.call ? ` at ${clock(b.call.started_at)}` : ''}
              {b.call && (
                <>
                  {' · '}
                  <button type="button" className="linklike" onClick={() => go('conversations', b.call!.id)}>
                    Hear the call
                  </button>
                </>
              )}
            </>
          ) : (
            'Front desk'
          )}
          {` · ${shortDay(b.created_at.slice(0, 10))} ${clock(b.created_at)}`}
        </dd>
      </dl>

      {open && b.booking_date === me.today && (
        <button
          type="button"
          className={`btn ${b.arrived_at ? '' : 'ok'}`}
          style={{ justifySelf: 'start' }}
          disabled={busy}
          onClick={() => act(() => api.arrived(b.reference, !b.arrived_at))}
        >
          {b.arrived_at ? 'Undo arrived' : 'Mark arrived'}
        </button>
      )}

      {open && (
        <section className="step">
          <h3>Reschedule</h3>
          <DayPicker
            free={free}
            pool={b.pool}
            today={me.today}
            chosen={date}
            onPick={(d) => {
              setDate(d);
              setSlot(undefined);
              setMoved(false);
            }}
          />
          {date && <SlotPicker free={free} pool={b.pool} date={date} chosen={slot} onPick={setSlot} />}
          {moved && (
            <div className="notice ok">
              Moved to {shortDay(b.booking_date)}, {SLOT[b.drop_slot].time}. The old place is free again.
            </div>
          )}
        </section>
      )}
      {error && <p className="err" role="alert">{error}</p>}
    </Drawer>
  );
}
