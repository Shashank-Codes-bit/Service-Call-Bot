import type { Database } from 'better-sqlite3';
import { addDays, parseIsoDate, timestamp, type IsoDate } from '../shared/dates.ts';
import { expectedPickup, nextBookingReference } from '../shared/bookings.ts';
import type { DropSlot, Pool } from '../shared/types.ts';

/**
 * The front desk's sample: a fleet of everyday customers whose bookings fill
 * the board, so a new centre opens on a working day rather than an empty one.
 *
 * Kept apart from the scenario customers in seed.ts, each of whom exists to
 * exercise one branch of the agent: none of them is given a booking here, so
 * the conversations they script stay exactly as they were.
 *
 * Every place this marks as taken is a real booking row. A full day on the
 * board is then a column of cards, never a count with nothing behind it.
 * Deterministic: the same seed day always gives the same fleet.
 */

const FIRST = [
  'Aakash', 'Bhavna', 'Chetan', 'Divya', 'Esha', 'Gaurav', 'Harpreet', 'Ishaan', 'Jaya', 'Kunal',
  'Lata', 'Manish', 'Nikhil', 'Pooja', 'Rahul', 'Sakshi', 'Tarun', 'Usha', 'Varun', 'Yamini',
  'Abhishek', 'Kavya', 'Siddharth', 'Ritika', 'Mohit', 'Ananya', 'Vivek', 'Shreya', 'Naveen', 'Tanvi',
];
const LAST = [
  'Malhotra', 'Bansal', 'Chopra', 'Saxena', 'Khanna', 'Agarwal', 'Bhatia', 'Sethi', 'Rawat', 'Pandey',
  'Mishra', 'Kulkarni', 'Reddy', 'Pillai', 'Thakur', 'Ahuja', 'Dutta', 'Grover', 'Mehta', 'Arora',
];
const MODELS = [
  'Brezza', 'Seltos', 'City', 'Dzire', 'WagonR', 'Innova', 'Harrier', 'Punch', 'Thar', 'Verna',
  'XUV700', 'Alto', 'Kiger', 'Sonet', 'Ciaz', 'Scorpio', 'Hector', 'Glanza', 'Magnite', 'Amaze',
];
const STATES = ['HR', 'DL', 'UP', 'RJ', 'PB', 'MH', 'KA', 'GJ', 'MP', 'CH'];
const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';

const FAULT_NOTES = [
  'Grinding noise when braking',
  'AC not cooling enough',
  'Engine light came on yesterday',
  'Steering pulls to the left',
  'Rattle from the rear on bumps',
  'Clutch feels heavy',
];
const OTHER_NOTES = ['Wash and interior clean too', 'Wipers smear the glass', 'Check the battery, slow start'];

export type SampleBooking = {
  reference: string;
  vehicleId: number;
  mobile: string;
  name: string;
  model: string;
  registration: string;
  date: IsoDate;
  slot: DropSlot;
  pool: Pool;
  source: 'ai' | 'dealer';
};

/** A time on a calendar day, as a Date in the centre's clock. */
export function at(date: IsoDate, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const d = parseIsoDate(date);
  d.setHours(h, m, 0, 0);
  return d;
}

export class SampleFleet {
  private n = 0;
  readonly made: SampleBooking[] = [];

  constructor(
    private readonly db: Database,
    private readonly today: IsoDate,
    private readonly now: Date,
  ) {}

