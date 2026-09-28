import type { Database } from 'better-sqlite3';
import { timestamp, type IsoDate } from './dates.ts';
import { LEAD_REASONS, type DropSlot, type LeadReason, type Pool } from './types.ts';

/**
 * What we know when a call routes out. Everything but the caller's number is
 * optional, because the outcomes fire at different depths: a failed OTP knows
 * only the caller ID, a forced full day knows the vehicle and the CRM facts.
 */
export type LeadContext = {
  mobileNumber: string;
  customerId?: number | null;
  vehicleRegistration?: string | null;
  vehicleModel?: string | null;
  /** What they were trying to do. */
  requestedDate?: IsoDate | null;
  requestedSlot?: DropSlot | null;
  requestedPool?: Pool | null;
  /** CRM facts frozen at call time — the record as it was, not as it becomes. */
  crmSnapshot?: unknown;
  /** The caller's own words, quoted. */
  callerWords?: string | null;
  sessionId?: string | null;
};

export type LeadRow = {
  mobile_number: string;
  reason: LeadReason;
  customer_id: number | null;
  vehicle_registration: string | null;
  vehicle_model: string | null;
  requested_date: string | null;
  requested_slot: string | null;
  requested_pool: string | null;
  crm_snapshot: string | null;
  caller_words: string | null;
  session_id: string | null;
  created_at: string;
};

/**
 * The lead payload F2 specifies. One builder for all nine outcomes, so no
 * exit path can write a half-populated lead — the retention team only finds
 * out a lead is missing its vehicle when they try to call. Pure: takes `now`.
 */
export function buildLead(reason: LeadReason, ctx: LeadContext, now: Date): LeadRow {
  if (!LEAD_REASONS.includes(reason)) {
    // Guards the `leads.reason` CHECK from this side, so a typo fails with a
    // useful message rather than as a constraint violation.
    throw new Error(`unknown lead reason: ${reason}`);
  }
  if (!ctx.mobileNumber) {
    // Even the not-found outcome has this — it is registered against the caller
    // ID we already hold. A lead with no number is unreachable.
    throw new Error(`lead ${reason} has no mobile number`);
  }

  return {
    mobile_number: ctx.mobileNumber,
    reason,
    customer_id: ctx.customerId ?? null,
    vehicle_registration: ctx.vehicleRegistration ?? null,
    vehicle_model: ctx.vehicleModel ?? null,
    requested_date: ctx.requestedDate ?? null,
    requested_slot: ctx.requestedSlot ?? null,
    requested_pool: ctx.requestedPool ?? null,
    crm_snapshot: ctx.crmSnapshot == null ? null : JSON.stringify(ctx.crmSnapshot),
    caller_words: ctx.callerWords ?? null,
    session_id: ctx.sessionId ?? null,
    created_at: timestamp(now),
  };
}

/** The I/O half, kept separate so `buildLead` stays pure and testable. */
export function insertLead(db: Database, row: LeadRow): number {
  const info = db
    .prepare(
      `INSERT INTO leads
         (mobile_number, reason, customer_id, vehicle_registration, vehicle_model,
          requested_date, requested_slot, requested_pool, crm_snapshot, caller_words,
          session_id, created_at)
       VALUES (@mobile_number, @reason, @customer_id, @vehicle_registration, @vehicle_model,
               @requested_date, @requested_slot, @requested_pool, @crm_snapshot, @caller_words,
               @session_id, @created_at)`,
    )
    .run(row);
  return Number(info.lastInsertRowid);
}
