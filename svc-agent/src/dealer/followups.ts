import type { Database } from 'better-sqlite3';
import { addDays, timestamp, today } from '../shared/dates.ts';
import type { LeadReason } from '../shared/types.ts';
import { LEAD_REPORTS, type LeadAudience } from './reports.ts';

/**
 * The follow-up queue: every lead is a piece of work for one team until
 * someone closes it with what came of it.
 *
 * A lead's team is the one its reason belongs to (reports.ts, where each
 * reason has exactly one owner) unless someone moved it — `leads.team` holds
 * only that override, so the map stays the single source of the default.
 */

export const TEAMS = Object.keys(LEAD_REPORTS) as LeadAudience[];

/** The team as the desk names it — the same words the portal shows. */
export const TEAM_NAMES: Record<LeadAudience, string> = {
  retention: 'Retention',
  'crm-data': 'Data team',
  'customer-care': 'Customer care',
  reception: 'Reception',
  'service-manager': 'Service manager',
};
export const isTeam = (v: unknown): v is LeadAudience => TEAMS.includes(v as LeadAudience);

export const OUTCOMES = {
  booked: 'Booked',
  will_call_back: 'Called – will call back',
  no_answer: 'No answer',
  not_interested: 'Not interested',
  wrong_number: 'Wrong number',
} as const;
export type Outcome = keyof typeof OUTCOMES;
export const isOutcome = (v: unknown): v is Outcome => typeof v === 'string' && v in OUTCOMES;

/** What a person reads in the queue, rather than the enum. */
export const REASON_LABELS: Record<LeadReason, string> = {
  number_not_found: 'Number not in the customer list',
  model_not_recognised: "Couldn't tell which car",
  missing_required_field: 'A detail is missing in the CRM',
  another_problem: 'Question or problem for the team',
  free_service_not_bookable: "Free service couldn't be booked",
  existing_open_booking: 'Already booked, wants another day',
  forced_full_day: 'Nothing free on the day asked',
  nothing_available_30_days: 'Nothing free in the next 30 days',
  same_day_demanded: 'Wanted same-day return',
};

/** The label, sharpened by what the CRM said at the time where that tells more. */
function reasonLabel(reason: LeadReason, snapshot: string | null): string {
  let crm: Record<string, unknown> = {};
  try {
    crm = snapshot ? (JSON.parse(snapshot) as Record<string, unknown>) : {};
  } catch {
    /* an unreadable snapshot just gets the plain label */
  }
  if (reason === 'free_service_not_bookable' && 'due_date' in crm) {
    return crm['due_date'] == null ? 'Free service with no due date' : 'Free service lapsed (over 60 days)';
  }
  if (reason === 'missing_required_field' && crm['missing_field'] === 'service_type') {
    return 'Service type missing in the CRM';
  }
  return REASON_LABELS[reason] ?? reason;
}

/** `COALESCE(team, <the reason's own team>)`, built from the one map. */
const TEAM_SQL = `COALESCE(l.team, CASE l.reason ${Object.entries(LEAD_REPORTS)
  .flatMap(([team, r]) => r.reasons.map((reason) => `WHEN '${reason}' THEN '${team}'`))
  .join(' ')} END)`;

export type FollowUpFilter = {
  status?: 'open' | 'done' | 'all';
  when?: 'today' | 'yesterday' | '7d' | 'all';
  teams?: string[];
  q?: string;
  sort?: 'oldest' | 'newest';
  ids?: number[];
};

export type FollowUpRow = {
  id: number;
  created_at: string;
  reason: LeadReason;
  reason_label: string;
  team: LeadAudience;
  customer_name: string | null;
  mobile_number: string;
  vehicle_registration: string | null;
  vehicle_model: string | null;
  caller_words: string | null;
  requested_date: string | null;
  requested_slot: string | null;
  status: 'open' | 'done';
  outcome: Outcome | null;
  outcome_label: string | null;
  note: string | null;
  closed_by: string | null;
  closed_at: string | null;
  session_id: string | null;
  /** Open: how long it has waited so far. Done: how long it waited until closed. */
  waited_min: number;
};

