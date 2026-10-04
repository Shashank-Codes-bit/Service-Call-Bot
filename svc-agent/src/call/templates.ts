import { parseIsoDate, WEEKDAY_NAMES as WEEKDAY, type IsoDate } from '../shared/dates.ts';
import type { DropSlot } from '../shared/types.ts';

/**
 * Response pools (G2) — 3–5 phrasings per turn, selected by our code. This is
 * how "sounds natural" reconciles with B3: variation without generation. The
 * LLM never writes a word the caller hears.
 *
 * Every pool obeys E0 and G3: one question per turn, at most two options,
 * question last; acknowledge first; ~2 sentences; a re-prompt rephrases and
 * narrows rather than repeating; never "I didn't understand"; the caller's
 * name once, near the end. And G4 — natural is not chatty. Aim at a competent
 * receptionist who knows the answer, not fake warmth.
 *
 * Short sentences (2026-10-04, after the first live calls): one idea each,
 * at most SENTENCE_WORDS words, at most TURN_SENTENCES to a template, the
 * question last. Long sentences with em-dash asides sounded read out, not
 * spoken. tests/templates.test.ts holds every pool to it.
 */

/** The most words a spoken sentence may have. */
export const SENTENCE_WORDS = 12;
/** The most sentences one template may have (a spoken list counts as one). */
export const TURN_SENTENCES = 3;

/** Deterministic pick — varied across turns, stable in tests. */
export function pick(pool: readonly string[], seed: number): string {
  if (pool.length === 0) throw new Error('empty template pool');
  return pool[Math.abs(Math.trunc(seed)) % pool.length]!;
}

export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole,
  );
}

