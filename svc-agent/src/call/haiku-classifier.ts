import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { config } from '../config.ts';
import { addDays, weekdayOf, WEEKDAY_NAMES as WEEKDAY, type IsoDate } from '../shared/dates.ts';
import type { DropSlot } from '../shared/types.ts';
import { redactUtterance, type Classification, type ClassifyRequest, type Classifier } from './classifier.ts';
import type { CallState } from './types.ts';

/**
 * The only place the LLM is touched (F5). It answers what the caller said,
 * against a candidate set our code supplies — never what happens next, never
 * a database record, never a word the caller hears (B1, B2, B3).
 */

export const CLASSIFIER_MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 256;

/**
 * Stable across every turn, and placed first so it *can* cache. Measured, it
 * currently does not: a real call reported `cache_read_input_tokens: 0` every
 * turn, the ~1k-token prefix being under the minimum cacheable size. The
 * `cache_control` below is a no-op today. Do not count it as a saving.
 */
const SYSTEM = `You classify a single caller utterance from a phone call to a car service centre in India. You are not an assistant and you never reply to the caller — another system writes every word they hear.

Rules:
- Report only what the caller said. Never infer what should happen next, never apply business rules, never decide whether a booking is possible.
- Match vehicles ONLY against the candidate list given. If none match, say none.
- Resolve date expressions to a calendar date using the call date supplied. Handle relative forms ("tomorrow", "day after next", "next Tuesday", "end of the week") and Hindi/Hinglish forms that appear in Indian English speech ("kal" = tomorrow, "parson" = day after tomorrow, "subah" = morning, "shaam"/"dopahar" = afternoon). Resolve to a real date; do not judge whether it is bookable.
- A cost question ("how much", "what'll it run me") is out_of_band "cost", whatever else is in the sentence.
- A question about the centre itself rather than about the caller's car or booking is out_of_band "general". Judge this by what is being asked about — the premises, the services offered, how things work there — NOT by whether it appears in the topic list. The topic list says only which questions this centre has published an answer to; a question outside it is still a general question, and you must then set kb_key to "none".
- escalation is true only for something the workshop must handle as an incident: the car will not start, a breakdown, an accident, needing recovery, or a serious grievance. A routine fault to be fixed at the service is NOT an escalation, it is a complaint.
- A complaint is something wrong with the car. A special request is something the caller wants done while it is in (a wash, an interior clean). Distinguish them.
- Indian English is the norm. Callers are brief and often answer several questions at once.`;

/**
 * The next fortnight, dated and named, so "Thursday" is a lookup rather than
 * arithmetic. Fourteen days covers every expression a caller reaches for;
 * anything further out they state as a date.
 */
function calendar(today: IsoDate, days = 14): string {
  return Array.from({ length: days }, (_, i) => {
    const d = addDays(today, i);
    return `${d} ${WEEKDAY[weekdayOf(d)]}`;
  }).join(', ');
}

const SLOT = z.enum(['morning', 'afternoon', 'none']);
const YESNO = z.enum(['yes', 'no', 'unclear']);

/**
 * Every state carries this, so an out-of-band turn costs no extra call (G7).
 * `kb_key` is built from the dealer's own rows, so the model picks a topic
 * they have written an answer for or says none — it cannot invent a dealer
 * fact (B2), and `none` ends the call rather than guessing (D10).
 */
function overlayFor(kbKeys: string[]) {
  return {
    out_of_band: z
      .enum(['none', 'cost', 'general'])
      .describe('cost = asking what it will cost. general = asking about the centre itself.'),
    escalation: z.boolean().describe('True only for a breakdown, accident, or serious grievance.'),
    kb_key: z
      .enum(['none', ...kbKeys] as [string, ...string[]])
      .describe(
        'Only when out_of_band is "general": which of these topics the question is about. ' +
          'Choose "none" if it is not clearly one of them — a wrong answer about the dealer ' +
          'is worse than no answer.',
      ),
  };
}

/**
 * The schema is built per state, so the model is only ever offered the fields
 * that state can act on. A closed question with a closed answer set.
 */
