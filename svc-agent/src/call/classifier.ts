import { addDays, parseIsoDate, WEEKDAY_NAMES, type IsoDate } from '../shared/dates.ts';
import type { DropSlot } from '../shared/types.ts';
import type { CallState, ExplainTopic, FaultArea, Language } from './types.ts';
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
  /**
   * D9, D10 — can arrive at any turn and must be answered, then resumed.
   * `explain`: a question about how the booking works ("why next day?"),
   * answered by our code from the call's state. `callback`: they want someone
   * from the centre to call them, or to speak to a person.
   */
  outOfBand?: 'cost' | 'general' | 'explain' | 'callback';
  /** Which booking question, when `outOfBand` is `explain`. */
  explain?: ExplainTopic;
  /** The language the caller spoke this turn in. */
  language?: Language;
  /** Where the fault they described is, from a closed list (B3). */
  faultArea?: FaultArea;
  generalQuestion?: string;
  /** Which knowledge-bank entry the question matched, if any (D10). */
  kbKey?: string;

  yesNo?: 'yes' | 'no';
  /** E3 — the open turn's fork. */
  intent?: 'book' | 'another_problem';

  /** E2, G6 — matched against this caller's own vehicles, never invented. */
  vehicleModel?: string;
  vehicleLast4?: string;
  /** "Two", "the second one" — a car picked from the numbered list we read out (1-based). */
  vehicleChoice?: number;
  /** "Can I also book my wife's car?" — a different car from the one this call is about. */
  otherVehicle?: boolean;

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

/** Hindi weekday names, Sunday first like WEEKDAY_NAMES, Latin and Devanagari. */
const HINDI_WEEKDAYS = [
  /\b(ravivaa?r|itvaa?r)\b|रविवार|इतवार/,
  /\bsomvaa?r\b|सोमवार/,
  /\bmangalvaa?r\b|मंगलवार/,
  /\bbudhvaa?r\b|बुधवार/,
  /\b(guruvaa?r|veervaa?r|brihaspativaa?r)\b|गुरुवार|वीरवार/,
  /\bshukravaa?r\b|शुक्रवार/,
  /\bshanivaa?r\b|शनिवार/,
];

/**
 * Common Hindi words in Indian-English speech, Latin script. Enough of them,
 * or any Devanagari, and the caller is speaking Hinglish: the agent replies
 * in Hinglish (templates.ts HI). Words English also uses ("so", "do") are
 * left out, so "I want to do a service" stays English.
 */
const HINDI_WORDS = new Set([
  'haan', 'haa', 'haanji', 'ji', 'nahi', 'nahin', 'theek', 'thik', 'hai', 'hain', 'tha', 'thi', 'kya', 'kyu', 'kyun',
  'kaise', 'kab', 'kahan', 'mera', 'meri', 'mere', 'mujhe', 'aap', 'aapka', 'aapki', 'hum', 'hamara', 'gaadi', 'gadi',
  'kal', 'parson', 'aaj', 'subah', 'shaam', 'dopahar', 'chahiye', 'karna', 'karni', 'karwana', 'karwani', 'karwa', 'kar',
  'dijiye', 'kijiye', 'karo', 'wali', 'wala', 'waali', 'waala', 'pehli', 'pehla', 'doosri', 'dusri', 'doosra', 'teesri',
  'bas', 'shukriya', 'dhanyavaad', 'dhanyawad', 'achha', 'acha', 'bilkul', 'sahi', 'mein', 'bhi', 'aur', 'kuch', 'koi',
  'kharab', 'awaaz', 'aawaz', 'dikkat', 'chalega', 'bhai', 'bhaiya', 'saab', 'sahab', 'abhi', 'jaldi', 'milegi',
  'ko', 'ke', 'ki', 'se', 'pe', 'wale', 'raha', 'rahi', 'rahe', 'gaya', 'gayi', 'hoga', 'karein', 'chahte', 'chahta',
  'somvaar', 'somvar', 'mangalvaar', 'mangalvar', 'budhvaar', 'budhvar', 'guruvaar', 'guruvar', 'veervaar', 'shukravaar',
  'shukravar', 'shanivaar', 'shanivar', 'ravivaar', 'ravivar', 'itvaar',
]);

