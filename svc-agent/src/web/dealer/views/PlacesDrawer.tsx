import { useEffect, useState } from 'react';
import { api, type Applied, type DropSlot, type Master, type Me, type Pool } from '../api.ts';
import { addDays, Drawer, shortDay } from '../ui.tsx';

const WEEK: [number, string][] = [
  [1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun'],
];
const COLS: [Pool, DropSlot, string][] = [
  ['minor', 'morning', 'Minor 8:30'],
  ['minor', 'afternoon', 'Minor 2:00'],
  ['major', 'morning', 'Major 8:30'],
  ['major', 'afternoon', 'Major 2:00'],
  ['complaint', 'morning', 'Fault 8:30'],
  ['complaint', 'afternoon', 'Fault 2:00'],
];

/**
 * The weekly places, set once and rarely touched — so they live behind the
 * profile menu, not on the board. Saving applies to the live window at once.
 */
export function PlacesDrawer({ me, onClose, changed }: { me: Me; onClose: () => void; changed: () => void }) {
  const [master, setMaster] = useState<Master>();
  const [applied, setApplied] = useState<Applied>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    api.master().then(setMaster, (e: Error) => setError(e.message));
  }, []);

  function set(weekday: number, pool: Pool, slot: DropSlot, raw: string) {
    if (!master) return;
    const n = Math.max(0, Math.min(99, Math.trunc(Number(raw) || 0)));
    setMaster({ ...master, [weekday]: { ...master[weekday]!, [pool]: { ...master[weekday]![pool], [slot]: n } } });
    setDirty(true);
  }

  async function save() {
    if (!master) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.saveMaster(master);
      setMaster(r.master);
      setApplied(r.applied);
      setDirty(false);
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const through = applied?.to ?? addDays(me.today, 30);

  return (
    <Drawer
      title="Places and booking window"
      ctx="One limit for every booking, whoever makes it"
      onClose={onClose}
      foot={
        <>
          <span className="muted small">{applied && !dirty ? 'Saved and applied.' : dirty ? 'Unsaved changes' : ''}</span>
          <button type="button" className="btn primary" disabled={!dirty || busy} onClick={save}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      <section className="sect">
        <h3>Weekly places</h3>
        <p className="muted small">
          Places per drop-off that the agent and the desk may book, after walk-ins. One booking store, one limit, whoever books.
        </p>
        {master ? (
          <div className="tablewrap">
            <table className="nums">
              <thead>
                <tr>
                  <th>Day</th>
                  {COLS.map(([, , label]) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {WEEK.map(([w, name]) => (
                  <tr key={w}>
                    <th>{name}</th>
                    {COLS.map(([pool, slot, label]) => (
                      <td key={label}>
                        <input
                          type="number"
                          min={0}
                          max={99}
                          aria-label={`${name} ${label} places`}
                          value={master[w]?.[pool]?.[slot] ?? 0}
                          onChange={(e) => set(w, pool, slot, e.target.value)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="loading">Loading…</p>
        )}
        {applied && applied.conflicts.length > 0 && (
          <div className="notice alert conflict">
            {applied.conflicts.length} drop-off{applied.conflicts.length === 1 ? '' : 's'} could not shrink because more cars are
            already booked than the new figure. They stay at what is booked:{' '}
            {applied.conflicts
              .slice(0, 4)
              .map((c) => `${shortDay(c.date)} ${c.pool === 'complaint' ? 'fault' : c.pool} ${c.dropSlot === 'morning' ? '8:30' : '2:00'} (${c.heldAt})`)
              .join('; ')}
            {applied.conflicts.length > 4 ? ` and ${applied.conflicts.length - 4} more.` : '.'}
          </div>
        )}
      </section>
      <section className="sect">
        <h3>Booking window</h3>
        <p>
          Customers can book from tomorrow up to 30 days ahead; the desk can also book today. The window moves forward by itself every
          six hours.
        </p>
        <div className="notice ok nums">Open through {shortDay(through)}.</div>
      </section>
      {error && <p className="err">{error}</p>}
    </Drawer>
  );
}
