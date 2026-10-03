import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { addDays, today, type IsoDate } from '../shared/dates.ts';
import {
  BOOKING_WINDOW_DAYS,
  CENTRE_ID,
  DROP_SLOTS,
  POOLS,
  type DropSlot,
  type Pool,
} from '../shared/types.ts';
import {
  capacityWindow,
  readMaster,
  regenerateCapacity,
  writeMaster,
} from '../shared/capacity.ts';
import {
  arrivals,
  closeBooking,
  createBooking,
  dayBookings,
  DuplicateBookingError,
  markArrived,
  openBookingForRegistration,
  rescheduleBooking,
  SlotFullError,
} from '../shared/bookings.ts';
import { assessBookability, type ServiceDueRecord } from '../shared/service-due.ts';
import {
  changeFollowUps,
  followUpsCsv,
  isOutcome,
  isTeam,
  listFollowUps,
  OUTCOMES,
  teamSummary,
  TEAMS,
  weekFigures,
  type FollowUpChange,
  type FollowUpFilter,
} from './followups.ts';
import { AUDIENCES, isAudience, LEAD_REPORTS, BOOKING_REPORTS, runReport } from './reports.ts';
import { deleteEntry, TableKnowledgeBank, upsertEntry } from '../kb/index.ts';
import { readTranscript } from '../call/session.ts';

const isPool = (v: unknown): v is Pool => POOLS.includes(v as Pool);
const isDropSlot = (v: unknown): v is DropSlot => DROP_SLOTS.includes(v as DropSlot);
const isIsoDate = (v: unknown): v is IsoDate => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Who is signed in, for "closed by". Absent when the router is mounted bare, as in tests. */
const signedIn = (res: { locals: Record<string, unknown> }): string =>
  (res.locals['org'] as { user_id?: string } | undefined)?.user_id ?? 'desk';