/** True when the caller is speaking Hindi or Hinglish. */
export function detectHinglish(utterance: string): boolean {
  if (/[\u0900-\u097F]/.test(utterance)) return true;
  const words = utterance.toLowerCase().split(/[^a-z']+/).filter(Boolean);
  const hindi = words.filter((w) => HINDI_WORDS.has(w)).length;
  return words.length <= 3 ? hindi >= 1 : hindi >= 2;
}

/** Where a described fault is, by the words used (EN and Hinglish). The model does this properly; this is the fallback. */
export function faultAreaOf(t: string): FaultArea | undefined {
  const areas: Array<[FaultArea, RegExp]> = [
    ['gears', /\bgears?\b|\bgearbox\b|\bshift(ing)?\b|\bgear knob\b/],
    ['clutch', /\bclutch\b/],
    ['brakes', /\bbrakes?\b|\bbraking\b/],
    ['ac', /\ba\.?c\.?\b|\bair ?con|\bcooling\b|\bnot cool/],
    ['battery', /\bbattery\b|\bwon'?t start\b|\bstarting\b|\bself\b/],
    ['steering', /\bsteering\b|\bpulls? to\b/],
    ['suspension', /\bsuspension\b|\bshock(er)?s?\b|\bbumps?\b/],
    ['warning_light', /\bwarning light\b|\bcheck engine\b|\bengine light\b|\blight (is )?on\b/],
    ['engine', /\bengine\b|\bpickup\b(?! and)|\bmileage\b|\bsmoke\b|\boverheat/],
    ['electrics', /\belectric(al|s)?\b|\bwiring\b|\bheadlights?\b|\bhorn\b|\bwindow\b/],
    ['tyres', /\btyres?\b|\btires?\b|\bpuncture\b|\balignment\b/],
    ['body', /\bdent\b|\bscratch\b|\bpaint\b|\bbumper\b|\bbody\b/],
    ['noise', /\bnoise\b|\brattl|\bsqueal|\bgrind|\bawaaz\b|\baawaz\b|\bsound\b/],
  ];
  return areas.find(([, re]) => re.test(t))?.[0];
}

/** "Why next day?", "When do I get it back?" — questions about the booking itself, EN and Hinglish. */
export function explainTopicOf(t: string, state: CallState): ExplainTopic | undefined {
  const why = /\bwhy\b|\bkyu(n)?\b|\bkyon\b/.test(t);
  if (why && /\bnext day\b|\btomorrow\b|\bovernight\b|\bagle din\b|\bnot (the )?same.?day\b|\bnot same\b/.test(t)) return 'next_day';
  if (why && /\btoday\b|\baaj\b/.test(t)) return 'not_today';
  if (why && /\bfull\b/.test(t)) return 'day_full';
  if (why && /\b(only|just|sirf|bas)\b.*\b(morning|afternoon|subah|dopahar)\b|\bnot (the )?(morning|afternoon)\b/.test(t)) return 'one_slot';
  if (why && /\b(number|code|otp)\b/.test(t)) return 'why_number';
  if (why && /\b(wrong|problem|fault|complaint)\b/.test(t)) return 'why_fault';
  if (
    state !== 'confirm' &&
    /\b(can|could) i (get|have) it (back )?(the )?same.?day\b|\bsame.?day (possible|milegi|mil sakti|ho sakta)\b|\bsame day (back|return)\b/.test(t)
  )
    return 'same_day_how';
  if (/\bwhen (will|do|can|would) i (get|collect|pick)\b|\bwhen (will|would) (it|the car) be (ready|back|done)\b|\bkab (milegi|tak|mil)\b|\bwhat time .*\b(ready|back)\b/.test(t))
    return 'ready_when';
  if (/\bwhat (do|should) i (do|bring)\b|\bwhere (do|should) i (drop|bring|leave)\b|\bwhat happens (when|at|after)\b|\bkahan (chhod|laana|laani)\b/.test(t))
    return 'drop_off';
  if (/\b(will|do|would) i (get|receive) (a |any )?(confirmation|message|sms|text)\b|\bconfirmation (message|sms|text)?\b|\bmessage aayega\b|\bsms aayega\b/.test(t))
    return 'confirmation';
  if (/\b(can|could) i (change|cancel|reschedule|move)\b.*\b(later|afterwards|after)\b|\bbaad mein\b.*\b(change|badal|cancel)/.test(t)) return 'change_later';
  return undefined;
}

/** "Can someone call me back?", "I want to talk to a person" — EN and Hinglish. */
export function wantsCallback(t: string): boolean {
  if (/\bi'?ll call\b|\bi will call\b|\bmain call\b/.test(t)) return false;
  return /\bcall (me )?back\b|\bcallback\b|\bcall me\b|\bcan someone call\b|\bhave (someone|them|somebody) call\b|\b(speak|talk) (to|with) (a |the |an |some )?(real )?(person|human|someone|somebody|manager|advisor|agent|executive)\b|\bcall karwa|\bcall kar (dena|do|dijiye)\b|\bbaat karwa/.test(
    t,
  );
}

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
  if (/\btomorrow\b|\bkal\b|कल/.test(t)) return addDays(today, 1);
  if (/परसों/.test(t)) return addDays(today, 2);
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(t) || HINDI_WEEKDAYS[i]!.test(t)) return nextWeekday(today, i);
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

/** Words that describe something wrong with a car, for the open turn. */
const FAULT =
  /\bnoise\b|\brattl|\bsqueal|\bgrind|\bwarning light\b|\bnot working\b|\bproblem\b|\bissue\b|\bfault\b|\bleak|\bvibrat|\bsmoke\b|\bgears?\b|\bbrakes?\b|\bclutch\b|\bcomplain|\bkharab\b|\bawaaz\b|\baawaz\b|\bdikkat\b/;

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];
const NUMBERS = ['one', 'two', 'three', 'four', 'five'];
/** "pehli wali", "doosri" — Hindi ordinals, Latin and Devanagari. */
const HINDI_ORDINALS = [/\bpe?h?(e)?li\b|\bpehla\b|\bpahli\b|पहली|पहला/, /\bdoo?sri\b|\bdoo?sra\b|दूसरी|दूसरा/, /\btee?sri\b|\btee?sra\b|तीसरी|तीसरा/, /\bchauthi\b|\bchautha\b|चौथी/, /\bpaanch(vi|wi)\b|पांचवी/];
const HINDI_NUMBERS = ['ek', 'do', 'teen', 'chaar', 'paanch'];

/**
 * The car picked from a numbered list: "the second one", "number two", or
 * just "two" / "2". A four-digit run is a plate, not a choice.
 */
export function listChoice(t: string, count: number): number | undefined {
  const inRange = (n: number) => (n >= 1 && n <= count ? n : undefined);
  const ord = ORDINALS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(t));
  if (ord >= 0) return inRange(ord + 1);
  const hiOrd = HINDI_ORDINALS.findIndex((re) => re.test(t));
  if (hiOrd >= 0) return inRange(hiOrd + 1);
  // "do", "teen wali" — a Hindi number said alone (so "do you…" never counts).
  const hiNum = /^(?:number |nambar )?(ek|do|teen|chaar|paanch)(?: wali| wala| number| nambar)?[.!]?$/.exec(t.trim())?.[1];
  if (hiNum) return inRange(HINDI_NUMBERS.indexOf(hiNum) + 1);
  const named = /\b(?:number|option|no\.?)\s*(one|two|three|four|five|[1-5])\b/.exec(t);
  const word = named?.[1] ?? /^(?:it'?s |the |um,? |uh,? )*(one|two|three|four|five|[1-5])(?: please| one)?[.!]?$/.exec(t.trim())?.[1];
  if (!word) return undefined;
  return inRange(/\d/.test(word) ? Number(word) : NUMBERS.indexOf(word) + 1);
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
    out.language = detectHinglish(req.utterance) ? 'hinglish' : 'english';

    if (wantsCallback(t)) {
      out.outOfBand = 'callback';
      return out;
    }
    const topic = explainTopicOf(t, req.state);
    if (topic) {
      out.outOfBand = 'explain';
      out.explain = topic;
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
      !/\bbook(ing|ed)?\b|\bappointment\b|\bschedule\b|\bnew service\b|\bget (it|my car|the car) serviced\b/.test(t) &&
      // Nor, while a day and time are being settled, "can it be the afternoon instead?".
      !(['day', 'drop_slot', 'confirm_booking'].includes(req.state) &&
        /\b(morning|afternoon|instead|change|move|another day|different)\b/.test(t));

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

    // "Bas, shukriya" / "rehne do" — no thanks — as much a no as "no".
    if (/^(no|nope|nah|not really|that'?s not|wrong|nahi|nahin|na|mat|bas|rehne do|rahne do|shukriya)\b|^(नहीं|ना|बस)/.test(t)) {
      out.yesNo = 'no';
    } else if (
      /^(yes|yeah|yep|yup|correct|that'?s right|right|ok|okay|sure|please do|go ahead|book it|sounds good|perfect|that works|haa?n?|haanji|ji|jee|theek|thik|bilkul|sahi|chalega|kar do|kardo|book kar)\b|^(हाँ|हां|जी|ठीक|बिल्कुल)/.test(
        t,
      )
    ) {
      out.yesNo = 'yes';
    }
    // The closing "Anything else?": these all mean "no, I'm done".
    // "Okay, thanks" and "theek hai, shukriya" are goodbyes too, not a yes.
    if (
      req.state === 'wrap_up' &&
      t.split(/\s+/).length <= 6 &&
      /\bthat'?s (all|it|everything)\b|\bnothing (else|more)\b|\bno,? thanks?\b|\bthank(s| you)\b|\bbye\b|\ball good\b|\bi'?m (good|fine|done)\b|\bbas\b|\bshukriya\b|\bdhanyavaa?d\b|\bdhanyawad\b|\bkuch nahi\b|\baur kuch nahi\b|शुक्रिया|धन्यवाद|बस/.test(t)
    ) {
      out.yesNo = 'no';
    }

    // "Two", "the second one", "number three" — a pick from the cars we read out.
    if (req.state === 'vehicle') {
      const choice = listChoice(t, (req.vehicles ?? []).length);
      if (choice) out.vehicleChoice = choice;
    }

    if (/\bservice\b|\bbook\b|\bappointment\b|\bslot\b|\bkarwana\b|\bkarwani\b|सर्विस|बुक/.test(t)) out.intent = 'book';

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
      /\bwhenever(?! i\b)(?! we\b)\b|\bany ?(day|time)\b|\bsoonest\b|\bearliest\b|\bfirst (one |thing )?(you|available)\b|\basap\b|\byou (pick|choose|decide)\b|\bdoesn'?t matter\b|\bup to you\b/.test(t)
    ) {
      out.noPreference = true;
    }

    if (/\bmorning\b|\bam\b|\b8[:.]?30\b|\bsubah\b|\bsavere\b|सुबह/.test(t)) out.dropSlot = 'morning';
    else if (/\bafternoon\b|\bpm\b|\b2 ?o'?clock\b|\bdopahar\b|\bshaam\b|\b2 baje\b|दोपहर|शाम/.test(t)) out.dropSlot = 'afternoon';

    // A fault in the first sentence: "I can't shift the gears properly".
    if (req.state === 'open_turn' && !out.outOfBand && FAULT.test(t)) {
      out.complaint = req.utterance.trim();
      out.intent = 'book';
      out.faultArea = faultAreaOf(t) ?? 'other';
    }

    // The closing: another car is its own call; anything else to add —
    // "with pickup at my home" — is a request for this booking.
    if (req.state === 'wrap_up' && out.yesNo !== 'no' && !out.outOfBand) {
      if (/\b(also|another|other|second|wife'?s?|husband'?s?|son'?s?|daughter'?s?|father'?s?|mother'?s?)\b.*\b(car|vehicle)\b/.test(t)) {
        out.otherVehicle = true;
      } else if (t.split(/\s+/).length > 3) {
        out.specialRequest = req.utterance.trim();
      }
    }

    // The same-day nudge: asking for it the same day is a yes.
    if (req.state === 'confirm' && !out.yesNo && /\bsame.?day\b|\btoday\b|\bsame evening\b/.test(t)) out.yesNo = 'yes';

    if (req.state === 'complaint') {
      if (out.yesNo === 'no' || /\bnothing\b|\bit'?s fine\b|\ball good\b|\bno issues?\b|\bsab theek\b|\bkoi (problem|dikkat) nahi\b/.test(t)) {
        out.nothing = true;
      } else if (!out.outOfBand) {
        out.complaint = req.utterance.trim();
        out.faultArea = faultAreaOf(t) ?? 'other';
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
      (out.yesNo !== undefined || out.dropSlot !== undefined || out.vehicleChoice !== undefined || /^\d{4,10}$/.test(t));
    // "No, that's all, thanks." is longer than three words and as clear as "no".
    const closing = req.state === 'wrap_up' && out.yesNo === 'no' && words <= 6 && !out.outOfBand;
    if (unambiguous || closing) out.confident = true;

    return out;
  }
}
