import { useEffect, useState } from 'react';
import { api, dropTime, type CallDetail, type CallRow } from '../api.ts';

/** The outcome of a call, as one readable badge. */
function Outcome({ row }: { row: CallRow }) {
  if (row.booking_reference) {
    return (
      <span className="nums rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800">
        booked {row.booking_reference}
      </span>
    );
  }
  if (row.lead_reason) {
    return (
      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800">
        {row.lead_reason.replace(/_/g, ' ')}
      </span>
    );
  }
  if (row.state !== 'ended') {
    return <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-800">in progress</span>;
  }
  return <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">ended</span>;
}

/**
 * Recent calls, and what was said in them.
 *
 * The transcript is stored verbatim and rendered verbatim — no LLM summarises
 * it, and none ever reads it (F4, B3). The summary beside it is assembled by
 * our code from the session state we already hold.
 */
export function Calls({ today, version }: { today?: string; version?: number }) {
  const [date, setDate] = useState(today ?? '');
  const [rows, setRows] = useState<CallRow[]>();
  const [open, setOpen] = useState<CallDetail>();

  useEffect(() => {
    if (today && !date) setDate(today);
  }, [today, date]);

  useEffect(() => {
    if (!date) return;
    api.calls(date).then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, [date, version]);

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <section className="min-w-0 flex-1">
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h2 className="text-sm font-semibold tracking-tight">Calls</h2>
          <p className="flex-1 text-xs text-stone-500">
            Every call the agent took, what was said, and what came of it.
          </p>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="nums rounded border border-stone-300 px-2 py-1 text-xs"
          />
        </div>

        {/* Until the first answer arrives, "none" would be a claim we can't make. */}
        {!rows ? (
          <p className="px-4 py-8 text-center text-sm text-stone-400">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="rounded border border-dashed border-stone-300 bg-white px-4 py-8 text-center text-sm text-stone-500">
            No calls on {date || 'this day'}.
          </p>
        ) : (
          <div className="overflow-x-auto rounded border border-stone-300 bg-white">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-xs text-stone-500">
                  <th className="px-3 py-2 text-left font-medium">Time</th>
                  <th className="px-3 py-2 text-left font-medium">Caller</th>
                  <th className="px-3 py-2 text-left font-medium">Vehicle</th>
                  <th className="px-3 py-2 text-left font-medium">Turns</th>
                  <th className="px-3 py-2 text-left font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => void api.call(r.id).then(setOpen)}
                    className={`cursor-pointer border-b border-stone-100 last:border-0 hover:bg-stone-50 ${
                      open?.id === r.id ? 'bg-stone-50' : ''
                    }`}
                  >
                    <td className="nums whitespace-nowrap px-3 py-2">
                      {r.started_at.slice(11, 16)}
                      {r.external_id ? (
                        <span className="ml-1 text-xs text-stone-400">phone</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      {r.customer_name ?? <span className="text-stone-400">unidentified</span>}
                      <div className="nums text-xs text-stone-400">{r.caller_number}</div>
                    </td>
                    <td className="px-3 py-2">
                      {r.model ?? <span className="text-stone-400">—</span>}
                      {r.registration ? (
                        <div className="nums text-xs text-stone-400">{r.registration}</div>
                      ) : null}
                    </td>
                    <td className="nums px-3 py-2 text-stone-500">{r.turns}</td>
                    <td className="px-3 py-2">
                      <Outcome row={r} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <aside className="lg:w-[26rem] lg:shrink-0">
        {!open ? (
          <p className="rounded border border-dashed border-stone-300 bg-white px-4 py-8 text-center text-sm text-stone-500">
            Pick a call to read the transcript.
          </p>
        ) : (
          <div className="rounded border border-stone-300 bg-white">
            <div className="border-b border-stone-200 px-4 py-3">
              <h3 className="text-sm font-semibold">
                {open.data.customerName ?? open.data.callerNumber}
              </h3>
              <p className="nums mt-0.5 text-xs text-stone-500">
                {open.data.model ? `${open.data.model} · ` : ''}
                {open.data.bookingDate
                  ? `${open.data.bookingDate} ${dropTime(open.data.dropSlot)}`
                  : 'no booking'}
              </p>
              {open.data.complaintNote ? (
                <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
                  {open.data.complaintNote}
                </p>
              ) : null}
            </div>

            <ol className="max-h-[32rem] space-y-3 overflow-auto px-4 py-3">
              {open.transcript.map((t) => (
                <li key={t.turn_index} className={t.speaker === 'agent' ? '' : 'text-right'}>
                  <div
                    className={`inline-block max-w-[85%] rounded px-2.5 py-1.5 text-sm ${
                      t.speaker === 'agent'
                        ? 'bg-stone-100 text-stone-800'
                        : 'bg-sky-50 text-sky-900'
                    }`}
                  >
                    {t.text}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </aside>
    </div>
  );
}