const intList = (v: unknown): number[] =>
  String(v ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

function filterFrom(q: Record<string, unknown>): FollowUpFilter {
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(v as T) ? (v as T) : fallback;
  return {
    status: pick(q['status'], ['open', 'done', 'all'] as const, 'open'),
    when: pick(q['when'], ['today', 'yesterday', '7d', 'all'] as const, 'all'),
    teams: String(q['teams'] ?? '').split(',').filter(isTeam),
    q: String(q['q'] ?? '').slice(0, 80),
    sort: pick(q['sort'], ['oldest', 'newest'] as const, 'oldest'),
    ...(q['ids'] ? { ids: intList(q['ids']) } : {}),
  };
}

/**
 * What stops the desk booking a car: the same D2/D3 rules the agent applies,
 * and an open booking already on it. Worded for the person at the counter.
 */
function blockerFor(
  db: Database,
  vehicleId: number,
  due: ServiceDueRecord | null,
  on: IsoDate,
): string | null {
  const open = db
    .prepare(
      `SELECT booking_reference, booking_date, drop_slot FROM bookings
       WHERE vehicle_id = ? AND status = 'open'`,
    )
    .get(vehicleId) as { booking_reference: string; booking_date: string; drop_slot: DropSlot } | undefined;
  if (open) {
    return `Already booked for ${open.booking_date}, ${open.drop_slot === 'morning' ? '8:30' : '2:00'} (${open.booking_reference}). Change that booking instead.`;
  }
  const a = assessBookability(due, on);
  if (a.bookable) return null;
  if (a.reason === 'missing_required_field') return 'Service type missing in the CRM. The data team fills it in.';
  if (due?.due_date == null) return 'Free service with no due date. Retention confirms eligibility first.';
  return 'Free service lapsed (over 60 days). Offer it as a paid service.';
}

export function api(db: Database): Router {
  const r = Router();

  // -------------------------------------------------------------------------
  // Capacity — ours, and the dealer's only bay-management system (D4).
  // -------------------------------------------------------------------------
  //
  // There were three /crm/* endpoints here — lookup by mobile, by registration
  // and by vehicle id. Nothing called them: the call app reaches dealer data
  // through the `Crm` interface in src/call/crm.ts, which queries the tables
  // directly, and the portal never asked for them. Unauthenticated, they let
  // anyone with the link enumerate customers by phone number. C1's swappable
  // boundary is that interface, not a second one over HTTP.

  r.get('/capacity/master', (_req, res) => res.json(readMaster(db)));

  /**
   * Saving the master applies it. Two separate clicks meant a dealer could
   * change a figure, see the grid update, and have the live window silently
   * keep the old one. One transaction, and conflicts come back from the same
   * call, so a cut that could not fully land is reported by the click.
   */
  r.put('/capacity/master', (req, res) => {
    try {
      const applied = db.transaction(() => {
        writeMaster(db, req.body); // validates; throws on a bad figure
        return regenerateCapacity(db);
      })();
      res.json({ ok: true, master: readMaster(db), applied });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.post('/capacity/regenerate', (_req, res) => {
    // Never touches the past; clamps a cut to what's already booked; reports
    // the days where the cut could not fully land.
    res.json(regenerateCapacity(db));
  });

  r.get('/capacity/window', (req, res) => {
    // Clamped: the endpoint is open, and `days` arrived from the query string.
    const asked = Number(req.query['days'] ?? BOOKING_WINDOW_DAYS);
    const days = Number.isFinite(asked)
      ? Math.min(Math.max(Math.trunc(asked), 1), BOOKING_WINDOW_DAYS)
      : BOOKING_WINDOW_DAYS;
    res.json(capacityWindow(db, CENTRE_ID, { days }));
  });

  // -------------------------------------------------------------------------
  // Bookings — the dealer's own channel, through the shared write path.
  // -------------------------------------------------------------------------

  r.get('/bookings/arrivals', (req, res) => {
    const date = isIsoDate(req.query['date']) ? req.query['date'] : today();
    res.json({ date, rows: arrivals(db, CENTRE_ID, date) });
  });

  r.get('/bookings/open/:registration', (req, res) => {
    const existing = openBookingForRegistration(db, req.params.registration);
    res.json({ open: Boolean(existing), booking: existing ?? null });
  });

  r.post('/bookings', (req, res) => {
    const { vehicleId, pool, bookingDate, dropSlot, complaintNote } = req.body ?? {};

    if (!Number.isInteger(vehicleId)) return res.status(400).json({ error: 'vehicleId required' });
    if (!isPool(pool)) return res.status(400).json({ error: `pool must be one of ${POOLS.join(', ')}` });
    if (!isIsoDate(bookingDate)) return res.status(400).json({ error: 'bookingDate must be YYYY-MM-DD' });
    if (!isDropSlot(dropSlot)) return res.status(400).json({ error: 'dropSlot must be morning or afternoon' });

    // Checked here rather than left to the foreign key: the FK throws past the
    // handlers below and lands on the generic 500, so the caller cannot tell a
    // bad request from a server fault. That matters once the bot is the caller.
    const vehicle = db.prepare(`SELECT 1 FROM vehicles WHERE id = ?`).get(vehicleId);
    if (!vehicle) {
      return res.status(404).json({ error: `no vehicle ${vehicleId}`, kind: 'unknown_vehicle' });
    }

    try {
      const booking = createBooking(db, {
        vehicleId,
        centreId: CENTRE_ID,
        pool,
        bookingDate,
        dropSlot,
        complaintNote: complaintNote ?? null,
        source: 'dealer',
      });
      res.status(201).json(booking);
    } catch (e) {
      // These two are expected outcomes, not faults — the UI shows them as
      // messages rather than errors.
      if (e instanceof SlotFullError) {
        return res.status(409).json({ error: e.message, kind: 'slot_full' });
      }
      if (e instanceof DuplicateBookingError) {
        return res.status(409).json({ error: e.message, kind: 'duplicate', reference: e.reference });
      }
      throw e;
    }
  });

  r.patch('/bookings/:reference', (req, res) => {
    const reference = String(req.params.reference);
    if (req.body?.arrived === true) {
      const outcome = markArrived(db, reference);
      if (outcome === 'not_found') return res.status(404).json({ error: 'no such booking' });
      if (outcome === 'not_open') return res.status(409).json({ error: 'booking is closed', kind: 'not_open' });
      return res.json({ ok: true, reference, arrived: true });
    }
    if (req.body?.arrived === false) {
      db.prepare(`UPDATE bookings SET arrived_at = NULL WHERE booking_reference = ? AND status = 'open'`).run(reference);
      return res.json({ ok: true, reference, arrived: false });
    }
    const status = req.body?.status;
    if (status !== 'completed' && status !== 'cancelled') {
      return res.status(400).json({ error: 'status must be completed or cancelled' });
    }
    const outcome = closeBooking(db, reference, status);
    if (outcome === 'not_found') return res.status(404).json({ error: 'no such booking' });
    if (outcome === 'not_open') {
      return res.status(409).json({ error: 'booking is already closed', kind: 'not_open' });
    }
    res.json({ ok: true, reference, status });
  });

  /** Move an open booking, keeping its reference. A full target is a 409. */
  r.post('/bookings/:reference/reschedule', (req, res) => {
    const { bookingDate, dropSlot } = req.body ?? {};
    if (!isIsoDate(bookingDate)) return res.status(400).json({ error: 'bookingDate must be YYYY-MM-DD' });
    if (!isDropSlot(dropSlot)) return res.status(400).json({ error: 'dropSlot must be morning or afternoon' });
    if (bookingDate < today()) return res.status(400).json({ error: 'that day has passed' });
    try {
      const r2 = rescheduleBooking(db, String(req.params.reference), { bookingDate, dropSlot });
      if (r2.outcome !== 'moved') {
        return r2.outcome === 'not_found'
          ? res.status(404).json({ error: 'no such booking' })
          : res.status(409).json({ error: 'booking is closed', kind: 'not_open' });
      }
      res.json(r2.booking);
    } catch (e) {
      if (e instanceof SlotFullError) return res.status(409).json({ error: e.message, kind: 'slot_full' });
      throw e;
    }
  });

  // -------------------------------------------------------------------------
  // The day board.
  // -------------------------------------------------------------------------

  /** One day: its bookings with car and customer, and the places used per pool. */
  r.get('/day', (req, res) => {
    const date = isIsoDate(req.query['date']) ? req.query['date'] : today();
    const places = db
      .prepare(
        `SELECT service_type AS pool, drop_slot, total_slots AS total, booked_slots AS used
         FROM slot_capacity WHERE centre_id = ? AND date = ?`,
      )
      .all(CENTRE_ID, date);
    res.json({ date, today: today(), bookings: dayBookings(db, CENTRE_ID, date), places });
  });

  /** The date strip: cars booked and places free, per day. */
  r.get('/days', (req, res) => {
    const from = isIsoDate(req.query['from']) ? req.query['from'] : today();
    const asked = Number(req.query['days'] ?? 14);
    const days = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 45) : 14;
    const to = addDays(from, days - 1);
    const cars = db
      .prepare(
        `SELECT booking_date AS date, COUNT(*) AS n FROM bookings
         WHERE centre_id = ? AND booking_date BETWEEN ? AND ? AND status != 'cancelled'
         GROUP BY booking_date`,
      )
      .all(CENTRE_ID, from, to) as { date: string; n: number }[];
    const free = db
      .prepare(
        `SELECT date, SUM(total_slots - booked_slots) AS n FROM slot_capacity
         WHERE centre_id = ? AND date BETWEEN ? AND ? GROUP BY date`,
      )
      .all(CENTRE_ID, from, to) as { date: string; n: number }[];
    res.json(
      Array.from({ length: days }, (_, i) => {
        const date = addDays(from, i);
        return {
          date,
          cars: cars.find((c) => c.date === date)?.n ?? 0,
          free: free.find((f) => f.date === date)?.n ?? null,
        };
      }),
    );
  });

  /** Find a customer by name, phone, plate or booking reference. */
  r.get('/search', (req, res) => {
    const raw = String(req.query['q'] ?? '').trim().slice(0, 60);
    const q = raw.toLowerCase().replace(/\s/g, '');
    if (q.length < 2) return res.json([]);
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const rows = db
      .prepare(
        `SELECT c.id AS customer_id, c.name, c.mobile_number,
                v.id AS vehicle_id, v.registration_number, v.model,
                (SELECT b.booking_reference FROM bookings b WHERE b.vehicle_id = v.id AND b.status = 'open') AS open_reference,
                (SELECT b.booking_date FROM bookings b WHERE b.vehicle_id = v.id AND b.status = 'open') AS open_date,
                (SELECT b.drop_slot FROM bookings b WHERE b.vehicle_id = v.id AND b.status = 'open') AS open_slot
         FROM customers c JOIN vehicles v ON v.customer_id = c.id
         WHERE replace(lower(c.name), ' ', '') LIKE ? OR c.mobile_number LIKE ?
            OR lower(v.registration_number) LIKE ?
            OR EXISTS (SELECT 1 FROM bookings b WHERE b.vehicle_id = v.id AND b.booking_reference LIKE ?)
         ORDER BY c.name, v.model LIMIT 24`,
      )
      .all(like, like, like, like);
    res.json(rows);
  });

  /** One customer with every car, each with what it is due and what blocks it. */
  r.get('/customers/:id', (req, res) => {
    const id = Number(req.params.id);
    const c = db.prepare(`SELECT id, name, mobile_number FROM customers WHERE id = ?`).get(id);
    if (!c) return res.status(404).json({ error: 'no such customer' });
    const cars = (
      db
        .prepare(
          `SELECT v.id, v.registration_number, v.model, s.service_number, s.service_type, s.is_free, s.due_date
           FROM vehicles v LEFT JOIN service_due s ON s.vehicle_id = v.id
           WHERE v.customer_id = ? ORDER BY v.model`,
        )
        .all(id) as Array<{ id: number; service_number: number | null; service_type: 'minor' | 'major' | null; is_free: number | null; due_date: string | null }>
    ).map((v) => ({
      ...v,
      blocker: blockerFor(
        db,
        v.id,
        v.service_number == null
          ? null
          : { service_number: v.service_number, service_type: v.service_type, is_free: v.is_free ?? 0, due_date: v.due_date },
        today(),
      ),
    }));
    res.json({ ...c, cars });
  });

  /** Free places per pool and drop for each day from today, for the pickers. */
  r.get('/free', (req, res) => {
    const asked = Number(req.query['days'] ?? 14);
    const days = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), BOOKING_WINDOW_DAYS + 1) : 14;
    res.json(
      capacityWindow(db, CENTRE_ID, { days: days - 1 }).map((d) => ({
        date: d.date,
        pools: Object.fromEntries(
          POOLS.map((p) => [p, { morning: d.pools[p].morning.free, afternoon: d.pools[p].afternoon.free }]),
        ),
      })),
    );
  });

  // -------------------------------------------------------------------------
  // Follow-ups — leads as a work queue.
  // -------------------------------------------------------------------------

  r.get('/followups', (req, res) => {
    const f = filterFrom(req.query);
    const offset = Math.max(0, Math.trunc(Number(req.query['offset']) || 0));
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.query['limit']) || 10)));
    const { rows, total } = listFollowUps(db, f, { offset, limit });
    res.json({
      rows,
      total,
      teams: teamSummary(db),
      week: weekFigures(db),
      outcomes: OUTCOMES,
      openTotal: listFollowUps(db, { status: 'open' }, { limit: 1 }).total,
    });
  });

  r.get('/followups.csv', (req, res) => {
    const f = filterFrom(req.query);
    const { rows } = listFollowUps(db, f, { limit: 10_000 });
    res
      .type('text/csv; charset=utf-8')
      .set('content-disposition', `attachment; filename="follow-ups-${today()}.csv"`)
      .send('\uFEFF' + followUpsCsv(rows));
  });

  const change = (body: Record<string, unknown>): FollowUpChange | string => {
    if (typeof body['team'] === 'string') return isTeam(body['team']) ? { team: body['team'] } : `team must be one of ${TEAMS.join(', ')}`;
    const close = body['close'] as { outcome?: unknown; note?: unknown } | undefined;
    if (close) {
      if (!isOutcome(close.outcome)) return `outcome must be one of ${Object.keys(OUTCOMES).join(', ')}`;
      return { close: { outcome: close.outcome, note: typeof close.note === 'string' ? close.note : null } };
    }
    if (body['reopen'] === true) return { reopen: true };
    return 'send one of: team, close {outcome, note}, reopen';
  };
  const closer = (req: { body?: Record<string, unknown> }, res: { locals: Record<string, unknown> }) => {
    const by = typeof req.body?.['by'] === 'string' ? req.body['by'].trim().slice(0, 40) : '';
    return by || signedIn(res);
  };

  r.patch('/followups/:id', (req, res) => {
    const id = Number(req.params.id);
    const c = change(req.body ?? {});
    if (typeof c === 'string') return res.status(400).json({ error: c });
    if (!db.prepare(`SELECT 1 FROM leads WHERE id = ?`).get(id)) return res.status(404).json({ error: 'no such follow-up' });
    const changed = changeFollowUps(db, [id], c, closer(req, res));
    res.json({ ok: true, changed });
  });

  r.post('/followups/bulk', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    if (ids.length > 500) return res.status(400).json({ error: 'at most 500 at a time' });
    const c = change(req.body ?? {});
    if (typeof c === 'string') return res.status(400).json({ error: c });
    res.json({ ok: true, changed: changeFollowUps(db, ids, c, closer(req, res)) });
  });

  /** Vehicles the dealer can pick from when taking a slot. Demo convenience. */
  r.get('/vehicles', (_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT v.id, v.registration_number, v.model, c.name AS customer_name,
                  c.mobile_number, s.service_type, s.is_free, s.due_date,
                  EXISTS (SELECT 1 FROM bookings b
                          WHERE b.vehicle_id = v.id AND b.status = 'open') AS has_open_booking
           FROM vehicles v
           JOIN customers c ON c.id = v.customer_id
           LEFT JOIN service_due s ON s.vehicle_id = v.id
           ORDER BY c.name, v.model`,
        )
        .all(),
    );
  });

  // -------------------------------------------------------------------------
  // Reports — on demand by date. No scheduler, no status tracking (F3).
  // -------------------------------------------------------------------------

  r.get('/reports', (_req, res) => {
    res.json(
      AUDIENCES.map((a) => ({
        audience: a,
        ...(a in LEAD_REPORTS
          ? LEAD_REPORTS[a as keyof typeof LEAD_REPORTS]
          : BOOKING_REPORTS[a as keyof typeof BOOKING_REPORTS]),
      })),
    );
  });

  r.get('/reports/:audience', (req, res) => {
    const { audience } = req.params;
    if (!isAudience(audience)) return res.status(404).json({ error: `unknown report: ${audience}` });
    const date = isIsoDate(req.query['date']) ? req.query['date'] : today();
    res.json(runReport(db, audience, date));
  });

  // -------------------------------------------------------------------------
  // Calls — what the AI said and what came of it. The stored transcript
  // verbatim; no LLM renders any of it (F4, B3).
  // -------------------------------------------------------------------------

  r.get('/calls', (req, res) => {
    const date = isIsoDate(req.query['date']) ? req.query['date'] : today();
    const span = Math.min(Math.max(Math.trunc(Number(req.query['days']) || 1), 1), 45);
    const from = addDays(date, -(span - 1));
    res.json({
      date,
      from,
      rows: db
        .prepare(
          `SELECT s.id, s.state, s.started_at, s.ended_at,
                  json_extract(s.data, '$.callerNumber')     AS caller_number,
                  json_extract(s.data, '$.customerName')     AS customer_name,
                  json_extract(s.data, '$.model')            AS model,
                  json_extract(s.data, '$.registration')     AS registration,
                  json_extract(s.data, '$.bookingReference') AS booking_reference,
                  json_extract(s.data, '$.leadReason')       AS lead_reason,
                  json_extract(s.data, '$.externalId')       AS external_id,
                  json_extract(s.data, '$.lastCallerWords')  AS last_caller_words,
                  (SELECT c.name FROM customers c
                   WHERE c.mobile_number = json_extract(s.data, '$.callerNumber')) AS known_name,
                  (SELECT COUNT(*) FROM transcripts t WHERE t.session_id = s.id) AS turns
           FROM sessions s
           WHERE substr(s.started_at, 1, 10) BETWEEN ? AND ?
           ORDER BY s.started_at DESC
           LIMIT 300`,
        )
        .all(from, date),
    });
  });

  r.get('/calls/:id', (req, res) => {
    const row = db
      .prepare(`SELECT id, state, data, started_at, ended_at FROM sessions WHERE id = ?`)
      .get(req.params.id) as
      | { id: string; state: string; data: string; started_at: string; ended_at: string | null }
      | undefined;
    if (!row) return res.status(404).json({ error: 'no such call' });
    // The portal is open, and a caller verifying a different number has a live
    // code sitting in the session. Returned, anyone with the link could read it.
    const data = JSON.parse(row.data) as Record<string, unknown>;
    delete data['otpCode'];
    res.json({ ...row, data, transcript: readTranscript(db, row.id) });
  });

  // -------------------------------------------------------------------------
  // Knowledge bank (D10). Editable, because a dealer FAQ nobody can edit is
  // not a product — and the call matches these rows, not a list in the code.
  // -------------------------------------------------------------------------

  r.get('/kb', (_req, res) => res.json(new TableKnowledgeBank(db).entries()));

  r.put('/kb/:key', (req, res) => {
    try {
      upsertEntry(db, String(req.params.key), String(req.body?.answer ?? ''));
      res.json({ ok: true, entries: new TableKnowledgeBank(db).entries() });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.delete('/kb/:key', (req, res) => {
    if (!deleteEntry(db, String(req.params.key))) {
      return res.status(404).json({ error: 'no such entry' });
    }
    res.json({ ok: true, entries: new TableKnowledgeBank(db).entries() });
  });

  // -------------------------------------------------------------------------

  r.get('/summary', (_req, res) => {
    const centre = db
      .prepare(`SELECT id, name, landline, opens_at, closes_at FROM centres WHERE id = ?`)
      .get(CENTRE_ID);
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    res.json({
      today: today(),
      centre,
      counts: {
        customers: n(`SELECT COUNT(*) n FROM customers`),
        vehicles: n(`SELECT COUNT(*) n FROM vehicles`),
        openBookings: n(`SELECT COUNT(*) n FROM bookings WHERE status = 'open'`),
        leads: n(`SELECT COUNT(*) n FROM leads`),
      },
    });
  });

  return r;
}
