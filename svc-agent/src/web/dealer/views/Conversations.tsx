import { useEffect, useState } from 'react';
import { api, type CallDetail, type CallRow, type Me } from '../api.ts';
import { callOutcome, clock, phone, Plate, shortDay, SLOT, when } from '../ui.tsx';

/** What the agent said and what came of it: the stored transcript, verbatim. */
export function Conversations({
  me,
  version,
  selected,
  go,
}: {
  me: Me;
  version: number;
  selected?: string;
  go: (page: 'conversations', arg?: string) => void;
}) {
  const [rows, setRows] = useState<CallRow[]>();
  const [detail, setDetail] = useState<CallDetail>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.calls(7).then((c) => setRows(c.rows), (e: Error) => setError(e.message));
  }, [version]);

  const current = selected ?? rows?.[0]?.id;
  useEffect(() => {
    if (!current) return setDetail(undefined);
    api.call(current).then(setDetail, (e: Error) => setError(e.message));
  }, [current, version]);

  const today = (rows ?? []).filter((r) => r.started_at.slice(0, 10) === me.today);
  const row = rows?.find((r) => r.id === current);
  const who = (c: CallRow) => c.customer_name ?? c.known_name ?? 'Not registered';
  const data = detail?.data as { bookingDate?: string; dropSlot?: 'morning' | 'afternoon' } | undefined;

  return (
    <>
      <div className="dayline">
        <h2>Conversations</h2>
        <span className="pill nums">
          <b>{today.length}</b> today
        </span>
        <span className="pill ok nums">
          <b>{today.filter((r) => r.booking_reference).length}</b> booked
        </span>
        <span className="pill alert nums">
          <b>{today.filter((r) => r.lead_reason).length}</b> passed to the team
        </span>
        <span className="small muted">Last 7 days</span>
      </div>
      {error && <p className="err">{error}</p>}
      <div className="split">
        <div className="list">
          {rows?.length === 0 && <div className="empty">No conversations in the last 7 days. Try the agent from your profile menu.</div>}
          {(rows ?? []).map((c) => {
            const o = callOutcome(c);
            return (
              <button type="button" key={c.id} className="pick" aria-pressed={c.id === current} onClick={() => go('conversations', c.id)}>
                <div className="row">
                  <strong>{who(c)}</strong>
                  <span className="muted nums small">
                    {when(c.started_at, me.today)} · {c.turns} lines
                  </span>
                </div>
                <div className="row">
                  {c.registration ? <Plate reg={c.registration} /> : <span className="nums muted">{phone(c.caller_number)}</span>}
                  <span className={`outcome ${o.kind}`}>{o.text}</span>
                </div>
              </button>
            );
          })}
        </div>
        {row && detail ? (
          <section className="panel">
            <h3>
              {who(row)}{' '}
              <span className="nums">
                {phone(row.caller_number)} · {shortDay(row.started_at.slice(0, 10))} {clock(row.started_at)}
              </span>
            </h3>
            {row.booking_reference && (
              <div className="notice ok nums">
                Booked {row.booking_reference}
                {data?.bookingDate && data.dropSlot ? ` · ${shortDay(data.bookingDate)}, drop ${SLOT[data.dropSlot].time}` : ''}
              </div>
            )}
            {row.lead_reason && <div className="notice alert">{callOutcome(row).text}. It is in the follow-up queue.</div>}
            <div className="transcript">
              {detail.transcript.map((t) => (
                <div key={t.turn_index} className={`msg ${t.speaker}`}>
                  <small>{t.speaker === 'agent' ? 'Agent' : 'Caller'}</small>
                  {t.text}
                </div>
              ))}
            </div>
          </section>
        ) : (
          rows && rows.length > 0 && <p className="loading">Loading…</p>
        )}
      </div>
    </>
  );
}
