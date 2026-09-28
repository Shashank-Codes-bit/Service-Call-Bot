import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type ChatReply } from '../api.ts';

type Line =
  | { who: 'agent'; text: string; ms: number }
  | { who: 'caller'; text: string }
  | { who: 'sms'; text: string };

type Caller = { name: string; mobile: string };

/** The select value meaning "type a number instead". */
const ANOTHER = '';

/** Round trip as the person waiting feels it — model turns and instant ones. */
const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * The conversation a caller would have on the phone, typed instead of spoken.
 * It drives the same state machine through the same contract a voice layer
 * will, so adding voice later changes the channel, not this conversation.
 */
export function Chat({
  open,
  onClose,
  onEnded,
}: {
  open: boolean;
  onClose: () => void;
  onEnded: () => void;
}) {
  const [callers, setCallers] = useState<Caller[]>([]);
  const [pick, setPick] = useState<string>();
  const [typed, setTyped] = useState('');
  const [sessionId, setSessionId] = useState<string>();
  const [lines, setLines] = useState<Line[]>([]);
  const [last, setLast] = useState<ChatReply>();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const bottom = useRef<HTMLLIElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // Who you can call as: the customers already on the system, one per number.
  useEffect(() => {
    if (!open || pick !== undefined) return;
    api
      .vehicles()
      .then((vs) => {
        const byNumber = new Map<string, Caller>();
        for (const v of vs) {
          if (!byNumber.has(v.mobile_number)) {
            byNumber.set(v.mobile_number, { name: v.customer_name, mobile: v.mobile_number });
          }
        }
        const list = [...byNumber.values()];
        setCallers(list);
        setPick(list[0]?.mobile ?? ANOTHER);
      })
      .catch(() => setPick(ANOTHER));
  }, [open, pick]);

  // A block body, never `() => el.scrollIntoView()`: current Chrome returns a
  // Promise from it (typed as void), React then calls that as the cleanup, and
  // the whole portal unmounts.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [lines, busy]);
  useEffect(() => {
    if (open && sessionId && !busy) input.current?.focus();
  }, [open, sessionId, busy]);

  const number = pick === ANOTHER ? typed.replace(/\D/g, '') : (pick ?? '');

  async function exchange(run: () => Promise<ChatReply>): Promise<ChatReply | undefined> {
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
      setLast(r);
      if (r.ended) onEnded();
      return r;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function start(e: FormEvent) {
    e.preventDefault();
    if (number.length !== 10 || busy) return;
    setLines([]);
    setLast(undefined);
    const r = await exchange(() => api.chatStart(number));
    if (r) setSessionId(r.sessionId);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !sessionId || busy || last?.ended) return;
    setDraft('');
    setLines((ls) => [...ls, { who: 'caller', text }]);
    await exchange(() => api.chatTurn(sessionId, text));
  }

  function reset() {
    setSessionId(undefined);
    setLines([]);
    setLast(undefined);
    setError(undefined);
  }

  return (
    <aside
      aria-label="Chat with the agent"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      className={`${open ? 'flex' : 'hidden'} fixed inset-y-0 right-0 z-20 w-full flex-col border-l border-stone-300 bg-white shadow-xl sm:w-[26rem]`}
    >
      <header className="flex items-center gap-2 border-b border-stone-200 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold tracking-tight">Chat with the agent</h2>
          <p className="text-xs text-stone-500">The conversation a caller has, typed instead of spoken.</p>
        </div>
        {sessionId && (
          <button
            onClick={reset}
            className="rounded border border-stone-300 px-2.5 py-1 text-xs hover:bg-stone-50"
          >
            New chat
          </button>
        )}
        <button
          onClick={onClose}
          aria-label="Close chat"
          className="rounded px-2 py-1 text-lg leading-none text-stone-500 hover:bg-stone-100 hover:text-stone-900"
        >
          ×
        </button>
      </header>

      {!sessionId ? (
        <form onSubmit={(e) => void start(e)} className="space-y-3 p-4">
          <label className="block text-xs font-medium text-stone-600">
            Call as
            <select
              value={pick ?? ''}
              onChange={(e) => setPick(e.target.value)}
              className="mt-1 block w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-sm font-normal text-stone-900"
            >
              {callers.map((c) => (
                <option key={c.mobile} value={c.mobile}>
                  {c.name} · {c.mobile}
                </option>
              ))}
              <option value={ANOTHER}>Another number…</option>
            </select>
          </label>
          {pick === ANOTHER && (
            <input
              inputMode="numeric"
              autoFocus
              aria-label="Mobile number to call from"
              placeholder="10-digit mobile"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="nums block w-full rounded border border-stone-300 px-2 py-1.5 text-sm focus:border-stone-500 focus:outline-none"
            />
          )}
          <p className="text-xs leading-relaxed text-stone-500">
            The agent takes this as the number you are calling from, the way caller ID works on a
            phone.
          </p>
          <button
            type="submit"
            disabled={number.length !== 10 || busy}
            className="w-full rounded bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Connecting…' : 'Start'}
          </button>
          {error && (
            <p role="alert" className="text-xs text-rose-700">
              {error}
            </p>
          )}
        </form>
      ) : (
        <>
          <ol aria-live="polite" className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {lines.map((l, i) =>
              l.who === 'sms' ? (
                <li
                  key={i}
                  className="rounded border border-dashed border-stone-300 px-3 py-2 text-xs whitespace-pre-line text-stone-700"
                >
                  <div className="mb-1 text-[11px] font-medium tracking-wide text-stone-400 uppercase">
                    Text message to {number}
                  </div>
                  {l.text}
                </li>
              ) : (
                <li key={i} className={l.who === 'agent' ? '' : 'text-right'}>
                  <div
                    className={`inline-block max-w-[85%] rounded px-2.5 py-1.5 text-left text-sm ${
                      l.who === 'agent' ? 'bg-stone-100 text-stone-800' : 'bg-sky-50 text-sky-900'
                    }`}
                  >
                    {l.text}
                  </div>
                  {l.who === 'agent' && (
                    <div className="nums mt-0.5 text-[11px] text-stone-400">{took(l.ms)}</div>
                  )}
                </li>
              ),
            )}
            {busy && <li className="text-xs text-stone-400">Agent is typing…</li>}
            <li ref={bottom} aria-hidden />
          </ol>

          {error && (
            <p role="alert" className="border-t border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-800">
              {error}
            </p>
          )}

          {last?.ended ? (
            <div
              className={`border-t px-4 py-3 text-sm ${
                last.bookingReference
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-amber-200 bg-amber-50 text-amber-900'
              }`}
            >
              {last.bookingReference
                ? `Booked ${last.bookingReference} — it is in Arrivals and Calls now.`
                : `Handed to the team: ${(last.leadReason ?? 'call ended').replace(/_/g, ' ')}.`}
              <button onClick={reset} className="ml-2 font-medium underline underline-offset-2">
                Start another
              </button>
            </div>
          ) : (
            <form onSubmit={(e) => void send(e)} className="flex gap-2 border-t border-stone-200 p-3">
              <input
                ref={input}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={busy}
                // A phone switches to its keypad here; the nearest thing a browser has.
                inputMode={last?.expectsDigits ? 'numeric' : 'text'}
                placeholder={last?.expectsDigits ? 'Type the digits' : 'Type a reply'}
                aria-label="Your reply"
                className="min-w-0 flex-1 rounded border border-stone-300 px-2.5 py-1.5 text-sm focus:border-stone-500 focus:outline-none disabled:bg-stone-50"
              />
              <button
                type="submit"
                disabled={busy || !draft.trim()}
                className="rounded bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send
              </button>
            </form>
          )}
        </>
      )}
    </aside>
  );
}
