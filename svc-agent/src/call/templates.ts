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
 */

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

/** "8:30" / "2 o'clock" — drop times as spoken, not as clock strings. */
export function spokenDropTime(slot: DropSlot): string {
  return slot === 'morning' ? '8:30' : "2 o'clock";
}

// ---------------------------------------------------------------------------
// The pools
// ---------------------------------------------------------------------------

/**
 * E1 — centre, the bot disclosed in **one clause**, then the caller-ID
 * shortcut. Disclosed once and never apologised for (G3.1).
 */
export const GREETING = [
  "{centre}. I'm an automated assistant — I can book you in or take a message for the team. You're calling from {number}, is that the number the car's registered under?",
  "{centre}, this is the automated line — I can get you booked in or pass a message to the team. You're on {number}, is that the number the car's under?",
  "{centre}. You've got the automated assistant — I can book a service or take a message. The number you're calling from is {number}, is that the one the car's registered under?",
] as const;

/** Resuming the greeting after an aside. The bot is disclosed once, so this
 *  re-asks only the caller-ID question, not the whole opening. */
export const RESUME_CALLER_ID =
  "Anyway — is {number} the number the car's registered under?";

export const ASK_REGISTERED_NUMBER = [
  "No problem — tap in the number the car's registered under and I'll send a quick code to check it's you.",
  "That's fine. Key in the number the car's registered under, and I'll text a short code over to confirm.",
  "Right — put in the number the car's registered under and I'll send a code across to verify it.",
] as const;

export const ASK_OTP = [
  "I've sent a four digit code to that number — tap it in when it arrives.",
  "There's a four digit code on its way to that number. Key it in for me.",
  "A four digit code is going to that number now — enter it when you see it.",
] as const;

/** Rephrase **and** narrow (E0). Never "that was wrong, try again". */
export const OTP_WRONG = [
  "That code didn't match. Let's start again — tap in the registered number.",
  "That one's not right. Give me the registered number again and I'll send a fresh code.",
] as const;

/** E2 — one vehicle: state it, don't ask. */
export const VEHICLE_SINGLE = [
  'Right, so this is about the {model}.',
  'Got it — the {model}.',
  'Okay, the {model} then.',
] as const;

/** E2 — more than one: model AND last four, in one turn. Spoken, not keypad. */
export const VEHICLE_ASK = {
  ask: [
    "You've got a few on the account — which one is it? Give me the model and the last four digits of the number plate.",
    "There's more than one car here. Which are we doing — the model, and the last four of the registration?",
  ],
  reask: [
    'Sorry, just the last four digits of the number plate will do.',
    "Let's narrow it down — what are the last four digits on the plate?",
  ],
} as const;

/** E3 — the open turn. The thing that separates this from a phone tree. */
export const OPEN_TURN = ['How can I help?', 'What can I do for you?', 'How can I help you today?'] as const;

/** G3.3 — acknowledge a reported fault before asking the next question. */
export const ACK_COMPLAINT = [
  "Right, I'll put that on the job card.",
  "Got it, that'll go down for them to look at.",
  "Okay, I've noted that for the workshop.",
] as const;

/** E5 — state what's due. Never ask the caller to confirm the type (D1). */
export const SERVICE_DUE_WITH_DATE = [
  "Your {model}'s due its {ordinal} service — that's a {pool} one, it was due on {dueDay}.",
  "The {model} is due its {ordinal} service, a {pool} job — that was due {dueDay}.",
] as const;

/** D2 — if the due date is null, do not state it. */
export const SERVICE_DUE_NO_DATE = [
  "Your {model}'s due its {ordinal} service — that's a {pool} one.",
  'The {model} is due its {ordinal} service, a {pool} job.',
] as const;

/** E6 — phrased as a person asks it. "Any complaints?" is a survey question. */
export const ASK_COMPLAINT = {
  ask: [
    'Before I book it — is there anything actually wrong with the car? Any noise, a warning light, something not working properly?',
    "Before I put it in — anything actually playing up? A noise, a warning light, anything not working right?",
  ],
  reask: [
    'Just so the workshop knows — anything wrong with it at the moment?',
    'Anything the matter with it that they should look at?',
  ],
} as const;

/** D8 — only asked when there was no complaint. */
export const ASK_SPECIAL_REQUEST = [
  "Anything you'd like them to do while it's in — a wash, interior clean, that sort of thing?",
  "Anything you want them to sort while it's there — wash, interior, anything like that?",
] as const;

export const ASK_DAY = {
  ask: ['What day suits you?', 'When would you like to bring it in?', 'What day works for you?'],
  reask: ['Which day would you like — I can look from tomorrow onwards?', 'Give me a day and I\'ll check it.'],
} as const;

/**
 * E7 — the caller left the day to us. We state the first one that works and
 * go straight to the slot, so the consequences in the slot line (E8) are
 * still the thing they are choosing between.
 */
export const FIRST_AVAILABLE = [
  "Soonest I've got is {date}.",
  "First I can do is {date}.",
] as const;

/** D6 — where only one slot is free, state it rather than offering a choice. */
export const DAY_ONE_SLOT = [
  "{day}, I've only got the {slot} left.",
  "{day} — the {slot} is all that's free.",
] as const;

/** G5 — routing exits must not read as error messages. */
export const DAY_FULL_OFFER_TWO = [
  "{day}'s completely full for that kind of job, I'm afraid. I could do {alt1} or {alt2} — which suits?",
  "I've got nothing left on {day} for that. {alt1} or {alt2} — either of those any good?",
] as const;

export const DAY_FULL_OFFER_ONE = [
  "{day}'s full for that, I'm afraid. The next I've got is {alt1} — does that work?",
  "Nothing left on {day} for that one. {alt1} is the next I can do — any good?",
] as const;