function schemaFor(state: CallState, models: string[], kbKeys: string[]) {
  const overlay = overlayFor(kbKeys);
  const vehicle = {
    // A closed set: the caller's own cars and nothing else, so the model can
    // only match, never invent a vehicle they do not own.
    model: z
      .enum(['none', ...models] as [string, ...string[]])
      .describe("The caller's own vehicle they named, or 'none'."),
    last4: z.string().describe('Last four digits of the registration if spoken, else "".'),
  };
  // A pick from the numbered list we read out: "two", "the second one".
  const choice = {
    choice: z
      .enum(['none', '1', '2', '3', '4', '5'])
      .describe('If they picked a car by its number in the list ("two", "the second one"), that number; else "none".'),
  };
  const day = {
    date: z.string().describe('Resolved calendar date as YYYY-MM-DD, or "" if no day was given.'),
    slot: SLOT,
    no_preference: z
      .boolean()
      .describe(
        'True only when the caller said any day would do — "whenever", "the ' +
          'soonest you have", "you pick". Not true when they simply gave no day.',
      ),
  };

  switch (state) {
    case 'greeting':
    case 'confirm':
      return z.object({ ...overlay, answer: YESNO });
    case 'wrap_up':
      // "Book it for 8:30 with pickup at my home" — a request to add, not a no.
      return z.object({
        ...overlay,
        answer: YESNO,
        intent: z.enum(['book', 'other', 'unclear']),
        kind: z.enum(['special_request', 'nothing']),
        text: z.string().describe('Anything they asked to add or have done (e.g. a pickup), in their own words, else "".'),
        other_car: z.boolean().describe('True only when they want something for a DIFFERENT car from the one just discussed.'),
        ...day,
      });
    case 'confirm_booking':
      // "No, make it Saturday" changes the booking in the same breath.
      return z.object({ ...overlay, ...day, answer: YESNO });
    case 'vehicle':
      return z.object({ ...overlay, ...vehicle, ...choice });
    case 'open_turn':
      // Callers often describe the fault in their first sentence; asking
      // "is anything wrong?" after that sounded like the agent wasn't listening.
      return z.object({
        ...overlay,
        intent: z.enum(['book', 'other', 'unclear']),
        ...vehicle,
        ...day,
        kind: z.enum(['complaint', 'nothing']),
        text: z.string().describe("A fault with the car they described, in their own words, else \"\"."),
      });
    case 'complaint':
      return z.object({
        ...overlay,
        kind: z.enum(['complaint', 'special_request', 'nothing']),
        text: z.string().describe("The fault or request in the caller's own words, else \"\"."),
        ...day,
      });
    case 'special_request':
      return z.object({
        ...overlay,
        kind: z.enum(['special_request', 'nothing']),
        text: z.string(),
        ...day,
      });
    case 'day':
      return z.object({ ...overlay, ...day });
    case 'drop_slot':
      return z.object({ ...overlay, ...day, answer: YESNO });
    default:
      return z.object({ ...overlay, answer: YESNO });
  }
}

export type Parsed = Record<string, unknown>;

export type HaikuOptions = {
  client?: Anthropic;
  /** Accumulates token usage so cost can be measured rather than guessed. */
  onUsage?: (u: { input: number; output: number; cacheRead: number }) => void;
};

export class HaikuClassifier implements Classifier {
  private readonly client: Anthropic;
  /** Requests made — asserted against turns taken, to hold G7's one-per-turn. */
  calls = 0;

  constructor(private readonly opts: HaikuOptions = {}) {
    this.client = opts.client ?? new Anthropic({ apiKey: config.anthropicApiKey });
  }

  async classify(req: ClassifyRequest): Promise<Classification> {
    const models = (req.vehicles ?? []).map((v) => v.model);
    const schema = schemaFor(
      req.state,
      [...new Set(models)].filter((m) => m !== 'none'),
      [...new Set((req.kbTopics ?? []).map((t) => t.key))].filter((k) => k && k !== 'none'),
    );

    // B3 (amended): strip what we already hold before the words leave this
    // process. Asserted by test against the outgoing payload, not by trust.
    const safe = redactUtterance(req.utterance, req.redact);

    // Numbered in the order the cars were read out, so "two" can be matched.
    const candidates = (req.vehicles ?? [])
      .map((v, i) => `${i + 1}. ${v.model} (registration ends ${v.last4})`)
      .join('\n');

    // The shortlist for this utterance, named so the model can recognise a
    // topic by what it is rather than by its key.
    const topics = (req.kbTopics ?? [])
      .map((t) => `- ${t.key}: ${t.title}${t.phrases.length ? ` (customers say: ${t.phrases.slice(0, 8).join(', ')})` : ''}`)
      .join('\n');

    const user =
      `Call date: ${req.today} (${WEEKDAY[weekdayOf(req.today)]})\n` +
      // Weekday names given, not implied. From "2026-09-14" alone the model
      // got "Thursday" wrong by a day on a busy sentence and right on a short
      // one — it was doing arithmetic. This makes it a lookup.
      `Calendar: ${calendar(req.today)}\n` +
      `Conversation point: ${describeState(req.state)}\n` +
      (candidates ? `Caller's vehicles:\n${candidates}\n` : '') +
      (topics ? `Topics this centre has published answers for (kb_key):\n${topics}\n` : '') +
      `\nCaller said: "${safe}"`;

    this.calls += 1;
    const res = await this.client.messages.parse({
      model: CLASSIFIER_MODEL,
      max_tokens: MAX_TOKENS,
      // No `thinking`: a closed-set classification needs none, and it is the
      // whole latency budget (G7).
      system: SYSTEM,
      cache_control: { type: 'ephemeral' },
      messages: [{ role: 'user', content: user }],
      output_config: { format: zodOutputFormat(schema) },
    });

    this.opts.onUsage?.({
      input: res.usage.input_tokens,
      output: res.usage.output_tokens,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
    });

    return toClassification(req, (res.parsed_output ?? {}) as Parsed);
  }
}

