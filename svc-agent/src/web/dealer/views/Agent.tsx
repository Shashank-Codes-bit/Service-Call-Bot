import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type ChatReply, type Me } from '../api.ts';
import { phone } from '../ui.tsx';

type Line = { who: 'agent' | 'caller'; text: string; ms?: number } | { who: 'sms'; text: string };
type Caller = { name: string; mobile: string; car: string };

/** The customers the agent's scenarios were written around, first in the list. */
const SCENARIOS = ['9810011001', '9810022002', '9810066006', '9810088008', '9810055005', '9810111011'];
const ANOTHER = '';
const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * Talk to your own agent the way a customer would, typed instead of spoken. It
 * drives the same conversation through the same contract the phone line uses,
 * against this centre's own data, so what it books lands on the board.
 */
export function Agent({ me, changed }: { me: Me; changed: () => void }) {
  const [callers, setCallers] = useState<Caller[]>([]);
  const [pick, setPick] = useState<string>();
  const [typed, setTyped] = useState('');
  const [sessionId, setSessionId] = useState<string>();
  const [lines, setLines] = useState<Line[]>([]);
  const [ended, setEnded] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.vehicles().then((vs) => {
      const by = new Map<string, Caller>();
      for (const v of vs) if (!by.has(v.mobile_number)) by.set(v.mobile_number, { name: v.customer_name, mobile: v.mobile_number, car: v.model });
      const list = [...by.values()].sort(
        (a, b) => (SCENARIOS.indexOf(a.mobile) + 1 || 99) - (SCENARIOS.indexOf(b.mobile) + 1 || 99) || a.name.localeCompare(b.name),
      );
      setCallers(list);
      setPick(list[0]?.mobile ?? ANOTHER);
    }, () => setPick(ANOTHER));
  }, []);

  // A block body: scrollTo returns nothing React should call as a cleanup.
  useEffect(() => {
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, busy]);
  useEffect(() => {
    if (sessionId && !busy && !ended) input.current?.focus();
  }, [sessionId, busy, ended]);

  const number = pick === ANOTHER ? typed.replace(/\D/g, '') : (pick ?? '');

  async function exchange(run: () => Promise<ChatReply>) {
    setBusy(true);
    setError(undefined);
    const started = performance.now();
    try {
      const r = await run();
      const ms = performance.now() - started;
      setLines((ls) => [
        ...ls,
        ...(r.reply ? [{ who: 'agent' as const, text: r.reply, ms }] : []),
        ...(r.sms ?? []).map((text) => ({ who: 'sms' as const, text })),
      ]);
      if (r.ended) {
        setEnded(true);
        changed();
      }
      return r;
    } catch (e) {
      setError(e instanceof ApiError && e.kind === 'daily_cap' ? e.message : (e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function start(e: FormEvent) {
    e.preventDefault();
    if (number.length !== 10 || busy) return;
    setLines([]);
    setEnded(false);
    const r = await exchange(() => api.chatStart(number));
    if (r) setSessionId(r.sessionId);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !sessionId || busy || ended) return;
    setDraft('');
    setLines((ls) => [...ls, { who: 'caller', text }]);
    await exchange(() => api.chatTurn(sessionId, text));
  }

  const reset = () => {
    setSessionId(undefined);
    setLines([]);
    setEnded(false);
    setError(undefined);
  };
  const caller = callers.find((c) => c.mobile === number);

  return (
    <div className="agent">
      <div className="dayline">
        <h2>Your agent</h2>
        <span className="small muted">
          Talk to it the way a customer would. Typed for now; the voice button comes next.
          {me.turnCap ? ` ${me.turnCap} turns a day per centre.` : ''}
        </span>
      </div>
      <section className="voice" aria-label="Talk to the agent">
        {!sessionId ? (
          <form onSubmit={start} aria-label="Start a conversation">
            <label className="small" style={{ fontWeight: 600, flexBasis: '100%' }} htmlFor="ag-who">
              Call as
            </label>
            <select id="ag-who" className="field" value={pick ?? ''} onChange={(e) => setPick(e.target.value)}>
              {callers.map((c) => (
                <option key={c.mobile} value={c.mobile}>
                  {c.name} · {c.car} · {phone(c.mobile)}
                </option>
              ))}
              <option value={ANOTHER}>Another number…</option>
            </select>
            {pick === ANOTHER && (
              <input
                className="field nums"
                inputMode="numeric"
                placeholder="10-digit mobile"
                aria-label="Mobile number"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            )}
            <button type="submit" className="btn primary" disabled={number.length !== 10 || busy}>
              {busy ? 'Calling…' : 'Start the conversation'}
            </button>
          </form>
        ) : (
          <>
            <div className="status">
              <span className={`live ${ended ? '' : 'listen'}`}>{ended ? 'Conversation ended' : 'Chat'}</span>
              <span className="muted nums">
                {caller ? `${caller.name}, ${phone(caller.mobile)}` : phone(number)}
              </span>
            </div>
            <div className="thread" ref={thread}>
              {lines.map((l, i) =>
                l.who === 'sms' ? (
                  <div key={i} className="sms nums">
                    {l.text}
                  </div>
                ) : (
                  <div key={i} className={`msg ${l.who}`}>
                    <small>
                      {l.who === 'agent' ? 'Agent' : 'You'}
                      {l.who === 'agent' && l.ms != null ? ` · ${took(l.ms)}` : ''}
                    </small>
                    {l.text}
                  </div>
                ),
              )}
              {busy && <p className="muted small">…</p>}
            </div>
            {ended ? (
              <button type="button" className="btn" style={{ justifySelf: 'start' }} onClick={reset}>
                Start again
              </button>
            ) : (
              <form onSubmit={send}>
                <input ref={input} className="field" placeholder="Say something…" aria-label="Your reply" value={draft} onChange={(e) => setDraft(e.target.value)} />
                <button type="submit" className="btn primary" disabled={busy || !draft.trim()}>
                  Send
                </button>
                <button type="button" className="btn danger" onClick={reset}>
                  End chat
                </button>
              </form>
            )}
          </>
        )}
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </section>
      <p className="small muted">
        Everything the agent books lands on your board and in Conversations. Anything it can’t do goes to the follow-up queue.
      </p>
    </div>
  );
}
