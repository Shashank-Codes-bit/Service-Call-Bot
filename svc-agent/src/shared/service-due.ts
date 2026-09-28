import { daysBetween, type IsoDate } from './dates.ts';
import type { LeadReason, Pool, ServiceType } from './types.ts';

/** What the CRM returns for a vehicle (D1). Never derived, never confirmed
 *  with the caller — the account lookup is the source of truth. */
export type ServiceDueRecord = {
  service_number: number;
  /** NULL is legal and blocks booking outright (D3). */
  service_type: ServiceType | null;
  /** SQLite hands this back as 0/1. */
  is_free: boolean | number;
  /** NULL is legal — e.g. serviced outside the network (D2). */
  due_date: IsoDate | null;
};

/**
 * A free service this far past its due date is no longer bookable (D2).
 * Exactly 60 blocks: CONTEXT's parenthetical ("60+ days before the call date")
 * is the precise reading, and both sides of it are asserted by test.
 */
export const FREE_SERVICE_OVERDUE_DAYS = 60;

export type Bookable = { bookable: true; serviceType: ServiceType };
export type NotBookable = {
  bookable: false;
  /** The routing outcome this refusal becomes (F2). */
  reason: LeadReason;
  /** Said to the caller's benefit in the lead, not to the caller. */
  detail: string;
  /** Set only for missing_required_field — the lead must name the field (D3). */
  missingField?: string;
};
export type Assessment = Bookable | NotBookable;

const isFree = (v: boolean | number) => v === true || v === 1;

/**
 * The D2/D3 blockers, as one decision. Returns the refusal's lead reason, not
 * a boolean, so exactly one place maps a failure onto F2's nine outcomes.
 *
 * `callDate` is passed in, never read from the clock: a call that starts before
 * midnight must keep judging against the day it started (D5).
 */
export function assessBookability(
  due: ServiceDueRecord | null | undefined,
  callDate: IsoDate,
): Assessment {
  // No record at all: nothing to state, let alone book.
  if (!due) {
    return {
      bookable: false,
      reason: 'missing_required_field',
      detail: 'no service-due record for this vehicle',
      missingField: 'service_due',
    };
  }

  // D3: no type means no capacity pool. The lead names the field so the CRM
  // team can fix that record.
  if (due.service_type === null) {
    return {
      bookable: false,
      reason: 'missing_required_field',
      detail: 'service type is not set on the CRM record',
      missingField: 'service_type',
    };
  }

  // The 60-day rule and the null-due-date rule are FREE-ONLY. A paid service
  // books normally whatever its due date says, including no due date at all.
  if (isFree(due.is_free)) {
    if (due.due_date === null) {
      return {
        bookable: false,
        reason: 'free_service_not_bookable',
        detail: 'free service with no due date on record — the centre must make contact',
      };
    }

    // Negative means the due date is in the future, which is never a blocker:
    // a caller whose service is due in six months can still book today.
    const overdueBy = daysBetween(due.due_date, callDate);
    if (overdueBy >= FREE_SERVICE_OVERDUE_DAYS) {
      return {
        bookable: false,
        reason: 'free_service_not_bookable',
        detail: `free service ${overdueBy} days overdue — past the ${FREE_SERVICE_OVERDUE_DAYS}-day cutoff`,
      };
    }
  }

  return { bookable: true, serviceType: due.service_type };
}

/**
 * Which capacity pool the job takes (D8). A complaint overrides the CRM's
 * service type — longer job, next-day delivery either way (D7). A special
 * request does not change the pool; it is a note only.
 */
export function poolFor(serviceType: ServiceType, hasComplaint: boolean): Pool {
  return hasComplaint ? 'complaint' : serviceType;
}

export type AccountVehicle = {
  id: number;
  model: string;
  registration_number: string;
  due?: ServiceDueRecord | null;
};

/**
 * D12's closing upsell — a mention only; a second vehicle needs a second call.
 *
 * Returns only vehicles we would actually accept. Raising a car at the close
 * and refusing it on the next call is worse than staying quiet, so anything
 * blocked by D2 or D3 is never mentioned.
 */
export function otherDueVehicles(
  vehicles: AccountVehicle[],
  bookingVehicleId: number,
  callDate: IsoDate,
): AccountVehicle[] {
  return vehicles.filter(
    (v) => v.id !== bookingVehicleId && assessBookability(v.due, callDate).bookable,
  );
}

// ---------------------------------------------------------------------------

/**
 * D11 — one shared pushback counter across every forced question. Per-question
 * counters would let a caller take three swings at each in turn and never hit
 * a limit. The count lives in session state (F5); this module owns the rule.
 */
export const PUSHBACK_LIMIT = 3;

export type PushbackState = { count: number; exhausted: boolean };

/** Record one instance of the caller forcing something. */
export function registerPushback(count: number): PushbackState {
  const next = count + 1;
  return { count: next, exhausted: next >= PUSHBACK_LIMIT };
}

export function isExhausted(count: number): boolean {
  return count >= PUSHBACK_LIMIT;
}

/** How many more times the caller can push before we route out. */
export function remaining(count: number): number {
  return Math.max(0, PUSHBACK_LIMIT - count);
}