function describeState(state: CallState): string {
  switch (state) {
    case 'greeting': return 'We asked whether the number they are calling from is the one the car is registered under.';
    case 'open_turn': return 'We asked how we can help. They may state intent, car, day, slot and a fault with the car all at once. Wanting a fault fixed or checked is intent "book" with kind "complaint".';
    case 'complaint': return 'We asked whether anything is actually wrong with the car.';
    case 'special_request': return 'We asked whether they want anything else done while it is in.';
    case 'day': return 'We asked which day they want to bring it in.';
    case 'drop_slot': return 'We offered a morning or afternoon drop-off.';
    case 'confirm': return 'We asked whether they want the workshop to try for same-day return. Asking for it back the same day, or "is that possible?", is yes.';
    case 'confirm_booking': return 'We read the booking back and asked "Shall I book it?". yes = book it; no = they want to change it (they may name a new day or time).';
    case 'wrap_up': return 'We asked "Anything else?" after finishing. no = they are done ("no, that\'s all", "thanks", "bye"); yes = they want something more.';
    case 'vehicle': return 'We read out their cars as a numbered list and asked which one. They may say the number, the model, or the last four digits.';
    default: return 'General turn.';
  }
}

/** Map the model's flat answer onto the interface the machine already uses. */
export function toClassification(req: ClassifyRequest, p: Parsed): Classification {
  const out: Classification = { callerWords: req.utterance.trim() };

  const oob = p['out_of_band'];
  if (oob === 'cost') {
    out.outOfBand = 'cost';
    return out;
  }
  if (oob === 'general') {
    out.outOfBand = 'general';
    out.generalQuestion = req.utterance.trim();
    const key = p['kb_key'];
    // 'none' stays undefined, so the machine ends the call rather than
    // answering with whatever was closest (D10).
    if (typeof key === 'string' && key !== 'none') out.kbKey = key;
    return out;
  }
  if (p['escalation'] === true) {
    out.intent = 'another_problem';
    return out;
  }

  const answer = p['answer'];
  if (answer === 'yes' || answer === 'no') out.yesNo = answer;

  if (p['intent'] === 'book') out.intent = 'book';
  else if (p['intent'] === 'other') out.intent = 'another_problem';

  const model = p['model'];
  if (typeof model === 'string' && model !== 'none') out.vehicleModel = model;
  if (p['other_car'] === true) out.otherVehicle = true;
  const choice = p['choice'];
  if (typeof choice === 'string' && /^[1-5]$/.test(choice)) out.vehicleChoice = Number(choice);
  const last4 = p['last4'];
  if (typeof last4 === 'string' && /^\d{4}$/.test(last4)) out.vehicleLast4 = last4;

  const date = p['date'];
  // Shape-checked here; whether the date is BOOKABLE is our code's call, never
  // the model's (B2).
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.day = date;

  const slot = p['slot'];
  if (slot === 'morning' || slot === 'afternoon') out.dropSlot = slot as DropSlot;

  // E7 — only meaningful when they named no day; a stated day wins.
  if (p['no_preference'] === true && !out.day) out.noPreference = true;

  const kind = p['kind'];
  const text = typeof p['text'] === 'string' ? p['text'].trim() : '';
  if (kind === 'nothing') out.nothing = true;
  else if (kind === 'complaint') out.complaint = text || req.utterance.trim();
  else if (kind === 'special_request') out.specialRequest = text || req.utterance.trim();

  return out;
}
