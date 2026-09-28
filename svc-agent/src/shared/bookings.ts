import type { Database } from 'better-sqlite3';
import { addDays, timestamp, today, type IsoDate } from './dates.ts';
import type { BookingSource, DropSlot, Pool } from './types.ts';

export class SlotFullError extends Error {
  constructor(
    readonly date: IsoDate,
    readonly pool: Pool,
    readonly dropSlot: DropSlot,
  ) {
    super(`no capacity for ${pool} on ${date} ${dropSlot}`);
    this.name = 'SlotFullError';
  }
}

export class DuplicateBookingError extends Error {
  constructor(readonly reference: string) {
    super(`vehicle already has an open booking (${reference})`);
    this.name = 'DuplicateBookingError';
  }
}

export type NewBooking = {
  vehicleId: number;
  centreId: number;
  /** The pool, not the CRM's service type — a complaint moves it (D8). */
  pool: Pool;
  bookingDate: IsoDate;
  dropSlot: DropSlot;
  /** One field. Complaint and special request on consecutive lines (D8). */
  complaintNote?: string | null;
  source: BookingSource;
  now?: Date;
};

export type CreatedBooking = {
  id: number;
  reference: string;
  bookingDate: IsoDate;
  dropSlot: DropSlot;
  expectedPickup: IsoDate;
};

/**
 * The **only** path that creates a booking — dealer app and call app both.
 * Two implementations of this is how overbooking gets back in.
 *
 * One transaction, and any throw rolls the slot back:
 *
 * 1. Re-check for an open booking. E4 checks at intent; this closes the race
 *    where another channel books the same vehicle mid-conversation (D13).
 * 2. Take the slot with a conditional UPDATE, asserting `changes === 1`. Never
 *    read-then-increment (D4); a table `CHECK` backs it up.
 * 3. Draw the reference atomically, then insert.
 *
 * Deliberately not enforced here: D5's tomorrow..+30 window. That governs what
 * the agent may offer, not what the database may hold — the dealer's own
 * channel legitimately books same-day.
 */
