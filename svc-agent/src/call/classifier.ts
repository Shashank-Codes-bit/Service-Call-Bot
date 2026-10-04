import { addDays, parseIsoDate, WEEKDAY_NAMES, type IsoDate } from '../shared/dates.ts';
import type { DropSlot } from '../shared/types.ts';
import type { CallState } from './types.ts';
import type { KbTopic } from '../kb/index.ts';

/**
 * The one place the LLM is touched (F5, B2). It answers "what did they say",
 * never "what happens next".
 *
 * One call per turn, maximum (G7): the state decides the candidate set, and
 * the always-on overlay — cost, general question, escalation — rides along in
 * the same call. Splitting them is what blows the sub-1s budget.
 */
export type ClassifyRequest = {
  state: CallState;
  utterance: string;
  today: IsoDate;
  /** Closed candidate sets — the LLM matches against these, never invents. */
  vehicles?: { model: string; last4: string }[];
  /**
   * The dealer's knowledge, as a closed set, so the model can only pick a
   * topic the dealer has written an answer for. A shortlist for this
   * utterance (kb/index.ts), not the whole bank, so it stays small however
   * much the centre adds. Carried in the same call, so a general question
   * costs no extra round trip (G7).
   */
  kbTopics?: KbTopic[];
  /**
   * Stripped before the utterance leaves our process (B3, amended): name,
   * mobile, registration, model — all things we already hold, which is what
   * makes redaction possible at all.
   */
  redact?: string[];
};

export type Classification = {
  /** D9, D10 — can arrive at any turn and must be answered, then resumed. */
  outOfBand?: 'cost' | 'general';
  generalQuestion?: string;
  /** Which knowledge-bank entry the question matched, if any (D10). */
  kbKey?: string;

  yesNo?: 'yes' | 'no';
  /** E3 — the open turn's fork. */
  intent?: 'book' | 'another_problem';

  /** E2, G6 — matched against this caller's own vehicles, never invented. */
  vehicleModel?: string;
  vehicleLast4?: string;

  /** Resolved to a date by the LLM; **bookability is decided by our code**. */
  day?: IsoDate;
  /** E7 — "whenever suits you". An answer to the day question, not a refusal. */
  noPreference?: boolean;
  dropSlot?: DropSlot;

  /** D8 — the LLM's job is only to say which of the two this was. */
  complaint?: string;
  specialRequest?: string;
  /** "No, it's fine" — nothing wrong, nothing wanted. */
  nothing?: boolean;

  /** Raw words, quoted into any lead (F2). */
  callerWords: string;

  /**
   * Set only by the stub, and only when the utterance is unmistakable. The
   * machine skips the model entirely on those turns (G7); absent means "ask
   * the real classifier".
   */
  confident?: boolean;
};

export interface Classifier {
  classify(req: ClassifyRequest): Promise<Classification>;
}

/** Strip identifiers we already hold. Step 6's Haiku client calls this. */
export function redactUtterance(utterance: string, redact: string[] = []): string {
  let out = utterance;
  for (const term of redact) {
    if (!term || term.length < 3) continue;
    out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[redacted]');
  }
  return out;
}

// ---------------------------------------------------------------------------
// The stub. Deterministic, no network, no key — so the test suite never
// depends on a model's mood, and so the fast path has something to ask. Same
// contract as Haiku. Not meant to be good at English; the real one is.
// ---------------------------------------------------------------------------

const WEEKDAYS = WEEKDAY_NAMES.map((d) => d.toLowerCase());

/** Next occurrence of a named weekday, strictly after today. */
function nextWeekday(today: IsoDate, weekday: number): IsoDate {
  const from = parseIsoDate(today).getDay();
  return addDays(today, ((weekday - from + 7) % 7) || 7);
}

function parseDayExpression(text: string, today: IsoDate): IsoDate | undefined {
  const t = text.toLowerCase();
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  if (/\bday after tomorrow\b|\bparson\b/.test(t)) return addDays(today, 2);
  if (/\btomorrow\b|\bkal\b/.test(t)) return addDays(today, 1);
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(t)) return nextWeekday(today, i);
  }
  return undefined;
}

/**
 * Words too common to carry meaning. Without this, "where *are* you located"
 * scores against `waiting_*are*a` and wins on a three-letter coincidence.
 */
const STOPWORDS = new Set([
  'the', 'and', 'you', 'are', 'can', 'for', 'was', 'our', 'out', 'who', 'how',
  'why', 'did', 'has', 'have', 'does', 'what', 'when', 'where', 'this', 'that',
  'with', 'from', 'they', 'been', 'will', 'your', 'there', 'about', 'would',
  'could', 'please', 'get', 'got',
]);

/**
 * How many leading characters two words share. A plain prefix test is not
 * enough: "located" and "location" agree for five and then diverge, so
 * neither is a prefix of the other.
 */
function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Too general to say which topic a question is about: "do you service my car". */
const GENERIC = new Set(['service', 'services', 'servicing', 'car', 'cars', 'offer', 'offers', 'check', 'free', 'new']);

/** A customer phrase is in the question when each of its words is. Short words must match exactly. */
function phraseIn(phrase: string, tokens: string[]): boolean {
  const words = phrase.split(/[^a-z0-9]+/).filter(Boolean);
  return (
    words.length > 0 &&
    words.every((p) => tokens.some((w) => (p.length < 4 || w.length < 4 ? w === p : sharedPrefix(w, p) >= 4)))
  );
}

/**
 * Crude word-overlap against the dealer's own topics — the customers' own
 * words first, then the title or key — good enough to develop against, and
 * it must still return nothing when nothing matches. D10 is a rule, not a
 * quality setting.
 */
