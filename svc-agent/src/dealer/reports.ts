import type { Database } from 'better-sqlite3';
import type { IsoDate } from '../shared/dates.ts';
import { arrivals } from '../shared/bookings.ts';
import { CENTRE_ID, LEAD_REASONS, type LeadReason } from '../shared/types.ts';

/**
 * F3's rule: **a lead type appears in exactly one report.** A lead in two
 * reports is a lead nobody owns.
 *
 * Encoding it as one map rather than seven queries makes the rule structural —
 * adding a reason to a second audience is then a test failure, not a slow leak.
 */
export const LEAD_REPORTS = {
  'customer-care': {
    title: 'Customer care',
    why: 'Most urgent. Breakdowns and grievances — and questions the knowledge bank could not answer.',
    reasons: ['another_problem'],
  },
  retention: {
    title: 'Retention / marketing',
    why: 'Highest commercial value — customers who tried to book and were turned away. This is the report that pays for the retainer.',
    reasons: ['free_service_not_bookable'],
  },
  'service-manager': {
    title: 'Service manager',
    why: 'Capacity vs demand. "Nothing in 30 days" is the loudest alarm in the system.',
    reasons: ['forced_full_day', 'nothing_available_30_days', 'same_day_demanded'],
  },
  'crm-data': {
    title: 'CRM / data team',
    why: 'Data quality. Left alone, these make the agent fail for that customer every time.',
    reasons: ['number_not_found', 'model_not_recognised', 'missing_required_field'],
  },
  reception: {
    title: 'Reception',
    why: 'Operational. A rising count means nobody is closing completed bookings.',
    reasons: ['existing_open_booking'],
  },
} as const satisfies Record<
  string,
  { title: string; why: string; reasons: readonly LeadReason[] }
>;

export const BOOKING_REPORTS = {
  'bookings-arrivals': {
    title: 'Bookings — arrivals',
    why: "Reception's working document for receiving cars. Every booking arriving today, whatever day it was made.",
  },
  'bookings-activity': {
    title: 'Bookings — activity',
    why: 'The management number. Everything booked in the day\'s window.',
  },
} as const;

export type LeadAudience = keyof typeof LEAD_REPORTS;
export type BookingAudience = keyof typeof BOOKING_REPORTS;
export type Audience = LeadAudience | BookingAudience;

export const AUDIENCES = [
  ...Object.keys(LEAD_REPORTS),
  ...Object.keys(BOOKING_REPORTS),
] as Audience[];

export function isAudience(a: string): a is Audience {
  return (AUDIENCES as string[]).includes(a);
}

/** Every reason is owned by exactly one report. Asserted by test, not hoped for. */
export function auditReasonCoverage(): { reason: LeadReason; owners: LeadAudience[] }[] {
  return LEAD_REASONS.map((reason) => ({
    reason,
    owners: (Object.keys(LEAD_REPORTS) as LeadAudience[]).filter((a) =>
      (LEAD_REPORTS[a].reasons as readonly string[]).includes(reason),
    ),
  }));
}

// ---------------------------------------------------------------------------

export type ReportRow = Record<string, unknown>;
export type Report = {
  audience: Audience;
  title: string;
  why: string;
  date: IsoDate;
  rows: ReportRow[];
  /** Retention splits into two working lists; other reports have one. */
  groups?: { label: string; hint: string; rows: ReportRow[] }[];
};

/**
 * Reports are **generated on demand** by date — no scheduler, no persistence,
 * no status tracking (F3). Nobody marks a lead closed in our system.
 */
export function runReport(db: Database, audience: Audience, date: IsoDate): Report {
  if (audience === 'bookings-arrivals') {
    // Shares the Arrivals tab's query rather than running a second one. Two
    // implementations of "who is arriving today" is two answers waiting to
    // diverge.
    return {
      audience,
      ...BOOKING_REPORTS[audience],
      date,
      rows: arrivals(db, CENTRE_ID, date) as ReportRow[],
    };
  }

  if (audience === 'bookings-activity') {
    return {
      audience,
      ...BOOKING_REPORTS[audience],
      date,
      rows: db
        .prepare(
          `SELECT b.booking_reference, b.created_at, b.booking_date, b.drop_slot,
                  b.service_type, b.source, c.name AS customer_name,
                  v.model, v.registration_number
           FROM bookings b
           JOIN vehicles v ON v.id = b.vehicle_id
           JOIN customers c ON c.id = v.customer_id
           WHERE substr(b.created_at, 1, 10) = ?
           ORDER BY b.created_at`,
        )
        .all(date) as ReportRow[],
    };
  }

  const spec = LEAD_REPORTS[audience];
  const placeholders = spec.reasons.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT l.id, l.created_at, l.mobile_number, l.reason,
              c.name AS customer_name,
              l.vehicle_registration, l.vehicle_model,
              l.requested_date, l.requested_slot, l.requested_pool,
              l.caller_words, l.crm_snapshot, l.session_id,
              json_extract(l.crm_snapshot, '$.due_date') AS due_date
       FROM leads l
       LEFT JOIN customers c ON c.id = l.customer_id
       WHERE substr(l.created_at, 1, 10) = ? AND l.reason IN (${placeholders})
       ORDER BY l.created_at`,
    )
    .all(date, ...spec.reasons) as ReportRow[];

  const report: Report = { audience, title: spec.title, why: spec.why, date, rows };

  // The merged free-service reason splits back into its two call scripts here
  // (F2) — same rows, two different conversations.
  if (audience === 'retention') {
    report.groups = [
      {
        label: 'Chase — overdue',
        hint: 'Free service went past the 60-day cutoff. "It was due in June, let\'s get you in."',
        rows: rows.filter((r) => r['due_date'] != null),
      },
      {
        label: 'Record fix — no due date',
        hint: 'We have no record of when their service is due. Likely serviced outside the network — fix the record, then win them back.',
        rows: rows.filter((r) => r['due_date'] == null),
      },
    ];
  }

  return report;
}