/** E8 — two outcomes with consequences, not two menu items (G3.4). */
export const SLOT_BOTH = [
  '{day} I can do morning or afternoon. Morning, you drop at 8:30 and have it back the same evening. Afternoon\'s a 2 o\'clock drop and you\'d get it the next day.',
  'On {day} there\'s morning or afternoon. Drop at 8:30 and it\'s back that evening, or 2 o\'clock and you\'d collect the next day.',
] as const;

/** D7 — the complaint pool is next-day whichever slot they pick, so this
 *  offer must not promise an evening it cannot deliver. */
export const SLOT_BOTH_NEXT_DAY = [
  "{day} I can do morning or afternoon — 8:30 or 2 o'clock. It's a longer job either way, so you'd collect it the next day.",
  "Morning or afternoon on {day}, 8:30 or 2 o'clock. That kind of work takes them into the next day whichever you pick.",
] as const;

export const SLOT_BOTH_SAME_DAY = [
  '{day} I can do morning or afternoon — 8:30 or 2 o\'clock. Either way you\'d have it back the same evening.',
  'Morning or afternoon on {day}, so 8:30 or 2 o\'clock. It\'s back the same evening either way.',
] as const;

/**
 * E0 — a re-prompt narrows and rephrases; it never repeats the line just
 * given. Saying "Friday, I've only got the afternoon left" twice in a row is
 * what a phone tree does.
 */
export const SLOT_REASK_ONE = [
  'Sorry — the {slot} on {day}, shall I put you down for that?',
  "So that's {day} {slot} — yes?",
] as const;

export const SLOT_REASK_BOTH = [
  'Morning or afternoon on {day}?',
  'Which would you rather — morning or afternoon?',
] as const;

/** The caller asked for a slot we have already said is gone. Narrow, don't scold. */
export const SLOT_GONE = [
  "The {asked} is gone on {day}, I'm afraid — it's the {left} or another day. Which would you rather?",
  "I've nothing left in the {asked} on {day}. The {left} is free, or I can look at another day.",
] as const;

/** D7 — the nudge, offered once and never raised again if declined. */
export const SAME_DAY_NUDGE = [
  "That one's a next-day job the way it's booked. The workshop can sometimes turn it round the same day though — worth asking them if that matters to you?",
  "As booked you'd get it back the next day. They can occasionally do same-day — shall I have them call you about it?",
] as const;

/** E9 — one recap sentence, not a field-by-field readback. Name used once. */
export const CONFIRM_SAME_DAY = [
  "Done. {date}, drop at {time}, back the same evening — they'll confirm that once they've had a proper look at it. I'm texting you the booking reference and the workshop's direct number now.",
] as const;

export const CONFIRM_NEXT_DAY = [
  "Done. {date}, drop at {time}, and you'd collect it the day after — they'll confirm that once they've had a proper look. I'm texting you the reference and the workshop's direct number now.",
] as const;

/** D12 — mention only, never book. One sentence. */
export const SECOND_VEHICLE = [
  "Your {model}'s also due, by the way — give us a call for that one.",
  'The {model} is due as well — worth a separate call when you get a chance.',
] as const;

export const SIGN_OFF = [
  'Thanks {name}. See you {day}.',
  'Thanks for calling, {name}. See you {day}.',
  "That's all done, {name} — see you {day}.",
] as const;

// ---------------------------------------------------------------------------
// The routing exits. G5: this is where the IVR feel leaks if we let it. Same
// outcome, same lead, same SMS as "This date is unavailable. Please contact
// the service centre." — completely different call.
// ---------------------------------------------------------------------------

export const EXIT = {
  number_not_found: [
    "I can't get that code to match, sorry. I'll text the workshop's number to the phone you're on — give them a ring and they'll sort it out.",
  ],
  model_not_recognised: [
    "I'm not able to pin down which car it is from here. I'll text you the workshop's direct number — they've got the full record in front of them.",
  ],
  missing_required_field: [
    "There's something missing on your record that I can't fill in from here. I'll text you the workshop's number — one call and they'll have you booked.",
  ],
  another_problem: [
    "That's one for the team rather than me. I'm passing it over now with what you've told me, and someone will call you back. I'll text you their direct number too, in case you'd rather ring.",
  ],
  free_service_not_bookable: [
    "I can't book that one from here — it's your free service and the record needs a quick look first. I'll text you the workshop's number and they'll get you in.",
  ],
  existing_open_booking: [
    "You've already got a booking open on that one. I'll text you the workshop's direct number — they can move it or check it for you.",
  ],
  forced_full_day: [
    "I'm not able to squeeze that in from here, I'm afraid. The workshop sometimes can though — I'll text you their direct number, worth a call.",
  ],
  nothing_available_30_days: [
    "I've got nothing at all for that job in the next month, which is unusual. I'll text you the workshop's number — they'll know what's happening.",
  ],
  same_day_demanded: [
    "I can't promise same-day from here — I can't see what's actually on the ramps. I'll text you their direct number, they'll tell you straight away.",
  ],
} as const;

// ---------------------------------------------------------------------------
// Out-of-band answers (D9, D10). Answer, then return to exactly where we were.
// ---------------------------------------------------------------------------

/** D9 — answerable at any point, and **never** contains a number. */
export const COST_ANSWER = [
  'It depends on the car and what it needs — the service advisor gives you an estimate once they\'ve looked at it.',
  "That varies with the vehicle, so they'll give you a proper estimate after they've had a look at it.",
] as const;

/** D10 — the bank has no answer. We never guess. */
export const KB_MISS = [
  "That one I genuinely can't answer from here, and I'd rather not guess. I'll pass it to the team and they'll call you back — I'm texting you their direct number as well.",
] as const;
