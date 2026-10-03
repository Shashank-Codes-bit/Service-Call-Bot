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
  'confirm', // write, SMS, one-sentence recap (E9)
  'ended',
] as const;
export type CallState = (typeof CALL_STATES)[number];

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
};