export function matchKbKey(utterance: string, topics: Array<string | KbTopic> = []): string | undefined {
  const text = utterance.toLowerCase();
  const tokens = text.split(/[^a-z0-9]+/).filter((w) => w && !STOPWORDS.has(w));
  let best: { key: string; score: number } | undefined;
  for (const t of topics) {
    const topic = typeof t === 'string' ? { key: t, title: '', phrases: [] } : t;
    const key = topic.key;
    let score = 3 * topic.phrases.filter((p) => phraseIn(p, tokens)).length;
    const named = `${key} ${topic.title}`.toLowerCase().split(/[_\s-]+/);
    for (const word of [...new Set(named)].filter((w) => w.length > 2 && !GENERIC.has(w))) {
      // Either word may be the longer form, so four shared characters either
      // way — enough for "pay"/"payment", not enough for "car"/"card".
      const hit = text
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w))
        .some((w) => sharedPrefix(w, word) >= Math.min(4, w.length, word.length));
      if (hit) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { key, score };
  }
  return best?.key;
}

export class StubClassifier implements Classifier {
  async classify(req: ClassifyRequest): Promise<Classification> {
    const t = req.utterance.toLowerCase().trim();
    const out: Classification = { callerWords: req.utterance.trim() };

    // The always-on overlay first — these outrank whatever we asked.
    if (/\bhow much\b|\bcost\b|\bprice\b|\bcharge\b|\bexpensive\b/.test(t)) {
      out.outOfBand = 'cost';
      return out;
    }
    // A question about the centre, recognised by shape, never by a list of
    // remembered phrases — that list was what made the old knowledge bank
    // unextendable. Whether we can answer is the bank's business, not ours.
    const asksAboutTheCentre =
      /^(do|does|are|is|can|could|would|what|where|when|how)\b/.test(t) &&
      // Not a fault report phrased as a question — those belong to D8.
      !/\bwrong\b|\bnoise\b|\bnot working\b|\bbroken\b|\bcheck the\b|\bfix\b/.test(t) &&
      // Nor a request to book, which is what the call is for: "Can you help
      // me with booking a service?" read as a question about the centre.
      !/\bbook(ing|ed)?\b|\bappointment\b|\bschedule\b|\bnew service\b|\bget (it|my car|the car) serviced\b/.test(t);

    if (asksAboutTheCentre) {
      out.outOfBand = 'general';
      out.generalQuestion = req.utterance.trim();
      // Undefined when nothing matches, so the machine ends the call rather
      // than answering with whatever was nearest (D10).
      out.kbKey = matchKbKey(t, req.kbTopics);
      return out;
    }

    if (/\bwon'?t start\b|\bbreak ?down\b|\bbroken down\b|\btowed?\b|\baccident\b|\bcomplain\b.*\bmanager\b/.test(t)) {
      out.intent = 'another_problem';
      return out;
    }

    if (/^(yes|yeah|yep|yup|correct|that'?s right|right|ok|okay|sure|please do)\b/.test(t)) {
      out.yesNo = 'yes';
    } else if (/^(no|nope|nah|not really|that'?s not|wrong)\b/.test(t)) {
      out.yesNo = 'no';
    }

    if (/\bservice\b|\bbook\b|\bappointment\b|\bslot\b/.test(t)) out.intent = 'book';

    // Closed-set vehicle match — this caller's own cars only.
    for (const v of req.vehicles ?? []) {
      if (new RegExp(`\\b${v.model.toLowerCase()}\\b`).test(t)) out.vehicleModel = v.model;
      if (t.includes(v.last4)) out.vehicleLast4 = v.last4;
    }
    if (!out.vehicleLast4) {
      const four = t.match(/\b(\d{4})\b/);
      if (four && !/\b20\d{2}\b/.test(four[1]!)) out.vehicleLast4 = four[1];
    }

    const day = parseDayExpression(t, req.today);
    if (day) out.day = day;
    else if (
      /\bwhenever\b|\bany ?(day|time)\b|\bsoonest\b|\bearliest\b|\bfirst (one |thing )?(you|available)\b|\basap\b|\byou (pick|choose|decide)\b|\bdoesn'?t matter\b|\bup to you\b/.test(t)
    ) {
      out.noPreference = true;
    }

    if (/\bmorning\b|\bam\b|\b8[:.]?30\b/.test(t)) out.dropSlot = 'morning';
    else if (/\bafternoon\b|\bpm\b|\b2 ?o'?clock\b/.test(t)) out.dropSlot = 'afternoon';

    if (req.state === 'complaint') {
      if (out.yesNo === 'no' || /\bnothing\b|\bit'?s fine\b|\ball good\b|\bno issues?\b/.test(t)) {
        out.nothing = true;
      } else if (!out.outOfBand) {
        out.complaint = req.utterance.trim();
      }
    }

    if (req.state === 'special_request') {
      if (out.yesNo === 'no' || /\bnothing\b|\bno thanks?\b|\bthat'?s it\b/.test(t)) {
        out.nothing = true;
      } else if (!out.outOfBand) {
        out.specialRequest = req.utterance.trim();
      }
    }

    // Deliberately narrow. Half a real call is "yes", "morning", "4471" —
    // worth answering without a round trip. Anything longer defers: a wrong
    // fast answer costs far more than a slow right one.
    const words = t.split(/\s+/).filter(Boolean).length;
    const unambiguous =
      words <= 3 &&
      !out.outOfBand &&
      !out.complaint &&
      !out.specialRequest &&
      // These two states carry meaning the stub cannot read.
      req.state !== 'open_turn' &&
      req.state !== 'complaint' &&
      (out.yesNo !== undefined || out.dropSlot !== undefined || /^\d{4,10}$/.test(t));
    if (unambiguous) out.confident = true;

    return out;
  }
}
