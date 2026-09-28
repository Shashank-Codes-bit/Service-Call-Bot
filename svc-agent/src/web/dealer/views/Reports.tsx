import { useEffect, useState } from 'react';
import { api, type Report } from '../api.ts';

/** Columns worth showing, in reading order. Anything else is folded away. */
const COLUMNS: [key: string, label: string][] = [
  ['created_at', 'When'],
  ['customer_name', 'Customer'],
  ['mobile_number', 'Mobile'],
  ['vehicle_model', 'Vehicle'],
  ['vehicle_registration', 'Reg'],
  ['due_date', 'Due'],
  ['requested_date', 'Wanted'],
  ['requested_slot', 'Slot'],
  ['requested_pool', 'Job'],
  ['caller_words', 'Their words'],
  ['booking_reference', 'Reference'],
  ['booking_date', 'Booked for'],
  ['drop_slot', 'Drop'],
  ['expected_pickup', 'Back'],
  ['model', 'Vehicle'],
  ['registration_number', 'Reg'],
  ['service_type', 'Job'],
  ['source', 'Via'],
];

function short(v: unknown): string {
  if (v == null || v === '') return '—';
  const s = String(v);
  // Timestamps carry a date we already show in the header; keep the clock only.
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(11, 16) : s;
}

function Table({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded border border-dashed border-stone-300 bg-white px-4 py-6 text-center text-sm text-stone-500">
        Nothing on this list today. That is usually good news.
      </p>
    );
  }
  const cols = COLUMNS.filter(([k]) => rows.some((r) => r[k] != null && r[k] !== ''));

  return (
    <div className="overflow-x-auto rounded border border-stone-300 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-stone-200 text-xs text-stone-500">
            {cols.map(([k, label]) => (
              <th key={k} className="px-3 py-2 text-left font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-stone-100 last:border-0 align-top">
              {cols.map(([k]) => (
                <td
                  key={k}
                  className={`px-3 py-2 ${k === 'caller_words' ? 'max-w-sm text-stone-600 italic' : 'nums whitespace-nowrap'}`}
                >
                  {k === 'caller_words' ? `“${short(r[k])}”` : short(r[k])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Reports({ today }: { today?: string }) {
  const [list, setList] = useState<{ audience: string; title: string; why: string }[]>([]);
  const [audience, setAudience] = useState('customer-care');
  const [date, setDate] = useState(today ?? '');
  const [report, setReport] = useState<Report>();

  useEffect(() => {
    api.reportList().then(setList).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (today && !date) setDate(today);
  }, [today, date]);

  useEffect(() => {
    if (!date) return;
    api.report(audience, date).then(setReport).catch(() => setReport(undefined));
  }, [audience, date]);

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <aside className="lg:w-56 lg:shrink-0">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold tracking-tight">Reports</h2>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="nums ml-auto rounded border border-stone-300 px-2 py-1 text-xs lg:ml-0"
          />
        </div>
        <nav className="flex flex-wrap gap-1 lg:flex-col">
          {list.map((r) => (
            <button
              key={r.audience}
              onClick={() => setAudience(r.audience)}
              className={`rounded px-3 py-1.5 text-left text-sm transition-colors ${
                audience === r.audience
                  ? 'bg-stone-900 text-white'
                  : 'text-stone-600 hover:bg-stone-200'
              }`}
            >
              {r.title}
            </button>
          ))}
        </nav>
        <p className="mt-4 hidden text-xs leading-relaxed text-stone-500 lg:block">
          Generated on demand for the day you pick. Nothing is marked closed here — these are
          working lists, not a queue.
        </p>
      </aside>

      <section className="min-w-0 flex-1">
        {report && (
          <>
            <h3 className="text-base font-semibold tracking-tight">{report.title}</h3>
            <p className="mb-4 max-w-2xl text-xs leading-relaxed text-stone-500">{report.why}</p>

            {report.groups ? (
              // Retention splits the merged free-service reason back into its two
              // call scripts — same rows, two different conversations.
              <div className="space-y-6">
                {report.groups.map((g) => (
                  <div key={g.label}>
                    <h4 className="text-sm font-medium">
                      {g.label}{' '}
                      <span className="nums font-normal text-stone-400">{g.rows.length}</span>
                    </h4>
                    <p className="mb-2 max-w-2xl text-xs text-stone-500">{g.hint}</p>
                    <Table rows={g.rows} />
                  </div>
                ))}
              </div>
            ) : (
              <Table rows={report.rows} />
            )}
          </>
        )}
      </section>
    </div>
  );
}