const minutesBetween = (from: string, to: Date) =>
  Math.max(0, Math.round((to.getTime() - new Date(from).getTime()) / 60_000));

function where(f: FollowUpFilter, now: Date): { sql: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];
  const t = today(now);

  if (f.status === 'open' || f.status === 'done') {
    parts.push(`l.status = ?`);
    args.push(f.status);
  }
  if (f.when === 'today') {
    parts.push(`l.created_at >= ?`);
    args.push(t);
  } else if (f.when === 'yesterday') {
    parts.push(`l.created_at >= ? AND l.created_at < ?`);
    args.push(addDays(t, -1), t);
  } else if (f.when === '7d') {
    parts.push(`l.created_at >= ?`);
    args.push(addDays(t, -6));
  }
  const teams = (f.teams ?? []).filter(isTeam);
  if (teams.length) {
    parts.push(`${TEAM_SQL} IN (${teams.map(() => '?').join(',')})`);
    args.push(...teams);
  }
  const q = f.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    // A phone number is all digits; "GJ01 TU" must not match every number with a 01 in it.
    const digits = /^[\d\s+-]+$/.test(q) ? q.replace(/\D/g, '') : '';
    parts.push(
      `(c.name LIKE ? OR l.vehicle_registration LIKE ? OR l.vehicle_model LIKE ?
        OR l.caller_words LIKE ?${digits ? ' OR l.mobile_number LIKE ?' : ''})`,
    );
    args.push(like, like.replace(/\s/g, ''), like, like);
    if (digits) args.push(`%${digits}%`);
  }
  if (f.ids?.length) {
    parts.push(`l.id IN (${f.ids.map(() => '?').join(',')})`);
    args.push(...f.ids);
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
}

const SELECT = `
  SELECT l.id, l.created_at, l.reason, ${TEAM_SQL} AS team, c.name AS customer_name,
         l.mobile_number, l.vehicle_registration, l.vehicle_model, l.caller_words,
         l.requested_date, l.requested_slot, l.status, l.outcome, l.note,
         l.closed_by, l.closed_at, l.session_id, l.crm_snapshot
  FROM leads l LEFT JOIN customers c ON c.id = l.customer_id`;

function shape(
  { crm_snapshot, ...r }: Omit<FollowUpRow, 'reason_label' | 'outcome_label' | 'waited_min'> & { crm_snapshot: string | null },
  now: Date,
): FollowUpRow {
  return {
    ...r,
    reason_label: reasonLabel(r.reason, crm_snapshot),
    outcome_label: r.outcome ? OUTCOMES[r.outcome] : null,
    waited_min: minutesBetween(r.created_at, r.closed_at ? new Date(r.closed_at) : now),
  };
}