  /** One more customer with one car. */
  private customer(pool: Pool) {
    const i = this.n++;
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    const mobile = `98201${String(10000 + i * 37).slice(-5)}`;
    const model = MODELS[(i * 3) % MODELS.length]!;
    const registration =
      `${STATES[i % STATES.length]}${String(10 + ((i * 13) % 80)).padStart(2, '0')}` +
      `${LETTERS[(i * 5) % LETTERS.length]}${LETTERS[(i * 11) % LETTERS.length]}` +
      `${String(1000 + ((i * 7919) % 9000)).padStart(4, '0')}`;
    const serviceNumber = 1 + (i % 6);
    const serviceType = pool === 'complaint' ? (i % 2 ? 'major' : 'minor') : pool;

    const customerId = Number(
      this.db
        .prepare(`INSERT INTO customers (mobile_number, name, created_at) VALUES (?, ?, ?)`)
        .run(mobile, name, timestamp(this.now)).lastInsertRowid,
    );
    const vehicleId = Number(
      this.db
        .prepare(
          `INSERT INTO vehicles (customer_id, registration_number, model, purchase_date)
           VALUES (?, ?, ?, ?)`,
        )
        .run(customerId, registration, model, addDays(this.today, -(300 + i * 41))).lastInsertRowid,
    );
    this.db
      .prepare(
        `INSERT INTO service_due (vehicle_id, service_number, service_type, is_free, due_date)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(vehicleId, serviceNumber, serviceType, serviceNumber <= 3 ? 1 : 0, addDays(this.today, -(i % 20)));
    return { i, name, mobile, model, registration, vehicleId };
  }

  /**
   * A booking through the same guarded increment the app uses, so the seed
   * can never mark more places taken than the day has.
   */
  book(
    date: IsoDate,
    pool: Pool,
    slot: DropSlot,
    opts: { madeDaysAgo?: number; note?: string | null; source?: 'ai' | 'dealer' } = {},
  ): SampleBooking {
    const c = this.customer(pool);
    const taken = this.db
      .prepare(
        `UPDATE slot_capacity SET booked_slots = booked_slots + 1
         WHERE centre_id = 1 AND date = ? AND service_type = ? AND drop_slot = ?
           AND booked_slots < total_slots`,
      )
      .run(date, pool, slot);
    if (taken.changes !== 1) throw new Error(`seed: no ${pool} ${slot} place left on ${date}`);

    // Made some days before, in working hours, and never in the future.
    const madeOn = addDays(this.today, -(opts.madeDaysAgo ?? 1 + (c.i % 4)));
    let made = at(madeOn, `${10 + (c.i % 8)}:${String((c.i * 17) % 60).padStart(2, '0')}`);
    if (made > this.now) made = this.now;
    const reference = nextBookingReference(this.db, 1, madeOn > this.today ? this.today : madeOn);
    const source = opts.source ?? (c.i % 5 < 3 ? 'ai' : 'dealer');
    const note =
      opts.note !== undefined
        ? opts.note
        : pool === 'complaint'
          ? FAULT_NOTES[c.i % FAULT_NOTES.length]!
          : c.i % 4 === 0
            ? OTHER_NOTES[c.i % OTHER_NOTES.length]!
            : null;

    this.db
      .prepare(
        `INSERT INTO bookings
           (booking_reference, vehicle_id, centre_id, service_type, booking_date, drop_slot,
            expected_pickup, complaint_note, status, source, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(reference, c.vehicleId, pool, date, slot, expectedPickup(date, pool, slot), note, source, timestamp(made));

    const b: SampleBooking = {
      reference,
      vehicleId: c.vehicleId,
      mobile: c.mobile,
      name: c.name,
      model: c.model,
      registration: c.registration,
      date,
      slot,
      pool,
      source,
    };
    this.made.push(b);
    return b;
  }

  /** Every remaining place in a pool and slot, as bookings. */
  fill(date: IsoDate, pool: Pool, slot: DropSlot): void {
    const { free } = this.db
      .prepare(
        `SELECT total_slots - booked_slots AS free FROM slot_capacity
         WHERE centre_id = 1 AND date = ? AND service_type = ? AND drop_slot = ?`,
      )
      .get(date, pool, slot) as { free: number };
    for (let k = 0; k < free; k++) this.book(date, pool, slot);
  }

  /** Reception's tick, only if that time has already come. */
  arrived(reference: string, hhmm: string): void {
    const when = at(this.today, hhmm);
    if (when > this.now) return;
    this.db
      .prepare(`UPDATE bookings SET arrived_at = ? WHERE booking_reference = ?`)
      .run(timestamp(when), reference);
  }
}