// ---------------------------------------------------------------------------
// Speech-friendly formatting
// ---------------------------------------------------------------------------

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${(['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
}

/** "Thursday the 27th" — how a person says a date out loud. */
export function spokenDate(date: IsoDate): string {
  const d = parseIsoDate(date);
  return `${WEEKDAY[d.getDay()]} the ${ordinal(d.getDate())}`;
}

/** Just the weekday, for the second mention in the same turn. */
export function spokenDay(date: IsoDate): string {
  return WEEKDAY[parseIsoDate(date).getDay()]!;
}

/** "98100 11001" — Indian mobiles group 5 and 5. */
export function spokenNumber(mobile: string): string {
  const digits = mobile.replace(/\D/g, '');
  return digits.length === 10 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits;
}

/**
 * "1 0 0 1" — the last digits of a number or plate, one by one, as people
 * read them out. "1001" is read "one thousand and one".
 */
export function spokenDigits(digits: string): string {
  return digits.replace(/\D/g, '').split('').join(' ');
}

/** "one", "two" — how a spoken list is numbered. */
export const LIST_NUMBER = ['one', 'two', 'three', 'four', 'five'] as const;

/** "8:30" / "2 o'clock" — drop times as spoken, not as clock strings. */
export function spokenDropTime(slot: DropSlot): string {
  return slot === 'morning' ? '8:30' : "2 o'clock";
}

// ---------------------------------------------------------------------------
// The pools
// ---------------------------------------------------------------------------

/**
 * E1 — centre, the bot disclosed in **one clause**, then the caller-ID
 * check by the number's last four digits. Disclosed once and never
 * apologised for (G3.1).
 */
export const GREETING = [
  "Hi, {centre}. I'm the automated booking assistant. Is your car registered to this number, ending {last4}?",
  "Hello, {centre}. You're through to the automated booking line. Is the car on this number, ending {last4}?",
  "Hi there, {centre}. I'm the automated assistant. Is the car registered to the number ending {last4}?",
] as const;

/** Resuming the greeting after an aside. The bot is disclosed once, so this
 *  re-asks only the caller-ID question, not the whole opening. */
export const RESUME_CALLER_ID = 'So, is the car registered to the number ending {last4}?';

export const ASK_REGISTERED_NUMBER = [
  "No problem. Tap in the number the car's registered under. I'll text a quick code to check it's you.",
  "That's fine. Key in the car's registered number. I'll send a short code to confirm.",
  "Right. Put in the number the car's registered under. I'll text you a code to check.",
] as const;

export const ASK_OTP = [
  "I've sent a four digit code to that number. Tap it in when it arrives.",
  "A four digit code is on its way to that number. Key it in for me.",
  'A four digit code is going to that number now. Enter it when you see it.',
] as const;

/** Rephrase **and** narrow (E0). Never "that was wrong, try again". */
export const OTP_WRONG = [
  "That code didn't match. Let's try again. Tap in the registered number.",
  "That one's not right. Give me the registered number again. I'll send a fresh code.",
] as const;

/** Said while the record is looked up, so the pause sounds like someone working. */
export const LOOKUP_ACCOUNT = [
  'Let me pull up your details.',
  'One sec, bringing up your record.',
  'Let me just find your record.',
] as const;

/** E2 — one vehicle: state it, don't ask. */
export const VEHICLE_SINGLE = ["Right, it's the {model}.", "Okay, I've got the {model}.", 'Got it, the {model}.'] as const;

/**
 * E2 — two to five cars: read them out, numbered, and let the caller say the
 * number. Nobody remembers the last four of their plate on the spot.
 */
export const VEHICLE_LIST = {
  intro: ["You've got {count} cars with us.", 'I can see {count} cars on your account.'],
  item: '{number}, the {model} ending {last4}.',
  /** Two cars: the two answers, said. More: the number. */
  pickTwo: ['Which one, one or two?', 'Is it one or two?'],
  pickMany: ['Which number is it?', 'Just say the number. Which one is it?'],
  reask: ['Sorry, just the number. Which one was it?', 'Which number was that?'],
} as const;

/** E2 — more than five cars: too many to read out, so model and last four. */
export const VEHICLE_ASK = {
  ask: [
    "You've got a few cars with us. Which one is it, by model and last four digits?",
    "There's more than one car here. What's the model and the last four of the plate?",
  ],
  reask: [
    'Sorry, just the last four digits of the number plate will do.',
    "Let's narrow it down. What are the last four digits on the plate?",
  ],
} as const;

/** E3 — the open turn. The thing that separates this from a phone tree. */
export const OPEN_TURN = ['How can I help?', 'What can I do for you today?', 'What can I help you with?'] as const;

/** G3.3 — acknowledge a reported fault before asking the next question. */
export const ACK_COMPLAINT = [
  "Okay, I've noted that for the workshop.",
  "Got it, that'll go on the job card.",
  "Right, I'll put that on the job card.",
] as const;

/**
 * E5 — state what's due. Never ask the caller to confirm the type (D1). The
 * due date stays on the record; said aloud, it made the turn too long.
 */
export const SERVICE_DUE = [
  "Your {model}'s due its {ordinal} service. It's a {pool} one.",
  'The {model} is due its {ordinal} service, a {pool} one.',
] as const;

/** E6 — phrased as a person asks it. "Any complaints?" is a survey question. */
export const ASK_COMPLAINT = {
  ask: [
    "Anything wrong with it you'd like them to look at?",
    'Is anything playing up, like a noise or a warning light?',
  ],
  reask: ['Anything wrong with it at the moment?', 'Anything the matter with it they should check?'],
} as const;

/** D8 — only asked when there was no complaint. */
export const ASK_SPECIAL_REQUEST = [
  "Anything you'd like done while it's in? A wash, maybe?",
  "Want anything else done while it's there, like a wash?",
] as const;

export const ASK_DAY = {
  ask: ['What day suits you?', 'When would you like to bring it in?', 'Which day works for you?'],
  reask: ['I can look from tomorrow. Which day would you like?', "Just give me a day and I'll check it."],
} as const;

/** Said while a day's places are checked. Never with another lead-in. */
export const LOOKUP_DAY = ['Let me check that day for you.', 'One sec, let me check.', 'Let me have a look.'] as const;

/**
 * E7 — the caller left the day to us. We state the first one that works and
 * go straight to the slot, so the consequences in the slot line (E8) are
 * still the thing they are choosing between.
 */
export const FIRST_AVAILABLE = ["Let me see what's free. The soonest is {date}.", 'Let me look. First I can do is {date}.'] as const;

/** D6 — where only one slot is free, state it, then ask. A bare "yes" takes it. */
export const DAY_ONE_SLOT = [
  "{day}, I've only got the {slot} left. Does that work?",
  '{day}, just the {slot} is free. Would that suit you?',
] as const;

/** G5 — routing exits must not read as error messages. */
export const DAY_FULL_OFFER_TWO = [
  "{day}'s full for that job, I'm afraid. I could do {alt1} or {alt2}. Which suits?",
  "Nothing left on {day} for that. How about {alt1} or {alt2}?",
] as const;

export const DAY_FULL_OFFER_ONE = [
  "{day}'s full for that, I'm afraid. The next I've got is {alt1}. Does that work?",
  'Nothing left on {day} for that one. {alt1} is the next I can do. Any good?',
] as const;

/** E8 — two outcomes with consequences, not two menu items (G3.4). */
export const SLOT_BOTH = [
  "{day} I can take it at 8:30, back that evening. Or at 2, back the next day. Which suits you?",
  "On {day}, drop at 8:30 and it's back that evening. Or drop at 2 and collect it next day. Which would you like?",
] as const;

/** D7 — the complaint pool is next-day whichever slot they pick, so this
 *  offer must not promise an evening it cannot deliver. */
export const SLOT_BOTH_NEXT_DAY = [
  "{day} I can do 8:30 or 2 o'clock. It's a longer job, so it's back the next day. Which suits you?",
  "On {day} there's 8:30 or 2 o'clock. Either way you'd collect it next day. Which would you like?",
] as const;

export const SLOT_BOTH_SAME_DAY = [
  "{day} I can do 8:30 or 2 o'clock. Either way it's back that evening. Which suits you?",
  "On {day} there's 8:30 or 2 o'clock. It's back the same evening either way. Which would you like?",
] as const;

/**
 * E0 — a re-prompt narrows and rephrases; it never repeats the line just
 * given. Saying "Friday, I've only got the afternoon left" twice in a row is
 * what a phone tree does.
 */
export const SLOT_REASK_ONE = ['Sorry, shall I put you down for the {slot}?', "So, the {slot} on {day}. Yes?"] as const;

export const SLOT_REASK_BOTH = ['Morning or afternoon on {day}?', 'Which would you rather, morning or afternoon?'] as const;

/** The caller asked for a slot we have already said is gone. Narrow, don't scold. */
export const SLOT_GONE = [
  "The {asked} is gone on {day}, I'm afraid. The {left} is free. Would that work?",
  "Nothing left in the {asked} on {day}. I've got the {left}, or another day. Which would you like?",
] as const;

/** D7 — the nudge, offered once and never raised again if declined. */
export const SAME_DAY_NUDGE = [
  'As booked, it comes back the next day. The workshop can sometimes do same-day. Shall I have them call you about it?',
  "That one's a next-day job as booked. They can occasionally turn it round same-day. Want them to call you about it?",
] as const;

/**
 * Read the booking back and wait for a yes before writing anything. The
 * caller hears exactly what will be booked, and can still change it.
 */
export const READBACK = [
  "So that's {date}, drop at {time}. It's back {back}. Shall I book it?",
  'Let me read that back. {date}, drop at {time}, back {back}. Shall I book it?',
] as const;

export const READBACK_REASK = ['Sorry, shall I go ahead and book it?', 'Shall I book that in for you?'] as const;

/** They said no to the readback without saying what to change. */
export const READBACK_CHANGE = [
  'No problem. What would you like instead, another day or another time?',
  'Sure. Would you like a different day, or a different time?',
] as const;

/** E9 — booked: short, and the reference is by text. */
export const BOOKED = [
  "Booking that in now. Done, I've texted you the reference.",
  "Done, you're booked in. The reference is on its way by text.",
  "All booked. I'm texting you the reference now.",
] as const;

/** D12 — mention only, never book. One sentence. */
export const SECOND_VEHICLE = ["Your {model}'s due too, worth a separate call.", 'The {model} is due as well, by the way.'] as const;

/**
 * The caller decides when the call is over. Asked after a booking and after
 * a hand-off, so nobody is hung up on mid-thought.
 */
export const ANYTHING_ELSE = ['Anything else I can help with?', 'Is there anything else?', 'Anything else for you today?'] as const;
export const ANYTHING_ELSE_AFTER_EXIT = ['Anything else before I let you go?', 'Is there anything else I can do?'] as const;
/** After an answer in the closing: shorter, as the question has been asked once. */
export const ANYTHING_ELSE_AGAIN = ['Anything else?', 'Anything more I can help with?'] as const;
/** "Yes" with nothing after it. */
export const GO_AHEAD = ['Sure, go ahead.', "Of course. What is it?"] as const;
/** Something the agent can't do from here — another car, a change to a booking. */
export const WRAP_FOR_THE_TEAM = [
  "The team can sort that for you. Their number's in my text. Anything else?",
  "That's one for the workshop. You'll have their number by text. Anything else?",
] as const;

/** G3.8 — the caller's name, once, at the very end. */
export const SIGN_OFF = {
  booked: ['Thanks {name}, see you {day}.', 'Thanks for calling, {name}. See you {day}.', 'Great, see you {day}, {name}.'],
  other: ['Thanks for calling, {name}. Take care.', 'Thanks {name}. Have a good day.'],
  anonymous: ['Thanks for calling. Take care.', 'Thanks for calling. Have a good day.'],
} as const;

// ---------------------------------------------------------------------------
// The routing exits. G5: this is where the IVR feel leaks if we let it. Same
// outcome, same lead, same SMS as "This date is unavailable. Please contact
// the service centre." — completely different call.
// ---------------------------------------------------------------------------

export const EXIT = {
  number_not_found: ["I couldn't confirm that number, sorry. I'll text you the workshop's number to sort it."],
  model_not_recognised: ["I can't tell which car it is from here. I'll text you the workshop's number."],
  missing_required_field: ["Something's missing on your record. I'll text you the workshop's number to fix it."],
  another_problem: [
    "That's one for the team. I'll pass it on and they'll call you back. Their number's coming by text.",
  ],
  free_service_not_bookable: [
    "I can't book that free service from here. I'll text you the workshop's number to sort it.",
  ],
  existing_open_booking: [
    "You've already got a booking open for that car. I'll text you the workshop's number to change it.",
  ],
  forced_full_day: ["I can't fit that in from here, I'm afraid. The workshop might, so I'll text you their number."],
  nothing_available_30_days: ["I've nothing free for that job this month. I'll text you the workshop's number."],
  same_day_demanded: ["I can't promise same-day from here. I'll text you their number, they'll tell you straight away."],
} as const;

// ---------------------------------------------------------------------------
// Out-of-band answers (D9, D10). Answer, then return to exactly where we were.
// ---------------------------------------------------------------------------

/** D9 — answerable at any point, and **never** contains a number. */
export const COST_ANSWER = [
  'It depends on the car and what it needs. The advisor gives you an estimate once they look.',
  "That varies with the car. They'll give you a proper estimate after a look.",
] as const;

/**
 * D10 — the bank has no answer. We never guess, and we don't drop the caller
 * either: the question goes to the team, and the booking carries on.
 */
export const KB_PASSED = [
  "I don't have that to hand. I've passed it to the team, and they'll get back to you.",
  "That one I'd rather not guess. I've passed it on, and they'll call you back.",
] as const;
