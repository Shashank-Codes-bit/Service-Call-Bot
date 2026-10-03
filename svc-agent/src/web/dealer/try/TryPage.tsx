import { useEffect, useRef, useState, type FormEvent } from 'react';
import { browserVoiceSupported, groupLines, startBrowserVoice, startVapi, type Line, type Status, type VoiceCall } from './voice.ts';

type Caller = { name: string; model: string | null; mobile: string; shows: string };
type Centre = {
  slug: string;
  name: string;
  address: string;
  landmark: string;
  days: string;
  opens: string;
  closes: string;
  callers: Caller[];
  anyNumber: boolean;
  voice: { provider: 'vapi'; publicKey: string; assistantId: string } | { provider: 'browser' };
};
type Turn = { sessionId: string; reply: string; ended: boolean; sms?: string[] };

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

const ANOTHER = '';
const phone = (m: string) => `${m.slice(0, 5)} ${m.slice(5)}`;
/** "09:00" → "9 am", "19:00" → "7 pm". */
const hour = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
};

/**
 * The page a centre shares: talk to its agent the way a customer would. Not
 * part of the portal and needs no sign-in. Voice through Vapi when the server
 * has it set up, else the browser's own speech, else typing.
 */
export function TryPage({ slug }: { slug: string }) {
  const [centre, setCentre] = useState<Centre | null>();
  const [pick, setPick] = useState<string>();
  const [typed, setTyped] = useState('');
  const [mode, setMode] = useState<'voice' | 'chat'>();
  const [status, setStatus] = useState<Status>();
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState('');
  const [chatSession, setChatSession] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [usingBrowser, setUsingBrowser] = useState(false);
  const call = useRef<VoiceCall>(undefined);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/public/${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c: Centre | null) => {
        setCentre(c);
        if (c) {
          document.title = `${c.name} · Talk to the agent`;
          setPick(c.callers[0]?.mobile ?? ANOTHER);
        }
      }, () => setCentre(null));
    return () => call.current?.stop();
  }, [slug]);

  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (centre === undefined) return <p className="loading try">Loading…</p>;
  if (centre === null) {
    return (
      <div className="gate">
        <form>
          <h1>Not found</h1>
          <p className="muted">There is no centre at this address. Check the link you were given.</p>
        </form>
      </div>
    );
  }

  const number = pick === ANOTHER ? typed.replace(/\D/g, '') : (pick ?? '');
  const caller = centre.callers.find((c) => c.mobile === number);
  const live = status && status !== 'ended';
  const vapi = centre.voice.provider === 'vapi' && !usingBrowser ? centre.voice : undefined;
  const canBrowser = browserVoiceSupported();

  const events = {
    line: (l: Line) => setLines((ls) => [...ls.filter((x) => !('interim' in x && x.interim)), l]),
    interim: (text: string) =>
      setLines((ls) => [...ls.filter((x) => !('interim' in x && x.interim)), { who: 'caller', text, interim: true }]),
    status: setStatus,
    error: setError,
  };
  const chatApi = {
    start: () => post<Turn>(`/public/${slug}/chat/start`, { callerNumber: number }),
    turn: (sessionId: string, utterance: string) => post<Turn>(`/public/${slug}/chat/turn`, { sessionId, utterance }),
  };

  async function talk() {
    if (number.length !== 10 || live) return;
    setLines([]);
    setError(undefined);
    setMode('voice');
    try {
      call.current = vapi
        ? await startVapi({ publicKey: vapi.publicKey, assistantId: vapi.assistantId, org: centre!.slug, callerNumber: number }, events)
        : await startBrowserVoice(chatApi, events);
    } catch (e) {
      setError((e as Error).message || 'The call could not start.');
      setStatus('ended');
    }
  }

  async function startChat() {
    if (number.length !== 10) return;
    setLines([]);
    setError(undefined);
    setMode('chat');
    setBusy(true);
    try {
      const t = await chatApi.start();
      setChatSession(t.sessionId);
      setLines([{ who: 'agent', text: t.reply }, ...(t.sms ?? []).map((s) => ({ who: 'sms' as const, text: s }))]);
      setStatus(t.ended ? 'ended' : 'listening');
    } catch (e) {
      setError((e as Error).message);
      setStatus('ended');
    } finally {
      setBusy(false);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !chatSession || busy) return;
    setDraft('');
    setLines((ls) => [...ls, { who: 'caller', text }]);
    setBusy(true);
    try {
      const t = await chatApi.turn(chatSession, text);
      setLines((ls) => [...ls, ...(t.reply ? [{ who: 'agent' as const, text: t.reply }] : []), ...(t.sms ?? []).map((s) => ({ who: 'sms' as const, text: s }))]);
      if (t.ended) setStatus('ended');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const end = () => {
    call.current?.stop();
    setStatus('ended');
  };
  const reset = () => {
    call.current?.stop();
    call.current = undefined;
    setMode(undefined);
    setStatus(undefined);
    setLines([]);
    setError(undefined);
    setChatSession(undefined);
  };

  const statusText: Record<Status, string> = {
    connecting: 'Connecting…',
    listening: mode === 'chat' ? 'Chat' : 'Listening… speak now',
    speaking: 'Agent speaking',
    thinking: 'One moment…',
    ended: mode === 'chat' ? 'Chat ended' : 'Call ended',
  };

  return (
    <div className="try">
      <p className="urlbar">{location.host}/try/{centre.slug}</p>
      <div className="hero">
        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <h1>Book your car service by talking to our agent.</h1>
          <p style={{ maxWidth: '52ch' }}>
            It finds your car from your number, tells you which service is due, offers a drop-off the workshop has room for, and
            texts you the booking. Ask it anything about the centre on the way.
          </p>
          <p className="addr">
            {centre.name}
            {centre.address ? ` · ${centre.address}` : ''}
          </p>
          <div className="facts">
            <div>
              <b>{centre.days || 'Open'}</b>
              {hour(centre.opens)} to {hour(centre.closes)}
            </div>
            {centre.landmark && (
              <div>
                <b>Find us</b>
                {centre.landmark.charAt(0).toUpperCase() + centre.landmark.slice(1)}
              </div>
            )}
            <div>
              <b>Drop at 8:30</b>Back the same evening
            </div>
            <div>
              <b>Drop at 2:00</b>Back the next day
            </div>
          </div>
        </div>

        <section className="voice" aria-label="Talk to the agent">
          {!mode ? (
            <>
              <div className="callas">
                <label className="small" style={{ fontWeight: 600 }} htmlFor="try-who">
                  Call as
                </label>
                <select id="try-who" className="field" value={pick ?? ''} onChange={(e) => setPick(e.target.value)}>
                  {centre.callers.map((c) => (
                    <option key={c.mobile} value={c.mobile}>
                      {c.name}
                      {c.model ? ` · ${c.model}` : ''} · {c.shows}
                    </option>
                  ))}
                  {centre.anyNumber && <option value={ANOTHER}>My own number…</option>}
                </select>
                {pick === ANOTHER && (
                  <input
                    className="field nums"
                    inputMode="numeric"
                    placeholder="10-digit mobile"
                    aria-label="Your mobile number"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                  />
                )}
              </div>
              {vapi || canBrowser ? (
                <button type="button" className="talk" disabled={number.length !== 10} onClick={talk}>
                  <span className="mic" aria-hidden="true">
                    ●
                  </span>
                  Talk to the agent
                </button>
              ) : (
                <p className="notice alert">This browser can’t do voice. Chrome or Edge can, or chat below.</p>
              )}
              <p className="modehint">
                {caller ? `You’ll be ${caller.name}, ${phone(caller.mobile)}. ` : number.length === 10 ? `You’ll call from ${phone(number)}; a new number gets a demo car. ` : ''}
                Uses your microphone. {vapi ? 'Speaks Indian English.' : 'Uses your browser’s own voice.'}
                {' '}Best with earphones, so the agent doesn’t hear itself. Let it finish, then answer.
              </p>
              <button type="button" className="linklike small" style={{ justifySelf: 'start' }} onClick={startChat} disabled={number.length !== 10}>
                Prefer typing? Chat instead
              </button>
            </>
          ) : (
            <>
              <div className="status">
                <span className={`live ${status === 'listening' || status === 'speaking' ? 'listen' : ''}`}>{status ? statusText[status] : ''}</span>
                <span className="muted nums">{caller ? `${caller.name}, ${phone(caller.mobile)}` : phone(number)}</span>
              </div>
              <div className="captions" ref={box} aria-live="polite">
                {groupLines(lines).map((l, i) =>
                  l.who === 'sms' ? (
                    <div key={i} className="sms nums">
                      SMS to {phone(number)}
                      {'\n'}
                      {l.text}
                    </div>
                  ) : (
                    <div key={i} className={`msg ${l.who} ${l.interim ? 'interim' : ''}`}>
                      <small>{l.who === 'agent' ? 'Agent' : 'You'}</small>
                      {l.text}
                    </div>
                  ),
                )}
              </div>
              {error && (
                <div className="notice alert" role="alert">
                  {error}
                  {mode === 'voice' && vapi && canBrowser && (
                    <>
                      {' '}
                      <button type="button" className="linklike" onClick={() => { setUsingBrowser(true); reset(); }}>
                        Use the browser’s voice instead
                      </button>
                    </>
                  )}
                </div>
              )}
              {mode === 'chat' && status !== 'ended' && (
                <form onSubmit={send} style={{ display: 'flex', gap: 8 }}>
                  <input className="field" style={{ flex: 1 }} autoFocus placeholder="Say something…" aria-label="Your reply" value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <button type="submit" className="btn primary" disabled={busy || !draft.trim()}>
                    Send
                  </button>
                </form>
              )}
              {live ? (
                <button type="button" className="btn danger" style={{ justifySelf: 'start' }} onClick={end}>
                  {mode === 'chat' ? 'End chat' : 'End call'}
                </button>
              ) : (
                <button type="button" className="btn" style={{ justifySelf: 'start' }} onClick={reset}>
                  Start again
                </button>
              )}
            </>
          )}
        </section>
      </div>
      <p className="small muted">
        A demo of {centre.name}’s booking agent. Bookings made here land on the centre’s board; nothing is sent to a real phone.
      </p>
    </div>
  );
}