export function createBooking(db: Database, b: NewBooking): CreatedBooking {
  const now = b.now ?? new Date();
  const pickup = expectedPickup(b.bookingDate, b.pool, b.dropSlot);

  const findOpen = db.prepare(
    `SELECT booking_reference FROM bookings WHERE vehicle_id = ? AND status = 'open'`,
  );
  const takeSlot = db.prepare(
    `UPDATE slot_capacity SET booked_slots = booked_slots + 1
     WHERE centre_id = ? AND date = ? AND service_type = ? AND drop_slot = ?
       AND booked_slots < total_slots`,
  );
  const insert = db.prepare(
    `INSERT INTO bookings
       (booking_reference, vehicle_id, centre_id, service_type, booking_date, drop_slot,
        expected_pickup, complaint_note, status, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  );

  return db.transaction((): CreatedBooking => {
    const clash = findOpen.get(b.vehicleId) as { booking_reference: string } | undefined;
    if (clash) throw new DuplicateBookingError(clash.booking_reference);

    const taken = takeSlot.run(b.centreId, b.bookingDate, b.pool, b.dropSlot);
    if (taken.changes !== 1) throw new SlotFullError(b.bookingDate, b.pool, b.dropSlot);

    const reference = nextBookingReference(db, b.centreId, today(now));
    const info = insert.run(
      reference,
      b.vehicleId,
      b.centreId,
      b.pool,
      b.bookingDate,
      b.dropSlot,
      pickup,
      b.complaintNote ?? null,
      b.source,
      timestamp(now),
    );

    return {
      id: Number(info.lastInsertRowid),
      reference,
      bookingDate: b.bookingDate,
      dropSlot: b.dropSlot,
      expectedPickup: pickup,
    };
  })();
}

export type CloseOutcome = 'closed' | 'not_found' | 'not_open';

/**
 * Reception closes a booking. Until this existed nothing could, so D13 locked
 * a vehicle out for good after its first booking, and the Reception report
 * counted unclosed bookings nobody had any way to close.
 *
 * `cancelled` gives the slot back; `completed` does not — the car came in and
 * the bay was used. Only an open booking closes, so a double click cannot
 * release the same slot twice.
 */
export function closeBooking(
  db: Database,
  reference: string,
  status: 'completed' | 'cancelled',
): CloseOutcome {
  return db.transaction((): CloseOutcome => {
    const b = db
      .prepare(
        `SELECT id, centre_id, booking_date, service_type, drop_slot FROM bookings
         WHERE booking_reference = ?`,
      )
      .get(reference) as
      | { id: number; centre_id: number; booking_date: IsoDate; service_type: Pool; drop_slot: DropSlot }
      | undefined;
    if (!b) return 'not_found';

    const flipped = db
      .prepare(`UPDATE bookings SET status = ? WHERE id = ? AND status = 'open'`)
      .run(status, b.id);
    if (flipped.changes !== 1) return 'not_open';

    if (status === 'cancelled') {
      db.prepare(
        `UPDATE slot_capacity SET booked_slots = booked_slots - 1
         WHERE centre_id = ? AND date = ? AND service_type = ? AND drop_slot = ?
           AND booked_slots > 0`,
      ).run(b.centre_id, b.booking_date, b.service_type, b.drop_slot);
    }
    return 'closed';
  })();
}

/** E4's duplicate check. An open booking is open — no date condition (D13). */
export function openBookingForRegistration(db: Database, registration: string) {
  return db
    .prepare(
      `SELECT b.id, b.booking_reference, b.booking_date, b.drop_slot, b.expected_pickup
       FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
       WHERE v.registration_number = ? AND b.status = 'open'`,
    )
    .get(registration) as
    | {
        id: number;
        booking_reference: string;
        booking_date: IsoDate;
        drop_slot: DropSlot;
        expected_pickup: IsoDate;
      }
    | undefined;
}

/**
 * Reception's working document: every booking arriving on a given day (F3).
 * Cancelled and completed are excluded — nobody is turning up.
 *
 * The only implementation. The tab and the report once ran separate queries,
 * one filtering `status` and the other `centre_id`, and silently disagreed.
 */
export function arrivals(db: Database, centreId: number, date: IsoDate) {
  return db
    .prepare(
      `SELECT b.booking_reference, b.booking_date, b.drop_slot, b.expected_pickup,
              b.service_type, b.complaint_note, b.status, b.source,
              c.name AS customer_name, c.mobile_number,
              v.model, v.registration_number
       FROM bookings b
       JOIN vehicles v ON v.id = b.vehicle_id
       JOIN customers c ON c.id = v.customer_id
       WHERE b.centre_id = ? AND b.booking_date = ? AND b.status = 'open'
       ORDER BY b.drop_slot, b.booking_reference`,
    )
    .all(centreId, date);
}

// ---------------------------------------------------------------------------

/**
 * EDD — when the customer collects. Our computed output, never a CRM field (D7).
 *
 * | pool      | drop slot | delivery          |
 * |-----------|-----------|-------------------|
 * | minor     | either    | same day, evening |
 * | major     | morning   | same day, evening |
 * | major     | afternoon | next day          |
 * | complaint | either    | next day          |
 *
 * Always phrased as an estimate: no dealer will underwrite a hard commitment
 * made by a machine, and a missed promise gets blamed on the AI. Duration is
 * never stated (D15) — it had no data source and contradicted this estimate.
 */
export function expectedPickup(
  bookingDate: IsoDate,
  pool: Pool,
  dropSlot: DropSlot,
): IsoDate {
  return isSameDay(pool, dropSlot) ? bookingDate : addDays(bookingDate, 1);
}

/** True when the vehicle goes back the same evening. */
export function isSameDay(pool: Pool, dropSlot: DropSlot): boolean {
  if (pool === 'complaint') return false; // longer job, next day either way
  if (pool === 'minor') return true;
  return dropSlot === 'morning'; // major: morning same day, afternoon next
}

/**
 * D7's same-day nudge: where a booking lands on next-day delivery, the agent
 * proactively mentions that same-day is worth asking the centre about. We never
 * invent a same-day slot — we cannot see the workshop's real workload.
 *
 * Lives here so the state machine reads the rule rather than restating it.
 */
export function shouldOfferSameDayNudge(pool: Pool, dropSlot: DropSlot): boolean {
  return !isSameDay(pool, dropSlot);
}

/**
 * `YYMMDD-NNNNN` — `createdOn` is the call's date, not the date being booked,
 * then a per-centre sequence from 00000. Digits only, so it survives being
 * read down a workshop phone line without the 0/O and 1/I confusions.
 *
 * Enumerable by design, which is safe only because a reference alone never
 * retrieves a booking — any lookup needs reference + the registered mobile.
 *
 * Read with UPDATE ... RETURNING, never COUNT(*), which would hand the same
 * sequence to two simultaneous bookings.
 */
export function nextBookingReference(
  db: Database,
  centreId: number,
  createdOn: IsoDate,
): string {
  // Seeded at -1 so the first increment returns 0.
  db.prepare(
    `INSERT INTO booking_counter (centre_id, date, last_seq) VALUES (?, ?, -1)
     ON CONFLICT (centre_id, date) DO NOTHING`,
  ).run(centreId, createdOn);

  const row = db
    .prepare(
      `UPDATE booking_counter SET last_seq = last_seq + 1
       WHERE centre_id = ? AND date = ? RETURNING last_seq`,
    )
    .get(centreId, createdOn) as { last_seq: number } | undefined;

  if (!row) throw new Error(`booking counter missing for centre ${centreId} on ${createdOn}`);

  return `${createdOn.slice(2).replace(/-/g, '')}-${String(row.last_seq).padStart(5, '0')}`;
}