export function listFollowUps(
  db: Database,
  f: FollowUpFilter,
  { offset = 0, limit = 10, now = new Date() }: { offset?: number; limit?: number; now?: Date } = {},
): { rows: FollowUpRow[]; total: number } {
  const w = where(f, now);
  const order = f.sort === 'newest' ? 'DESC' : 'ASC';
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM leads l LEFT JOIN customers c ON c.id = l.customer_id ${w.sql}`)
      .get(...w.args) as { n: number }
  ).n;
  const rows = db
    .prepare(`${SELECT} ${w.sql} ORDER BY l.created_at ${order}, l.id ${order} LIMIT ? OFFSET ?`)
    .all(...w.args, limit, offset) as Parameters<typeof shape>[0][];
  return { rows: rows.map((r) => shape(r, now)), total };
}

/** One tile per team: what is open, how long the oldest has waited, what was done today. */
export function teamSummary(db: Database, now = new Date()) {
  const rows = db
    .prepare(
      `SELECT ${TEAM_SQL} AS team,
              SUM(l.status = 'open') AS open,
              MIN(CASE WHEN l.status = 'open' THEN l.created_at END) AS oldest,
              SUM(l.status = 'done' AND l.closed_at >= ?) AS done_today
       FROM leads l GROUP BY 1`,
    )
    .all(today(now)) as Array<{ team: string; open: number; oldest: string | null; done_today: number }>;
  return TEAMS.map((team) => {
    const r = rows.find((x) => x.team === team);
    return {
      team,
      title: LEAD_REPORTS[team].title,
      open: r?.open ?? 0,
      oldestWaitingMin: r?.oldest ? minutesBetween(r.oldest, now) : null,
      doneToday: r?.done_today ?? 0,
    };
  });
}

/** The weekly line: volume, how many were closed and booked, and the median wait. */
export function weekFigures(db: Database, now = new Date()) {
  const from = addDays(today(now), -6);
  const rows = db
    .prepare(`SELECT status, outcome, created_at, closed_at FROM leads WHERE created_at >= ?`)
    .all(from) as Array<{ status: string; outcome: string | null; created_at: string; closed_at: string | null }>;
  const waits = rows
    .filter((r) => r.closed_at)
    .map((r) => minutesBetween(r.created_at, new Date(r.closed_at!)))
    .sort((a, b) => a - b);
  const mid = Math.floor(waits.length / 2);
  const median =
    waits.length === 0 ? null : waits.length % 2 ? waits[mid]! : Math.round((waits[mid - 1]! + waits[mid]!) / 2);
  return {
    from,
    total: rows.length,
    closed: rows.filter((r) => r.status === 'done').length,
    booked: rows.filter((r) => r.outcome === 'booked').length,
    medianWaitMin: median,
  };
}

export type FollowUpChange =
  | { team: string }
  | { close: { outcome: string; note?: string | null } }
  | { reopen: true };

/** Reassign, close with an outcome, or reopen. Returns how many rows changed. */
export function changeFollowUps(
  db: Database,
  ids: number[],
  change: FollowUpChange,
  by: string,
  now = new Date(),
): number {
  if (!ids.length) return 0;
  const marks = ids.map(() => '?').join(',');
  return db.transaction(() => {
    if ('team' in change) {
      if (!isTeam(change.team)) throw new RangeError(`unknown team: ${change.team}`);
      return db.prepare(`UPDATE leads SET team = ? WHERE id IN (${marks})`).run(change.team, ...ids).changes;
    }
    if ('close' in change) {
      if (!isOutcome(change.close.outcome)) throw new RangeError(`unknown outcome: ${change.close.outcome}`);
      const note = change.close.note?.toString().trim().slice(0, 500) || null;
      return db
        .prepare(
          `UPDATE leads SET status = 'done', outcome = ?, note = ?, closed_by = ?, closed_at = ?
           WHERE id IN (${marks}) AND status = 'open'`,
        )
        .run(change.close.outcome, note, by, timestamp(now), ...ids).changes;
    }
    return db
      .prepare(
        `UPDATE leads SET status = 'open', outcome = NULL, closed_by = NULL, closed_at = NULL
         WHERE id IN (${marks}) AND status = 'done'`,
      )
      .run(...ids).changes;
  })();
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export const CSV_COLUMNS = [
  'created', 'waited', 'team', 'customer', 'mobile', 'plate', 'reason', 'caller said',
  'status', 'outcome', 'closed by', 'closed at', 'note',
] as const;

export function formatWait(min: number): string {
  if (min < 60) return `${min} m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/**
 * RFC 4180 quoting, and a leading `'` on anything a spreadsheet would run as a
 * formula — a caller's words are typed by the public, and `=HYPERLINK(…)` in a
 * cell is how that becomes someone else's problem.
 */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function followUpsCsv(rows: FollowUpRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.created_at.slice(0, 16).replace('T', ' '),
        formatWait(r.waited_min),
        TEAM_NAMES[r.team] ?? r.team,
        r.customer_name,
        r.mobile_number,
        r.vehicle_registration,
        r.reason_label,
        r.caller_words,
        r.status,
        r.outcome_label,
        r.closed_by,
        r.closed_at ? r.closed_at.slice(0, 16).replace('T', ' ') : '',
        r.note,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

