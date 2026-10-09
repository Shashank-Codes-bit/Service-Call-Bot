import type { IsoDate } from '../shared/dates.ts';
import type { ServiceDueRecord } from '../shared/service-due.ts';
import type { DropSlot, LeadReason, Pool } from '../shared/types.ts';

/**
 * The states of the call (PART E). Our code moves between these; the LLM never
 * does (B1).
 */
const CALL_STATES = [
  'greeting', // centre name, AI disclosure, caller-ID check (E1)
  'awaiting_number', // "different phone" branch — keypad entry
  'awaiting_otp', // 4 digits, 3 attempts (E1)
  'vehicle', // model + last 4, three matching passes (E2)
  'open_turn', // "How can I help?" + slot extraction (E3, G6)
  'complaint', // "is there anything actually wrong with the car?" (E6)
  'special_request', // only asked when there was no complaint (D8)
  'day', // D5, D6
  'drop_slot', // two outcomes with consequences (E8)
  'confirm', // the same-day nudge (D7)
  'confirm_booking', // the readback: "So that's Friday, drop at 8:30. Shall I book it?"
  'wrap_up', // "Anything else?" — the caller decides when the call is over
  'ended',
] as const;
export type CallState = (typeof CALL_STATES)[number];

/** The language the agent replies in: it follows the caller (templates.ts EN / HI). */
export type Language = 'english' | 'hinglish';

/**
 * Where a reported fault is, from a closed list: the model picks one, our code
 * says the sentence ("Got it, a problem with the gears."), so no model-written
 * words are ever spoken (B3).
 */
export const FAULT_AREAS = [
  'gears', 'clutch', 'brakes', 'engine', 'ac', 'battery', 'steering', 'suspension',
  'noise', 'warning_light', 'electrics', 'tyres', 'body', 'other',
] as const;
export type FaultArea = (typeof FAULT_AREAS)[number];

/**
 * "Why is it next day?", "When do I get it back?" — questions about how the
 * booking works, answered by our code from the call's own state (templates.ts
 * EXPLAIN), never by the knowledge bank and never by a model.
 */
export const EXPLAIN_TOPICS = [
  'next_day', 'same_day_how', 'not_today', 'day_full', 'one_slot', 'ready_when',
  'drop_off', 'confirmation', 'change_later', 'why_number', 'why_fault',
] as const;
export type ExplainTopic = (typeof EXPLAIN_TOPICS)[number];

export type KnownVehicle = {
  id: number;
  registration: string;
  model: string;
  due: ServiceDueRecord | null;
};

/**
 * Everything the call holds between turns (F5). Persisted as JSON on
 * `sessions.data`, so it survives a restart and can be rendered as the
 * state-derived summary after the call ends (F4).
 */
export type SessionData = {
  centreId: number;
  /** The number they are calling from — known before anything else. */
  callerNumber: string;
  /** When the call began. Decides what "tomorrow" means for the whole call (D5). */
  startedAt: string;
  /**
   * A telephony provider's own call id, when one drove this call. Kept in the
   * session rather than the schema so provider identifiers never leak into
   * the data model.
   */
  externalId?: string;

  customerId?: number;
  customerName?: string;
  vehicles?: KnownVehicle[];

  /** Once set, this is the vehicle for this call. One call, one booking (D12). */
  vehicleId?: number;
  registration?: string;
  model?: string;
  due?: ServiceDueRecord | null;

  pool?: Pool;
  bookingDate?: IsoDate;
  /** E7 — they said any day would do, so we choose one rather than ask. */
  noDayPreference?: boolean;
  dropSlot?: DropSlot;
  complaintNote?: string;

  /** D11 — one counter for all forcing, never one per question. */
  pushback: number;
  /** E1 — three wrong codes ends the call. */
  otpAttempts: number;
  otpCode?: string;
  /** D7 — once declined, never raise the same-day nudge again. */
  sameDayNudgeDeclined?: boolean;
  /** Quoted into any lead this call produces (F2). */
  lastCallerWords?: string;
  /**
   * The follow-up a question the bank couldn't answer went into. A second
   * such question in the same call joins it, rather than filing another.
   */
  passedLeadId?: number;
  /** The cars were read out as a numbered list, so "two" picks the second. */
  vehicleListed?: boolean;
  /** Turns spent in the closing "Anything else?", capped so it ends. */
  wrapTurns?: number;
  /** The closing was re-asked once after an unclear answer. */
  wrapReasked?: boolean;
  /** The same-day nudge was re-asked once after an unclear answer. */
  nudgeReasked?: boolean;
  /** "Which day?" asked again once already; next time we offer the soonest. */
  dayReasked?: boolean;
  /** Centre topics the caller asked about before booking, for the job card. */
  askedAbout?: string[];
  /** The caller's last message as the voice layer sent it, whole (vapi.ts `newWords`). */
  lastHeard?: string;
  /** How many caller messages Vapi had sent by then: one more is a new turn. */
  lastHeardCount?: number;
  /** Vapi's end-of-call report: why the line closed, and how long it was open. */
  endedReason?: string;
  durationSeconds?: number;
  /** The language replies are in, following the caller; English until they speak Hinglish. */
  language?: Language;
  /** Plain-English caller turns in a row; two switch a Hinglish call back to English. */
  englishTurns?: number;
  /** The last day we said was full, for "why is it full?". */
  lastFullDay?: IsoDate;
  /** Where the reported fault is, when the caller said (FAULT_AREAS). */
  faultArea?: FaultArea;
  /** Set when the call ended by routing out. */
  leadReason?: LeadReason;
  bookingReference?: string;
};

/** What one turn returns to whatever is driving the call — chat or telephony. */
export type TurnResult = {
  sessionId: string;
  state: CallState;
  reply: string;
  ended: boolean;
  /** Keypad entry expected — the voice layer switches to DTMF (E1). */
  expectsDigits?: boolean;
  bookingReference?: string;
  leadReason?: LeadReason;
  /**
   * What the turn was understood as, in labels only — never the caller's
   * words — for the voice layer's log line.
   */
  understood?: string;
};

