import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  withPassword,
  DROP_SLOTS,
  POOLS,
  WEEKDAYS,
  type Applied,
  type CapacityDay,
  type DropSlot,
  type Master,
  type Pool,
  type Vehicle,
} from '../api.ts';

type Target = { date: string; pool: Pool; dropSlot: DropSlot; free: number };

export function Capacity({
  today,
  onChange,
  version,
}: {
  today?: string;
  onChange?: () => void;
  version?: number;
}) {
  const [master, setMaster] = useState<Master>();
  const [window, setWindow] = useState<CapacityDay[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [target, setTarget] = useState<Target>();
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string }>();

  const load = useCallback(async () => {
    const [m, w, v] = await Promise.all([api.master(), api.window(30), api.vehicles()]);
    setMaster(m);
    setWindow(w);
    setVehicles(v);
    onChange?.();
  }, [onChange]);

  useEffect(() => {
    load().catch((e) => setNotice({ tone: 'warn', text: String(e) }));
  }, [load]);

  // A booking elsewhere changes the window, never the master — so re-read only
  // what moved, and leave any unsaved master edits alone.
  useEffect(() => {
    if (!version) return;
    Promise.all([api.window(30), api.vehicles()])
      .then(([w, v]) => {
        setWindow(w);
        setVehicles(v);
      })
      .catch(() => undefined);
  }, [version]);

  /**
   * A cut that could not fully land is surfaced, never swallowed — the dealer
   * needs to know their reduction did not take effect on those days.
   */
  function describe(r: Applied, lead: string): { tone: 'ok' | 'warn'; text: string } {
    if (!r.conflicts.length) {
      return { tone: 'ok', text: `${lead} Window now runs ${r.from} → ${r.to}.` };
    }
    const shown = r.conflicts
      .slice(0, 4)
      .map((c) => `${c.date} ${c.pool}/${c.dropSlot} held at ${c.heldAt}`)
      .join('; ');
    return {
      tone: 'warn',
      text:
        `${lead} ${r.conflicts.length} slot(s) could not shrink because bookings already ` +
        `exceed the new figure: ${shown}` +
        (r.conflicts.length > 4 ? ` … and ${r.conflicts.length - 4} more` : ''),
    };
  }

  /** Saving applies. One click, not two. */
  async function save() {
    if (!master) return;
    const r = await withPassword(() => api.saveMaster(master));
    await load();
    setNotice(describe(r.applied, 'Capacity saved and applied.'));
  }

  /** No master change — just walk the window forward as days pass. */
  async function extend() {
    const r = await withPassword(() => api.regenerate());
    await load();
    setNotice(describe(r, 'Window extended.'));
  }

  async function take(vehicleId: number) {
    if (!target) return;
    try {
      const b = await withPassword(() =>
        api.book({
          vehicleId,
          pool: target.pool,
          bookingDate: target.date,
          dropSlot: target.dropSlot,
        }),
      );
      setNotice({
        tone: 'ok',
        text: `Booked ${b.reference} — ${b.bookingDate} ${b.dropSlot}, back ${b.expectedPickup}.`,
      });
      setTarget(undefined);
      await load();
    } catch (e) {
      const err = e as ApiError;
      setNotice({
        tone: 'warn',
        text:
          err.body?.kind === 'slot_full'
            ? 'That slot just filled up — the write was refused. Nothing was double-booked.'
            : err.message,
      });
      await load();
    }
  }

  return (
    <div className="space-y-8">
      {notice && (
        <div
          className={`rounded border px-4 py-3 text-sm ${
            notice.tone === 'ok'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
              : 'border-amber-300 bg-amber-50 text-amber-900'
          }`}
        >
          {notice.text}
        </div>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h2 className="text-sm font-semibold tracking-tight">Weekly capacity</h2>
          <p className="flex-1 text-xs text-stone-500">
            Slots per weekday, <strong>net of walk-ins</strong> — if six major bays run and two go
            to walk-ins, put four.
          </p>
          <button
            onClick={() => void save()}
            className="rounded border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-stone-50"
          >
            Save
          </button>
          <button
            onClick={() => void extend()}
            className="rounded bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-700"
          >
            Extend window
          </button>
        </div>

        {master && (
          <div className="overflow-x-auto rounded border border-stone-300 bg-white">
            <table className="nums w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-xs text-stone-500">
                  <th className="px-3 py-2 text-left font-medium">Day</th>
                  {POOLS.map((p) => (
                    <th key={p} colSpan={2} className="border-l border-stone-200 px-3 py-2 font-medium capitalize">
                      {p}
                    </th>
                  ))}
                </tr>
                <tr className="border-b border-stone-200 text-[11px] text-stone-400">
                  <th />
                  {POOLS.flatMap((p) =>
                    DROP_SLOTS.map((s, i) => (
                      <th
                        key={`${p}-${s}`}
                        className={`px-3 py-1 font-normal ${i === 0 ? 'border-l border-stone-200' : ''}`}
                      >
                        {s === 'morning' ? 'am' : 'pm'}
                      </th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {WEEKDAYS.map((name, weekday) => (
                  <tr key={weekday} className="border-b border-stone-100 last:border-0">
                    <td className="px-3 py-1.5 text-stone-600">{name}</td>
                    {POOLS.flatMap((p) =>
                      DROP_SLOTS.map((s, i) => (
                        <td
                          key={`${p}-${s}`}
                          className={`px-2 py-1 ${i === 0 ? 'border-l border-stone-200' : ''}`}
                        >
                          <input
                            type="number"
                            min={0}
                            value={master[weekday]?.[p]?.[s] ?? 0}
                            onChange={(e) =>
                              setMaster({
                                ...master,
                                [weekday]: {
                                  ...master[weekday]!,
                                  [p]: { ...master[weekday]![p], [s]: Number(e.target.value) },
                                },
                              })
                            }
                            className="w-14 rounded border border-stone-200 px-2 py-1 text-center tabular-nums focus:border-stone-500 focus:outline-none"
                          />
                        </td>
                      )),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h2 className="text-sm font-semibold tracking-tight">Next 30 days</h2>
          <p className="text-xs text-stone-500">
            Free of total. Click any slot with room to take it as the call centre.
          </p>
        </div>

        <div className="overflow-x-auto rounded border border-stone-300 bg-white">
          <table className="nums w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-xs text-stone-500">
                <th className="px-3 py-2 text-left font-medium">Date</th>
                {POOLS.map((p) => (
                  <th key={p} colSpan={2} className="border-l border-stone-200 px-3 py-2 font-medium capitalize">
                    {p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {window.map((day) => {
                const isToday = day.date === today;
                return (
                  <tr
                    key={day.date}
                    className={`border-b border-stone-100 last:border-0 ${isToday ? 'bg-stone-50' : ''}`}
                  >
                    <td className="whitespace-nowrap px-3 py-1.5">
                      <span className="text-stone-800">{day.date}</span>
                      <span className="ml-2 text-xs text-stone-400">
                        {WEEKDAYS[day.weekday]?.slice(0, 3)}
                        {isToday && ' · today'}
                      </span>
                    </td>
                    {POOLS.flatMap((p) =>
                      DROP_SLOTS.map((s, i) => {
                        const cell = day.pools[p][s];
                        const full = cell.free === 0;
                        return (
                          <td
                            key={`${p}-${s}`}
                            className={`px-2 py-1 text-center ${i === 0 ? 'border-l border-stone-200' : ''}`}
                          >
                            <button
                              disabled={full}
                              onClick={() =>
                                setTarget({ date: day.date, pool: p, dropSlot: s, free: cell.free })
                              }
                              title={`${p} ${s} — ${cell.booked} of ${cell.total} booked`}
                              className={`w-16 rounded px-1 py-0.5 text-xs tabular-nums ${
                                full
                                  ? 'cursor-not-allowed bg-rose-50 text-rose-700'
                                  : cell.free <= 1
                                    ? 'bg-amber-50 text-amber-800 hover:bg-amber-100'
                                    : 'text-stone-600 hover:bg-stone-100'
                              }`}
                            >
                              {cell.free}/{cell.total}
                            </button>
                          </td>
                        );
                      }),
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {target && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-stone-900/40 p-4"
          onClick={() => setTarget(undefined)}
        >
          <div
            className="max-h-[80vh] w-full max-w-lg overflow-auto rounded border border-stone-300 bg-white p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold">
              Take {target.pool} · {target.dropSlot} · {target.date}
            </h3>
            <p className="mt-1 text-xs text-stone-500">
              {target.free} slot{target.free === 1 ? '' : 's'} free. This books as the call centre
              (<code className="rounded bg-stone-100 px-1">source: dealer</code>) through the same
              write path the AI uses.
            </p>

            <ul className="mt-4 divide-y divide-stone-100">
              {vehicles.map((v) => (
                <li key={v.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">
                      {v.model} <span className="nums text-stone-400">{v.registration_number}</span>
                    </div>
                    <div className="truncate text-xs text-stone-500">
                      {v.customer_name}
                      {v.has_open_booking ? ' · already has an open booking' : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => void take(v.id)}
                    className="rounded border border-stone-300 px-2.5 py-1 text-xs hover:bg-stone-50"
                  >
                    Book
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
