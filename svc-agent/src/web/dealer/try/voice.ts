/**
 * The two ways the public page can hold a spoken conversation, behind one
 * shape so the page doesn't care which it got:
 *
 * - **Vapi**: real call audio — Indian-English speech recognition and voice,
 *   interruptions, and the same path a phone number will use. The agent's
 *   words still come from our server (the custom-LLM adapter).
 * - **Browser**: the browser's own speech recognition and voice, driving our
 *   typed-chat endpoints turn by turn. Free, no account; Chrome and Edge.
 */

export type Line = { who: 'agent' | 'caller'; text: string; interim?: boolean } | { who: 'sms'; text: string };
export type Status = 'connecting' | 'listening' | 'speaking' | 'thinking' | 'ended';

export type VoiceEvents = {
  line: (l: Line) => void;
  /** Replace the last interim caller line (what they're saying, as they say it). */
  interim: (text: string) => void;
  status: (s: Status) => void;
  error: (message: string) => void;
};

export type VoiceCall = { stop: () => void };

/** One bubble: a speaker's consecutive pieces, the last perhaps still being spoken. */
export type Bubble = { who: 'agent' | 'caller' | 'sms'; text: string; interim: boolean };

/**
 * Vapi sends what the agent says as several final pieces, one per phrase, and
 * the caller's words arrive the same way. Shown one per box, a single sentence
 * read as five. Consecutive pieces from the same speaker form one bubble; a
 * caller's in-progress words sit at the end of their bubble until final.
 */
export function groupLines(lines: Line[]): Bubble[] {
  const out: Bubble[] = [];
  for (const l of lines) {
    const interim = 'interim' in l && Boolean(l.interim);
    const last = out.at(-1);
    if (l.who !== 'sms' && last && last.who === l.who && !last.interim) {
      last.text = `${last.text} ${l.text}`.replace(/\s+/g, ' ').trim();
      last.interim = interim;
    } else {
      out.push({ who: l.who, text: l.text.trim(), interim });
    }
  }
  return out;
}

/** A sentence for whatever shape the SDK's error arrived in. Never "[object Object]". */
export function errorText(e: unknown): string {
  const pick = (v: unknown): string | undefined => {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (!v || typeof v !== 'object') return undefined;
    const o = v as Record<string, unknown>;
    for (const k of ['errorMsg', 'message', 'msg', 'error', 'reason', 'type']) {
      const found = pick(o[k]);
      if (found) return found;
    }
    return undefined;
  };
  const text = pick(e);
  if (text) return text.slice(0, 160);
  try {
    return JSON.stringify(e).slice(0, 160);
  } catch {
    return 'unknown error';
  }
}

/** The meeting ending — Vapi hanging up after the agent's goodbye — is not a failure. */
export function isNormalEnd(e: unknown): boolean {
  return /ejected|meeting (has )?ended|meeting-ended|call-ended|call has ended|left-meeting/i.test(
    (() => {
      try {
        return `${errorText(e)} ${JSON.stringify(e)}`;
      } catch {
        return errorText(e);
      }
    })(),
  );
}

// ---------------------------------------------------------------------------
// Vapi
// ---------------------------------------------------------------------------

type VapiClass = typeof import('@vapi-ai/web').default;

/**
 * The SDK is CommonJS (`exports.default = Vapi`). The dev server hands back
 * the class as `default`; the production build wraps the module once more,
 * so it sits at `default.default`. Take whichever is the constructor — the
 * plain `default` was "not a constructor" on the live site.
 */
export function vapiClassOf(mod: unknown): VapiClass {
  const m = mod as { default?: unknown };
  const candidates = [m?.default, (m?.default as { default?: unknown } | undefined)?.default, mod];
  const found = candidates.find((c) => typeof c === 'function');
  if (!found) throw new Error('The voice library did not load properly. Use the browser’s voice instead.');
  return found as VapiClass;
}

async function loadVapi(): Promise<VapiClass> {
  return vapiClassOf(await import('@vapi-ai/web'));
}

type VapiMessage = { type?: string; role?: string; transcriptType?: string; transcript?: string };

