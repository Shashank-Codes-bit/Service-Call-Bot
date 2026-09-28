import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { today, type IsoDate } from '../shared/dates.ts';
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
  DuplicateBookingError,
  openBookingForRegistration,
  SlotFullError,
} from '../shared/bookings.ts';
import { AUDIENCES, isAudience, LEAD_REPORTS, BOOKING_REPORTS, runReport } from './reports.ts';
import { requireAdmin } from '../auth.ts';
import { deleteEntry, TableKnowledgeBank, upsertEntry } from '../kb/index.ts';
import { readTranscript } from '../call/session.ts';

const isPool = (v: unknown): v is Pool => POOLS.includes(v as Pool);
const isDropSlot = (v: unknown): v is DropSlot => DROP_SLOTS.includes(v as DropSlot);
const isIsoDate = (v: unknown): v is IsoDate => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

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
  r.put('/capacity/master', requireAdmin, (req, res) => {
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

  r.post('/capacity/regenerate', requireAdmin, (_req, res) => {
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

  r.post('/bookings', requireAdmin, (req, res) => {
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

  r.patch('/bookings/:reference', requireAdmin, (req, res) => {
    const status = req.body?.status;
    if (status !== 'completed' && status !== 'cancelled') {
      return res.status(400).json({ error: 'status must be completed or cancelled' });
    }
    // String(): with a guard in front, Express widens params the way the /kb routes show.
    const reference = String(req.params.reference);
    const outcome = closeBooking(db, reference, status);
    if (outcome === 'not_found') return res.status(404).json({ error: 'no such booking' });
    if (outcome === 'not_open') {
      return res.status(409).json({ error: 'booking is already closed', kind: 'not_open' });
    }
    res.json({ ok: true, reference, status });
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
    res.json({
      date,
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
                  (SELECT COUNT(*) FROM transcripts t WHERE t.session_id = s.id) AS turns
           FROM sessions s
           WHERE substr(s.started_at, 1, 10) = ?
           ORDER BY s.started_at DESC`,
        )
        .all(date),
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

  r.put('/kb/:key', requireAdmin, (req, res) => {
    try {
      upsertEntry(db, String(req.params.key), String(req.body?.answer ?? ''));
      res.json({ ok: true, entries: new TableKnowledgeBank(db).entries() });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.delete('/kb/:key', requireAdmin, (req, res) => {
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
