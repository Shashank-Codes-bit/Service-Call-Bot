import { parseIsoDate, WEEKDAY_NAMES as WEEKDAY, type IsoDate } from '../shared/dates.ts';
import type { DropSlot } from '../shared/types.ts';
import type { FaultArea, Language } from './types.ts';

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
 *
 * Two languages, one shape: `EN`, and `HI` — Hinglish in Latin script, the
 * way Indian callers type and speak it. `HI` is typed as `Pools`, so a line
 * missing from it is a compile error. The call replies in whichever the
 * caller is speaking (machine.ts `poolsFor`). Hindi lines use "hum" (we) and
 * neutral forms, so they suit any voice.
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
// Speech-friendly formatting (language-independent)
// ---------------------------------------------------------------------------

function ordinalSuffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${(['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
}

/** "Thursday the 27th" — how a person says a date out loud. */
export function spokenDate(date: IsoDate): string {
  const d = parseIsoDate(date);
  return `${WEEKDAY[d.getDay()]} the ${ordinalSuffix(d.getDate())}`;
}

/** Just the weekday, for the second mention in the same turn. Indians say these in English in Hinglish too. */
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

/** "8:30" / "2 o'clock" — drop times as spoken, not as clock strings. */
export function spokenDropTime(slot: DropSlot): string {
  return slot === 'morning' ? '8:30' : "2 o'clock";
}

const EN_ORDINALS = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];
const HI_ORDINALS = ['', 'pehli', 'doosri', 'teesri', 'chauthi', 'paanchvi', 'chhathi', 'saatvi', 'aathvi', 'nauvi'];

// ---------------------------------------------------------------------------
// English
// ---------------------------------------------------------------------------

const EN = {
  // --- Words the machine fills into lines ---------------------------------
  /** "Friday the 18th". */
  date: spokenDate,
  /** "8:30", "2 o'clock". */
  time: spokenDropTime,
  /** "fourth" — the service number. */
  ordinal: (n: number) => EN_ORDINALS[n] ?? ordinalSuffix(n),
  /** The slot by name, for "I've only got the {slot} left". */
  slot: { morning: 'morning', afternoon: 'afternoon' } as Record<DropSlot, string>,
  /** When it comes back, for the readback and "when do I get it?". */
  back: { same: 'the same evening', next: 'the next day' },
  /** How a spoken list is numbered. */
  listNumber: ['One', 'Two', 'Three', 'Four', 'Five'],
  /** "Got it, {fault}." — the fault area said back, in our words (B3). */
  fault: {
    gears: 'a problem with the gears',
    clutch: 'a problem with the clutch',
    brakes: 'a problem with the brakes',
    engine: 'an engine problem',
    ac: 'the AC not working right',
    battery: 'a battery or starting problem',
    steering: 'a steering problem',
    suspension: 'a suspension problem',
    noise: 'a noise from the car',
    warning_light: 'a warning light on',
    electrics: 'an electrical problem',
    tyres: 'a tyre problem',
    body: 'some body damage',
    other: 'that problem',
  } as Record<FaultArea, string>,
  /** "…but {problem} needs a proper check." */
  problem: {
    gears: 'the gear problem',
    clutch: 'the clutch problem',
    brakes: 'the brake problem',
    engine: 'the engine problem',
    ac: 'the AC problem',
    battery: 'the battery problem',
    steering: 'the steering problem',
    suspension: 'the suspension problem',
    noise: 'the noise',
    warning_light: 'the warning light',
    electrics: 'the electrical problem',
    tyres: 'the tyre problem',
    body: 'the body damage',
    other: 'the fault',
  } as Record<FaultArea, string>,

  // --- The pools -----------------------------------------------------------

  /**
   * E1 — centre, the bot disclosed in **one clause**, then the caller-ID
   * check by the number's last four digits. Disclosed once and never
   * apologised for (G3.1). Always English: we don't know the caller yet.
   */
  GREETING: [
    "Hi, {centre}. I'm the automated booking assistant. Is your car registered to this number, ending {last4}?",
    "Hello, {centre}. You're through to the automated booking line. Is the car on this number, ending {last4}?",
    "Hi there, {centre}. I'm the automated assistant. Is the car registered to the number ending {last4}?",
  ],

  /** Resuming the greeting after an aside. The bot is disclosed once, so this
   *  re-asks only the caller-ID question, not the whole opening. */
  RESUME_CALLER_ID: ['So, is the car registered to the number ending {last4}?'],

  ASK_REGISTERED_NUMBER: [
    "No problem. Tap in the number the car's registered under. I'll text a quick code to check it's you.",
    "That's fine. Key in the car's registered number. I'll send a short code to confirm.",
    "Right. Put in the number the car's registered under. I'll text you a code to check.",
  ],

  ASK_OTP: [
    "I've sent a four digit code to that number. Tap it in when it arrives.",
    'A four digit code is on its way to that number. Key it in for me.',
    'A four digit code is going to that number now. Enter it when you see it.',
  ],

  /** Rephrase **and** narrow (E0). Never "that was wrong, try again". */
  OTP_WRONG: [
    "That code didn't match. Let's try again. Tap in the registered number.",
    "That one's not right. Give me the registered number again. I'll send a fresh code.",
  ],

  /** Said while the record is looked up, so the pause sounds like someone working. */
  LOOKUP_ACCOUNT: ['Let me pull up your details.', 'One sec, bringing up your record.', 'Let me just find your record.'],

  /** E2 — one vehicle: state it, don't ask. */
  VEHICLE_SINGLE: ["Right, it's the {model}.", "Okay, I've got the {model}.", 'Got it, the {model}.'],

  /**
   * E2 — two to five cars: read them out, numbered, and let the caller say the
   * number. Nobody remembers the last four of their plate on the spot.
   */
  VEHICLE_LIST: {
    intro: ["You've got {count} cars with us.", 'I can see {count} cars on your account.'],
    item: '{number}, the {model} ending {last4}.',
    /** Two cars: the two answers, said. More: the number. */
    pickTwo: ['Which one, one or two?', 'Is it one or two?'],
    pickMany: ['Which number is it?', 'Just say the number. Which one is it?'],
    reask: ['Sorry, just the number. Which one was it?', 'Which number was that?'],
  },

  /** E2 — more than five cars: too many to read out, so model and last four. */
  VEHICLE_ASK: {
    ask: [
      "You've got a few cars with us. Which one is it, by model and last four digits?",
      "There's more than one car here. What's the model and the last four of the plate?",
    ],
    reask: [
      'Sorry, just the last four digits of the number plate will do.',
      "Let's narrow it down. What are the last four digits on the plate?",
    ],
  },

  /** E3 — the open turn. The thing that separates this from a phone tree. */
  OPEN_TURN: ['How can I help?', 'What can I do for you today?', 'What can I help you with?'],

  /** G3.3 — acknowledge a reported fault before asking the next question. */
  ACK_COMPLAINT: ["Okay, I've noted that for the workshop.", "Got it, that'll go on the job card.", "Right, I'll put that on the job card."],

  /** The fault said back by area, so the caller knows it was understood. */
  ACK_FAULT: ['Got it, {fault}, noted for the workshop.', "Okay, {fault}, that's on the job card."],

  /** A fault makes it a repair check: next-day, said before they pick a slot. */
  FAULT_NEXT_DAY: ["It needs a proper check, so it'll be ready the next day.", "That needs a proper look, so it's back the next day."],

  /**
   * E5 — state what's due. Never ask the caller to confirm the type (D1). The
   * due date stays on the record; said aloud, it made the turn too long.
   */
  SERVICE_DUE: ["Your {model}'s due its {ordinal} service. It's a {pool} one.", 'The {model} is due its {ordinal} service, a {pool} one.'],

  /** E6 — phrased as a person asks it. "Any complaints?" is a survey question. */
  ASK_COMPLAINT: {
    ask: ["Anything wrong with it you'd like them to look at?", 'Is anything playing up, like a noise or a warning light?'],
    reask: ['Anything wrong with it at the moment?', 'Anything the matter with it they should check?'],
  },

  /** D8 — only asked when there was no complaint. */
  ASK_SPECIAL_REQUEST: ["Anything you'd like done while it's in? A wash, maybe?", "Want anything else done while it's there, like a wash?"],

  ASK_DAY: {
    ask: ['What day suits you?', 'When would you like to bring it in?', 'Which day works for you?'],
    reask: ['I can look from tomorrow. Which day would you like?', "Just give me a day and I'll check it."],
  },

  /** Said while a day's places are checked. Never with another lead-in. */
  LOOKUP_DAY: ['Let me check that day for you.', 'One sec, let me check.', 'Let me have a look.'],

  /**
   * E7 — the caller left the day to us. We state the first one that works and
   * go straight to the slot, so the consequences in the slot line (E8) are
   * still the thing they are choosing between.
   */
  FIRST_AVAILABLE: ["Let me see what's free. The soonest is {date}.", 'Let me look. First I can do is {date}.'],

  /** D6 — where only one slot is free, state it, then ask. A bare "yes" takes it. */
  DAY_ONE_SLOT: ["{day}, I've only got the {slot} left. Does that work?", '{day}, just the {slot} is free. Would that suit you?'],

  /** G5 — routing exits must not read as error messages. */
  DAY_FULL_OFFER_TWO: [
    "{day}'s full for that job, I'm afraid. I could do {alt1} or {alt2}. Which suits?",
    'Nothing left on {day} for that. How about {alt1} or {alt2}?',
  ],

  DAY_FULL_OFFER_ONE: [
    "{day}'s full for that, I'm afraid. The next I've got is {alt1}. Does that work?",
    'Nothing left on {day} for that one. {alt1} is the next I can do. Any good?',
  ],

  /** E8 — two outcomes with consequences, not two menu items (G3.4). */
  SLOT_BOTH: [
    '{day} I can take it at 8:30, back that evening. Or at 2, back the next day. Which suits you?',
    "On {day}, drop at 8:30 and it's back that evening. Or drop at 2 and collect it next day. Which would you like?",
  ],

  /** D7 — the complaint pool is next-day whichever slot they pick, so this
   *  offer must not promise an evening it cannot deliver. */
  SLOT_BOTH_NEXT_DAY: [
    "{day} I can do 8:30 or 2 o'clock. It's a longer job, so it's back the next day. Which suits you?",
    "On {day} there's 8:30 or 2 o'clock. Either way you'd collect it next day. Which would you like?",
  ],

  SLOT_BOTH_SAME_DAY: [
    "{day} I can do 8:30 or 2 o'clock. Either way it's back that evening. Which suits you?",
    "On {day} there's 8:30 or 2 o'clock. It's back the same evening either way. Which would you like?",
  ],

  /**
   * E0 — a re-prompt narrows and rephrases; it never repeats the line just
   * given. Saying "Friday, I've only got the afternoon left" twice in a row is
   * what a phone tree does.
   */
  SLOT_REASK_ONE: ['Sorry, shall I put you down for the {slot}?', 'So, the {slot} on {day}. Yes?'],

  SLOT_REASK_BOTH: ['Morning or afternoon on {day}?', 'Which would you rather, morning or afternoon?'],

  /** The caller asked for a slot we have already said is gone. Narrow, don't scold. */
  SLOT_GONE: [
    "The {asked} is gone on {day}, I'm afraid. The {left} is free. Would that work?",
    "Nothing left in the {asked} on {day}. I've got the {left}, or another day. Which would you like?",
  ],

  /** D7 — the nudge, offered once and never raised again if declined. */
  SAME_DAY_NUDGE: [
    'As booked, it comes back the next day. The workshop can sometimes do same-day. Shall I have them call you about it?',
    "That one's a next-day job as booked. They can occasionally turn it round same-day. Want them to call you about it?",
  ],

  /**
   * Read the booking back and wait for a yes before writing anything. The
   * caller hears exactly what will be booked, and can still change it.
   */
  READBACK: [
    "So that's {date}, drop at {time}. It's back {back}. Shall I book it?",
    'Let me read that back. {date}, drop at {time}, back {back}. Shall I book it?',
  ],

  /** They want same-day: noted for the service manager, and the visit still booked. */
  SAME_DAY_NOTED: ["Sure, I'll ask them to call you about same-day.", "Okay, they'll call you about getting it back the same day."],

  /** The nudge, re-asked once when the answer wasn't a clear yes or no. */
  NUDGE_REASK: ['Would you like them to try for same-day? Yes or no?', 'Shall I ask them about same-day for you?'],

  READBACK_REASK: ['Sorry, shall I go ahead and book it?', 'Shall I book that in for you?'],

  /** They said no to the readback without saying what to change. */
  READBACK_CHANGE: [
    'No problem. What would you like instead, another day or another time?',
    'Sure. Would you like a different day, or a different time?',
  ],

  /** E9 — booked: short, and the reference is by text. */
  BOOKED: [
    "Booking that in now. Done, I've texted you the reference.",
    "Done, you're booked in. The reference is on its way by text.",
    "All booked. I'm texting you the reference now.",
  ],

  /** D12 — mention only, never book. One sentence. */
  SECOND_VEHICLE: ["Your {model}'s due too, worth a separate call.", 'The {model} is due as well, by the way.'],

  /**
   * The caller decides when the call is over. Asked after a booking and after
   * a hand-off, so nobody is hung up on mid-thought.
   */
  ANYTHING_ELSE: ['Anything else I can help with?', 'Is there anything else?', 'Anything else for you today?'],
  ANYTHING_ELSE_AFTER_EXIT: ['Anything else before I let you go?', 'Is there anything else I can do?'],
  /** After an answer in the closing: shorter, as the question has been asked once. */
  ANYTHING_ELSE_AGAIN: ['Anything else?', 'Anything more I can help with?'],
  /** The caller said the booking again in the closing: it's done, say so. */
  ALL_SET: ["You're all set for {day} at {time}.", "That's booked for {day}, {time} drop-off."],
  /** Something to add to the booking, said in the closing: it goes on the job card. */
  ADDED_TO_BOOKING: ["I've added that to your booking for the team.", "I've noted that on the job card."],
  /** The closing answer wasn't clear: ask once more before saying goodbye. */
  WRAP_REASK: ['Sorry, is there anything else?', 'Sorry, anything else I can do for you?'],
  /** "Yes" with nothing after it. */
  GO_AHEAD: ['Sure, go ahead.', 'Of course. What is it?'],
  /** Something the agent can't do from here — another car, a change to a booking. */
  WRAP_FOR_THE_TEAM: [
    "The team can sort that for you. Their number's in my text. Anything else?",
    "That's one for the workshop. You'll have their number by text. Anything else?",
  ],

  /** G3.8 — the caller's name, once, at the very end. */
  SIGN_OFF: {
    booked: ['Thanks {name}, see you {day}.', 'Thanks for calling, {name}. See you {day}.', 'Great, see you {day}, {name}.'],
    other: ['Thanks for calling, {name}. Take care.', 'Thanks {name}. Have a good day.'],
    anonymous: ['Thanks for calling. Take care.', 'Thanks for calling. Have a good day.'],
  },

  // -------------------------------------------------------------------------
  // The routing exits. G5: this is where the IVR feel leaks if we let it. Same
  // outcome, same lead, same SMS as "This date is unavailable. Please contact
  // the service centre." — completely different call.
  // -------------------------------------------------------------------------
  EXIT: {
    number_not_found: ["I couldn't confirm that number, sorry. I'll text you the workshop's number to sort it."],
    model_not_recognised: ["I can't tell which car it is from here. I'll text you the workshop's number."],
    missing_required_field: ["Something's missing on your record. I'll text you the workshop's number to fix it."],
    another_problem: ["That's one for the team. I'll pass it on and they'll call you back. Their number's coming by text."],
    free_service_not_bookable: ["I can't book that free service from here. I'll text you the workshop's number to sort it."],
    existing_open_booking: ["You've already got a booking open for that car. I'll text you the workshop's number to change it."],
    forced_full_day: ["I can't fit that in from here, I'm afraid. The workshop might, so I'll text you their number."],
    nothing_available_30_days: ["I've nothing free for that job this month. I'll text you the workshop's number."],
    same_day_demanded: ["I can't promise same-day from here. I'll text you their number, they'll tell you straight away."],
  },

  // -------------------------------------------------------------------------
  // Out-of-band answers (D9, D10). Answer, then return to exactly where we were.
  // -------------------------------------------------------------------------

  /** D9 — answerable at any point, and **never** contains a number. */
  COST_ANSWER: [
    'It depends on the car and what it needs. The advisor gives you an estimate once they look.',
    "That varies with the car. They'll give you a proper estimate after a look.",
  ],

  /**
   * D10 — the bank has no answer. We never guess, and we don't drop the caller
   * either: the question goes to the team, and the booking carries on.
   */
  KB_PASSED: [
    "I don't have that to hand. I've passed it to the team, and they'll get back to you.",
    "That one I'd rather not guess. I've passed it on, and they'll call you back.",
  ],

  /** "Can someone call me back?" — a plain yes, a follow-up filed, the number texted. */
  CALLBACK_YES: [
    "Yes, I'll ask the service centre to call you back. Just in case, I'm texting you their number too.",
    "Sure, I'll have them call you. I'm texting you their number as well.",
  ],

  /**
   * "Why…?" / "What happens…?" about the booking itself, answered from the
   * call's own state (machine.ts `explain`). The `_general` lines are for
   * when the question doesn't apply yet, e.g. "why next day?" before a day.
   */
  EXPLAIN: {
    next_day_fault: [
      "It's a {pool} service, but {problem} needs a proper check. That takes until the next day.",
      'The service is {pool}, but {problem} needs checking. So it stays overnight.',
    ],
    next_day_major: ["A major service takes most of a day. A 2 o'clock drop runs into the next morning."],
    not_next_day: ["Actually, it's back the same evening."],
    next_day_general: ['Repairs and afternoon major services run overnight. Most other services are back that evening.'],
    same_day_minor: ["Drop it at 8:30 or 2, and it's back that evening."],
    same_day_major: ["Drop it at 8:30, and it's back that evening."],
    same_day_fault: ['With a repair, it stays overnight. The workshop can sometimes do same-day.'],
    same_day_general: ["For most services, drop it at 8:30 and it's back that evening."],
    not_today: ['I book from tomorrow, so the workshop can plan the day.'],
    day_full: ['All the places for that job on {day} are taken.'],
    day_full_general: ['Each day has a set number of places for each job.'],
    one_slot: ['The {other} is already full on {day}.'],
    one_slot_general: ['Some slots fill up sooner than others.'],
    ready_when: ["Drop it at {time} on {day}. It's back {back}."],
    ready_when_general: ['Most services are back that evening. Repairs take until the next day.'],
    drop_off: ['Just drop it at reception at {time}. The advisor checks it and gives you an estimate.'],
    drop_off_general: ['Just drop it at reception. The advisor checks it and gives you an estimate.'],
    confirmation: ["Yes, you'll get a text with the reference and the workshop's number."],
    change_later: ['Yes, just call the workshop on the number in the text.'],
    why_number: ["It makes sure only the car's owner can book it."],
    why_fault: ['So the workshop knows what to check, and plans enough time.'],
  },
};

/** The shape both languages share. Missing a line in `HI` is a compile error. */
export type Pools = typeof EN;

// ---------------------------------------------------------------------------
// Hinglish — the same lines, as an Indian receptionist would say them.
// Latin script. "Hum" (we) and neutral verb forms, so any voice can say them.
// ---------------------------------------------------------------------------

const HI: Pools = {
  /** "Friday, 18 tareekh". */
  date: (date: IsoDate) => `${spokenDay(date)}, ${parseIsoDate(date).getDate()} tareekh`,
  time: (slot: DropSlot) => (slot === 'morning' ? 'subah 8:30' : 'dopahar 2 baje'),
  ordinal: (n: number) => HI_ORDINALS[n] || `${n}vi`,
  slot: { morning: 'subah', afternoon: 'dopahar' },
  back: { same: 'shaam tak', next: 'agle din' },
  listNumber: ['Ek', 'Do', 'Teen', 'Chaar', 'Paanch'],
  fault: {
    gears: 'gear mein problem',
    clutch: 'clutch mein problem',
    brakes: 'brake mein problem',
    engine: 'engine mein problem',
    ac: 'AC mein problem',
    battery: 'battery mein problem',
    steering: 'steering mein problem',
    suspension: 'suspension mein problem',
    noise: 'awaaz aa rahi',
    warning_light: 'warning light jal rahi',
    electrics: 'electrical problem',
    tyres: 'tyre mein problem',
    body: 'body pe damage',
    other: 'problem',
  },
  problem: {
    gears: 'gear ki problem',
    clutch: 'clutch ki problem',
    brakes: 'brake ki problem',
    engine: 'engine ki problem',
    ac: 'AC ki problem',
    battery: 'battery ki problem',
    steering: 'steering ki problem',
    suspension: 'suspension ki problem',
    noise: 'awaaz',
    warning_light: 'warning light',
    electrics: 'electrical problem',
    tyres: 'tyre ki problem',
    body: 'body damage',
    other: 'problem',
  },

  GREETING: EN.GREETING,
  RESUME_CALLER_ID: ['Toh, kya gaadi {last4} wale number pe registered hai?'],

  ASK_REGISTERED_NUMBER: [
    'Koi baat nahi. Gaadi ka registered number daal dijiye. Hum ek code bhejenge.',
    'Theek hai. Registered number type kijiye. Confirm karne ke liye code aayega.',
    'Achha. Gaadi wala number daaliye. SMS pe ek code aayega.',
  ],
  ASK_OTP: [
    'Us number pe chaar digit ka code bheja hai. Aate hi daal dijiye.',
    'Chaar digit ka code aa raha hai. Woh type kar dijiye.',
    'Code abhi bheja hai. Milte hi daal dijiye.',
  ],
  OTP_WRONG: [
    'Yeh code match nahi hua. Ek baar phir registered number daaliye.',
    'Code sahi nahi tha. Number dobara daaliye, naya code bhejte hain.',
  ],

  LOOKUP_ACCOUNT: ['Ek second, aapki details dekh rahe hain.', 'Ek minute, aapka record dekhte hain.', 'Bas ek second, details nikaal rahe hain.'],
  VEHICLE_SINGLE: ['Theek hai, {model} hai.', 'Achha, {model} ki baat hai.', 'Samajh gaye, {model}.'],
  VEHICLE_LIST: {
    intro: ['Aapki {count} gaadiyan hain hamare paas.', 'Account pe {count} gaadiyan dikh rahi hain.'],
    item: '{number}, {model} jiska number {last4} pe khatam hota hai.',
    pickTwo: ['Kaunsi wali, ek ya do?', 'Ek ya do, kaunsi gaadi?'],
    pickMany: ['Kaunsa number?', 'Bas number bata dijiye. Kaunsi gaadi?'],
    reask: ['Sorry, bas number bata dijiye. Kaunsi thi?', 'Kaunsa number tha?'],
  },
  VEHICLE_ASK: {
    ask: [
      'Aapki kai gaadiyan hain. Kaunsi hai, model aur last chaar digit?',
      'Ek se zyada gaadi hai. Model aur plate ke last chaar digit kya hain?',
    ],
    reask: ['Sorry, bas plate ke last chaar digit bata dijiye.', 'Plate ke aakhri chaar digit kya hain?'],
  },

  OPEN_TURN: ['Bataiye, kya madad karein?', 'Aaj kya kaam hai?', 'Kaise help kar sakte hain?'],
  ACK_COMPLAINT: ['Theek hai, workshop ke liye note kar liya.', 'Samajh gaye, job card pe likh diya.', 'Achha, job card pe daal diya hai.'],
  ACK_FAULT: ['Samajh gaye, {fault} hai, note kar liya.', 'Theek hai, {fault} hai, job card pe likh diya.'],
  FAULT_NEXT_DAY: ['Isko theek se check karna hoga, toh gaadi agle din milegi.', 'Iski proper jaanch hogi, isliye agle din wapas milegi.'],
  SERVICE_DUE: ['Aapki {model} ki {ordinal} service due hai. {pool} wali hai.', '{model} ki {ordinal} service due hai, {pool} service.'],
  ASK_COMPLAINT: {
    ask: ['Gaadi mein koi problem hai jo check karwani ho?', 'Koi dikkat hai, jaise awaaz ya warning light?'],
    reask: ['Abhi gaadi mein koi problem hai?', 'Kuch kharab hai jo check karna ho?'],
  },
  ASK_SPECIAL_REQUEST: ['Saath mein kuch aur karwana hai? Jaise washing?', 'Wash ya interior cleaning bhi karwani hai?'],
  ASK_DAY: {
    ask: ['Kaunsa din theek rahega?', 'Kis din laana chahenge?', 'Kab laa sakte hain?'],
    reask: ['Booking kal se ho sakti hai. Kaunsa din chahiye?', 'Bas ek din bata dijiye, hum check karte hain.'],
  },
  LOOKUP_DAY: ['Ek second, woh din check karte hain.', 'Ek minute, dekhte hain.', 'Zara check karte hain.'],
  FIRST_AVAILABLE: ['Dekhte hain kya free hai. Sabse pehle {date} hai.', 'Check kiya. Sabse jaldi {date} ho sakta hai.'],
  DAY_ONE_SLOT: ['{day} ko sirf {slot} khali hai. Chalega?', '{day} ko bas {slot} ka slot hai. Theek rahega?'],
  DAY_FULL_OFFER_TWO: ['{day} us kaam ke liye full hai. {alt1} ya {alt2} ho sakta hai. Kaunsa?', '{day} ko jagah nahi hai. {alt1} ya {alt2} chalega?'],
  DAY_FULL_OFFER_ONE: ['{day} full hai, sorry. Agla {alt1} hai. Chalega?', '{day} ko jagah nahi. {alt1} ho sakta hai, theek hai?'],
  SLOT_BOTH: [
    '{day} ko subah 8:30 laaiye, shaam tak wapas. Ya 2 baje, agle din wapas. Kaunsa theek rahega?',
    '{day} subah 8:30 chhodiye toh shaam ko milegi. 2 baje chhodiye toh agle din. Kaunsa chahiye?',
  ],
  SLOT_BOTH_NEXT_DAY: [
    '{day} ko 8:30 ya 2 baje aa sakte hain. Lamba kaam hai, agle din milegi. Kaunsa theek rahega?',
    '{day} ko 8:30 ya 2 baje ka slot hai. Dono mein agle din wapas. Kaunsa chahiye?',
  ],
  SLOT_BOTH_SAME_DAY: [
    '{day} ko 8:30 ya 2 baje aa sakte hain. Dono mein shaam tak wapas. Kaunsa theek rahega?',
    '{day} ko 8:30 ya 2 baje ka slot hai. Shaam tak mil jayegi. Kaunsa chahiye?',
  ],
  SLOT_REASK_ONE: ['Sorry, {slot} ka slot book karein?', 'Toh {day} {slot}. Theek hai?'],
  SLOT_REASK_BOTH: ['{day} ko subah ya dopahar?', 'Subah chahiye ya dopahar?'],
  SLOT_GONE: [
    '{day} ko {asked} full ho gaya. {left} khali hai. Chalega?',
    '{day} {asked} mein jagah nahi. {left} hai, ya koi aur din. Kya karein?',
  ],
  SAME_DAY_NUDGE: [
    'Is booking mein gaadi agle din milegi. Kabhi kabhi same-day ho jata hai. Workshop se call karwa dein?',
    'Yeh agle din wala kaam hai. Same-day kabhi kabhi ho sakta hai. Unse baat karwa dein?',
  ],
  READBACK: [
    'Toh {date}, {time} drop. Gaadi {back} milegi. Book kar dein?',
    'Ek baar confirm kar lete hain. {date}, {time}, {back} wapas. Book kar dein?',
  ],
  SAME_DAY_NOTED: ['Theek hai, same-day ke liye woh aapko call karenge.', 'Achha, workshop aapko same-day ke baare mein call karega.'],
  NUDGE_REASK: ['Same-day try karwayein? Haan ya nahi?', 'Workshop se same-day ke liye poochein?'],
  READBACK_REASK: ['Sorry, book kar dein?', 'Toh booking kar dein?'],
  READBACK_CHANGE: ['Koi baat nahi. Doosra din chahiye ya doosra time?', 'Theek hai. Din badalna hai ya time?'],
  BOOKED: [
    'Booking ho gayi. Reference SMS pe bhej diya hai.',
    'Ho gaya, booking pakki. Reference SMS pe aa jayega.',
    'Book kar diya. Reference abhi SMS pe bhej rahe hain.',
  ],
  SECOND_VEHICLE: ['Aapki {model} ki service bhi due hai, uske liye alag call kijiye.', '{model} bhi due hai, waise.'],
  ANYTHING_ELSE: ['Aur kuch madad karein?', 'Aur kuch?', 'Aur koi kaam hai?'],
  ANYTHING_ELSE_AFTER_EXIT: ['Aur kuch hai jo hum kar sakein?', 'Aur koi madad chahiye?'],
  ANYTHING_ELSE_AGAIN: ['Aur kuch?', 'Kuch aur?'],
  ALL_SET: ['Aapki booking {day} ko {time} ke liye pakki hai.', '{day}, {time} ki booking ho chuki hai.'],
  ADDED_TO_BOOKING: ['Yeh booking mein team ke liye add kar diya.', 'Job card pe likh diya hai.'],
  WRAP_REASK: ['Sorry, aur kuch?', 'Sorry, aur koi madad chahiye?'],
  GO_AHEAD: ['Haan, bataiye.', 'Ji, boliye.'],
  WRAP_FOR_THE_TEAM: [
    'Yeh team kar degi. Unka number SMS mein hai. Aur kuch?',
    'Yeh workshop dekhega. Number SMS pe aa jayega. Aur kuch?',
  ],
  SIGN_OFF: {
    booked: ['Shukriya {name} ji, {day} ko milte hain.', 'Call ke liye shukriya {name} ji. {day} ko milte hain.', 'Bahut badhiya, {day} ko milte hain, {name} ji.'],
    other: ['Call ke liye shukriya, {name} ji.', 'Shukriya {name} ji. Aapka din achha rahe.'],
    anonymous: ['Call ke liye shukriya.', 'Shukriya. Aapka din achha rahe.'],
  },
  EXIT: {
    number_not_found: ['Number confirm nahi ho paya, sorry. Workshop ka number SMS kar rahe hain.'],
    model_not_recognised: ['Yahan se gaadi pata nahi chal rahi. Workshop ka number SMS kar rahe hain.'],
    missing_required_field: ['Aapke record mein kuch kami hai. Workshop ka number SMS kar rahe hain.'],
    another_problem: ['Yeh team dekhegi. Hum bata dete hain, woh call karenge. Unka number SMS pe aa raha hai.'],
    free_service_not_bookable: ['Yeh free service yahan se book nahi ho sakti. Workshop ka number SMS kar rahe hain.'],
    existing_open_booking: ['Is gaadi ki ek booking pehle se hai. Badalne ke liye workshop ka number SMS kar rahe hain.'],
    forced_full_day: ['Yahan se fit nahi ho pa raha, sorry. Workshop shayad kar de, unka number SMS kar rahe hain.'],
    nothing_available_30_days: ['Is mahine us kaam ke liye jagah nahi hai. Workshop ka number SMS kar rahe hain.'],
    same_day_demanded: ['Same-day ka promise yahan se nahi ho sakta. Workshop ka number SMS kar rahe hain.'],
  },
  COST_ANSWER: ['Kharcha gaadi aur kaam pe depend karta hai. Advisor dekh ke estimate dega.', 'Woh gaadi pe depend karta hai. Check karke estimate milega.'],
  KB_PASSED: ['Yeh abhi hamare paas nahi hai. Team ko bhej diya, woh batayenge.', 'Andaaza nahi lagayenge. Team ko pass kar diya, woh call karenge.'],
  CALLBACK_YES: [
    'Haan, service centre se aapko call karwa dete hain. Unka number bhi SMS kar rahe hain.',
    'Ji, woh aapko call karenge. Number bhi SMS pe bhej rahe hain.',
  ],
  EXPLAIN: {
    next_day_fault: [
      'Service {pool} hai, par {problem} check karni hai. Isliye agle din milegi.',
      'Service toh {pool} hai, par {problem} ki jaanch hogi. Toh gaadi raat bhar rahegi.',
    ],
    next_day_major: ['Major service mein poora din lagta hai. 2 baje chhodenge toh agle din milegi.'],
    not_next_day: ['Nahi, gaadi usi shaam mil jayegi.'],
    next_day_general: ['Repair aur dopahar ki major service mein raat lagti hai. Baaki service shaam tak ho jati hai.'],
    same_day_minor: ['8:30 ya 2 baje chhodiye, shaam tak mil jayegi.'],
    same_day_major: ['Subah 8:30 chhodiye, shaam tak mil jayegi.'],
    same_day_fault: ['Repair mein gaadi raat bhar rehti hai. Kabhi kabhi same-day ho jata hai.'],
    same_day_general: ['Zyaada tar service mein 8:30 chhodiye, shaam tak mil jati hai.'],
    not_today: ['Booking kal se hoti hai, taaki workshop din plan kar sake.'],
    day_full: ['{day} ko us kaam ki saari jagah bhar chuki hai.'],
    day_full_general: ['Har din har kaam ke liye fixed jagah hoti hai.'],
    one_slot: ['{day} ko {other} pehle se full hai.'],
    one_slot_general: ['Kuch slot jaldi bhar jaate hain.'],
    ready_when: ['{day} ko {time} chhodiye, gaadi {back} milegi.'],
    ready_when_general: ['Zyaada tar service shaam tak hoti hai. Repair mein agla din lagta hai.'],
    drop_off: ['{time} reception pe gaadi chhod dijiye. Advisor check karke estimate dega.'],
    drop_off_general: ['Bas reception pe gaadi chhod dijiye. Advisor check karke estimate dega.'],
    confirmation: ['Haan, reference aur workshop ka number SMS pe aayega.'],
    change_later: ['Haan, SMS wale number pe workshop ko call kar dijiye.'],
    why_number: ['Taaki sirf gaadi ka maalik hi booking kar sake.'],
    why_fault: ['Taaki workshop jaane kya check karna hai, aur time rakhe.'],
  },
};

export const POOLS: Record<Language, Pools> = { english: EN, hinglish: HI };

/** The lines for the language the caller is speaking. English until they speak Hinglish. */
export function poolsFor(language: Language | undefined): Pools {
  return POOLS[language ?? 'english'];
}

export { EN, HI };

/** The greeting, kept as a named export for the seed's sample calls. */
export const GREETING = EN.GREETING;