export async function startVapi(
  opts: { publicKey: string; assistantId: string; org: string; callerNumber: string },
  on: VoiceEvents,
): Promise<VoiceCall> {
  // Loaded only when someone presses Talk: the SDK is large, and the portal never needs it.
  const vapi = new (await loadVapi())(opts.publicKey);
  on.status('connecting');
  vapi.on('call-start', () => on.status('listening'));
  vapi.on('speech-start', () => on.status('speaking'));
  vapi.on('speech-end', () => on.status('listening'));
  vapi.on('call-end', () => on.status('ended'));
  vapi.on('error', (e: unknown) => {
    // The SDK reports the call being hung up — by us, after "Goodbye." — as an
    // error too. That is the call ending, not failing.
    if (isNormalEnd(e)) return on.status('ended');
    on.error(`The voice line failed: ${errorText(e)}`);
    on.status('ended');
  });
  vapi.on('message', (m: VapiMessage) => {
    if (m.type !== 'transcript' || !m.transcript) return;
    const who = m.role === 'assistant' ? 'agent' : 'caller';
    if (m.transcriptType === 'final') on.line({ who, text: m.transcript });
    else if (who === 'caller') on.interim(m.transcript);
  });
  await vapi.start(opts.assistantId, {
    // Which centre and who is calling. Vapi fills these into the assistant's
    // system message, which our adapter reads (vapi.ts `callIdentity`).
    variableValues: { org: opts.org, callerNumber: opts.callerNumber },
  });
  return { stop: () => void vapi.stop() };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start: () => void;
  abort: () => void;
};
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const browserVoiceSupported = () => Boolean(recognitionCtor() && 'speechSynthesis' in window);

/** An Indian-English voice when the device has one, else any English one. */
function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) => v.lang === 'en-IN') ??
    voices.find((v) => v.lang.startsWith('en-IN')) ??
    voices.find((v) => v.lang.startsWith('en-GB')) ??
    voices.find((v) => v.lang.startsWith('en'))
  );
}

type Turn = { sessionId: string; reply: string; ended: boolean; sms?: string[] };

/**
 * Speak, listen, send, repeat. The microphone is off while the agent speaks,
 * so it never hears itself; three silent listens in a row end the call.
 */
export async function startBrowserVoice(
  api: { start: () => Promise<Turn>; turn: (sessionId: string, text: string) => Promise<Turn> },
  on: VoiceEvents,
): Promise<VoiceCall> {
  const Ctor = recognitionCtor()!;
  let stopped = false;
  let rec: Recognition | undefined;
  let silences = 0;

  const speak = (text: string) =>
    new Promise<void>((resolve) => {
      if (stopped || !text) return resolve();
      on.status('speaking');
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) u.voice = v;
      u.lang = v?.lang ?? 'en-IN';
      u.rate = 1.02;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });

  const show = async (t: Turn) => {
    if (t.reply) on.line({ who: 'agent', text: t.reply });
    for (const s of t.sms ?? []) on.line({ who: 'sms', text: s });
    await speak(t.reply);
  };

  let sessionId = '';
  const listen = () => {
    if (stopped) return;
    on.status('listening');
    let heard = '';
    rec = new Ctor();
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      const r = e.results[e.results.length - 1]!;
      heard = Array.from(e.results).map((x) => x[0]!.transcript).join(' ').trim();
      if (!r.isFinal) on.interim(heard);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        on.error('The microphone is blocked. Allow it in the address bar, or use the typed chat.');
        stop();
      }
    };
    rec.onend = async () => {
      if (stopped) return;
      if (!heard) {
        if (++silences >= 3) {
          on.error("I didn't hear anything, so I've ended the call. Press Talk to try again.");
          return stop();
        }
        return listen();
      }
      silences = 0;
      on.line({ who: 'caller', text: heard });
      on.status('thinking');
      try {
        const t = await api.turn(sessionId, heard);
        await show(t);
        if (t.ended) return stop();
        listen();
      } catch (err) {
        on.error((err as Error).message);
        stop();
      }
    };
    rec.start();
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    rec?.abort();
    window.speechSynthesis.cancel();
    on.status('ended');
  }

  on.status('connecting');
  // Some browsers load their voices late; asking once warms the list.
  window.speechSynthesis.getVoices();
  const first = await api.start();
  sessionId = first.sessionId;
  await show(first);
  if (first.ended) stop();
  else listen();
  return { stop };
}
