import { useCallback, useEffect, useState } from 'react';
import { api, dropTime, withPassword, type ApiError } from '../api.ts';

export function Arrivals({
  today,
  version,
  onChange,
}: {
  today?: string;
  version?: number;
  onChange?: () => void;
}) {
  const [date, setDate] = useState(today ?? '');
  const [rows, setRows] = useState<Record<string, unknown>[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (today && !date) setDate(today);
  }, [today, date]);

  const load = useCallback(() => {
    if (!date) return;
    api.arrivals(date).then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, [date]);

  useEffect(load, [load, version]);

  /**
   * Reception closes a booking. Until this existed nothing could, so a vehicle
   * stayed blocked by its first booking for ever (D13). Cancelling gives the
   * slot back; completing does not — the bay was used.
   */
  async function close(reference: string, status: 'completed' | 'cancelled') {
    const verb = status === 'completed' ? 'Mark' : 'Cancel';
    if (!window.confirm(`${verb} ${reference}${status === 'completed' ? ' as completed' : ''}?`)) return;
    setError(undefined);
    try {
      await withPassword(() => api.closeBooking(reference, status));
    } catch (e) {
      setError((e as ApiError).message);
    }
    load();
    onChange?.();
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Arrivals</h2>
        <p className="flex-1 text-xs text-stone-500">
          Every booking arriving on this day, whatever day it was made. Reception's working
          document.
        </p>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="nums rounded border border-stone-300 px-2 py-1 text-xs"
        />
      </div>

      {error && (
        <p role="alert" className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {error}
        </p>
      )}

      {/* Until the first answer arrives, "none" would be a claim we can't make. */}
      {!rows ? (
        <p className="px-4 py-8 text-center text-sm text-stone-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded border border-dashed border-stone-300 bg-white px-4 py-8 text-center text-sm text-stone-500">
          No cars booked in for {date || 'this day'}.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-stone-300 bg-white">
          <table className="w-full min-w-[60rem] text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-xs text-stone-500">
                <th className="px-3 py-2 text-left font-medium">Reference</th>
                <th className="px-3 py-2 text-left font-medium">Drop</th>
                <th className="px-3 py-2 text-left font-medium">Customer</th>
                <th className="px-3 py-2 text-left font-medium">Vehicle</th>
                <th className="px-3 py-2 text-left font-medium">Job</th>
                <th className="px-3 py-2 text-left font-medium">Back</th>
                <th className="px-3 py-2 text-left font-medium">Via</th>
                <th className="px-3 py-2 text-right font-medium">
                  <span className="sr-only">Close booking</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r['booking_reference'])} className="border-b border-stone-100 last:border-0">
                  <td className="nums px-3 py-2 font-medium">{String(r['booking_reference'])}</td>
                  <td className="nums whitespace-nowrap px-3 py-2">
                    {dropTime(r['drop_slot'])}
                    <span className="ml-1 text-xs text-stone-400">{String(r['drop_slot'])}</span>
                  </td>
                  <td className="px-3 py-2">
                    {String(r['customer_name'])}
                    <div className="nums text-xs text-stone-400">{String(r['mobile_number'])}</div>
                  </td>
                  <td className="px-3 py-2">
                    {String(r['model'])}
                    <div className="nums text-xs text-stone-400">{String(r['registration_number'])}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="capitalize">{String(r['service_type'])}</span>
                    {r['complaint_note'] ? (
                      <div className="max-w-xs truncate text-xs text-stone-500" title={String(r['complaint_note'])}>
                        {String(r['complaint_note'])}
                      </div>
                    ) : null}
                  </td>
                  {/* Always an estimate (D7) — never shown as a commitment. */}
                  <td className="nums px-3 py-2 text-stone-600">
                    {String(r['expected_pickup'])}
                    <div className="text-xs text-stone-400">estimate</div>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        r['source'] === 'ai'
                          ? 'bg-sky-50 text-sky-800'
                          : 'bg-stone-100 text-stone-600'
                      }`}
                    >
                      {r['source'] === 'ai' ? 'AI agent' : 'call centre'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button
                      onClick={() => void close(String(r['booking_reference']), 'completed')}
                      className="rounded border border-stone-300 px-2 py-0.5 text-xs hover:bg-stone-50"
                    >
                      Completed
                    </button>
                    <button
                      onClick={() => void close(String(r['booking_reference']), 'cancelled')}
                      className="ml-1.5 rounded px-2 py-0.5 text-xs text-rose-700 hover:bg-rose-50"
                    >
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
