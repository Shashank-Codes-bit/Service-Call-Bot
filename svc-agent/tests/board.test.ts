import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Database } from 'better-sqlite3';
import { open } from '../src/db/index.ts';
import { seed } from '../src/db/seed.ts';
import { api } from '../src/dealer/api.ts';
import { dayBookings, rescheduleBooking, SlotFullError } from '../src/shared/bookings.ts';
import { addDays, today } from '../src/shared/dates.ts';

/** The front desk: the day board, the pickers, rescheduling and arrivals. */

const NOW = new Date();
const TODAY = today(NOW);
let scratch: string;
let db: Database;
let app: express.Express;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'svc-board-'));
  seed({ now: NOW, dbPath: join(scratch, 'test.db') });
  db = open(join(scratch, 'test.db'));
  app = express();
  app.use(express.json());
  app.use('/api', api(db));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const cell = (date: string, pool: string, slot: string) =>
  db
    .prepare(
      `SELECT total_slots AS total, booked_slots AS used FROM slot_capacity
       WHERE centre_id = 1 AND date = ? AND service_type = ? AND drop_slot = ?`,
    )
    .get(date, pool, slot) as { total: number; used: number };

const vehicleId = (reg: string) =>
  (db.prepare(`SELECT id FROM vehicles WHERE registration_number = ?`).get(reg) as { id: number }).id;

describe('the seed is consistent', () => {
  it('backs every taken place with a booking, on every day', () => {
    const rows = db
      .prepare(
        `SELECT s.date, s.service_type, s.drop_slot, s.booked_slots,
                (SELECT COUNT(*) FROM bookings b WHERE b.booking_date = s.date AND b.service_type = s.service_type
                   AND b.drop_slot = s.drop_slot AND b.status = 'open' AND b.centre_id = 1) AS cards
         FROM slot_capacity s WHERE s.centre_id = 1`,
      )
      .all() as Array<{ booked_slots: number; cards: number }>;
    for (const r of rows) expect(r.cards).toBe(r.booked_slots);
  });
});

describe('GET /api/day', () => {
  it('lists today’s cars with their job and the places used', async () => {
    const res = await request(app).get('/api/day').expect(200);
    expect(res.body.date).toBe(TODAY);
    expect(res.body.bookings.length).toBe(9);
    const b = res.body.bookings[0];
    expect(b).toHaveProperty('registration_number');
    expect(b).toHaveProperty('service_number');
    expect(b).toHaveProperty('late');
    expect(res.body.places).toHaveLength(6);
  });

  it('shows the full day as full: every place a card', async () => {
    const d3 = addDays(TODAY, 3);
    const res = await request(app).get(`/api/day?date=${d3}`).expect(200);
    const used = res.body.places.reduce((s: number, p: { used: number }) => s + p.used, 0);
    expect(res.body.bookings).toHaveLength(used);
    expect(res.body.places.every((p: { used: number; total: number }) => p.used === p.total)).toBe(true);
  });

  it('flags a car more than half an hour past its drop time, until it arrives', () => {
    const ref = (db.prepare(`SELECT booking_reference r FROM bookings WHERE booking_date = ? AND drop_slot = 'morning' AND arrived_at IS NULL LIMIT 1`).get(TODAY) as { r: string }).r;
    const at = (hhmm: string) => {
      const d = new Date(NOW);
      const [h, m] = hhmm.split(':').map(Number) as [number, number];
      d.setHours(h, m, 0, 0);
      return d;
    };
    const late = (hhmm: string) => dayBookings(db, 1, TODAY, at(hhmm)).find((b) => b.reference === ref)!.late;
    expect(late('08:59')).toBe(false);
    expect(late('09:01')).toBe(true);
    expect(dayBookings(db, 1, TODAY, at('09:01')).find((b) => b.reference === ref)!.late_min).toBe(31);
    db.prepare(`UPDATE bookings SET arrived_at = ? WHERE booking_reference = ?`).run(`${TODAY}T09:05:00+05:30`, ref);
    expect(late('10:00')).toBe(false);
  });
});

describe('the pickers', () => {
  it('counts cars and free places per day for the strip', async () => {
    const res = await request(app).get('/api/days?days=14').expect(200);
    expect(res.body).toHaveLength(14);
    expect(res.body[0]).toEqual({ date: TODAY, cars: 9, free: expect.any(Number) });
    expect(res.body[3].free).toBe(0); // the fully booked day
  });

  it('finds by plate, phone, name or reference', async () => {
    const plate = await request(app).get('/api/search?q=hr26 ab').expect(200);
    expect(plate.body[0].registration_number).toBe('HR26AB4471');
    const phone = await request(app).get('/api/search?q=9810022002').expect(200);
    expect(phone.body).toHaveLength(2);
    const name = await request(app).get('/api/search?q=meera').expect(200);
    expect(name.body[0].open_reference).toMatch(/^\d{6}-\d{5}$/);
    const ref = await request(app).get(`/api/search?q=${name.body[0].open_reference}`).expect(200);
    expect(ref.body[0].name).toBe('Meera Joshi');
    expect((await request(app).get('/api/search?q=x').expect(200)).body).toEqual([]);
  });

  it('says what blocks a car, in the desk’s words', async () => {
    const blockerOf = async (mobile: string) => {
      const c = (await request(app).get(`/api/search?q=${mobile}`)).body[0];
      return (await request(app).get(`/api/customers/${c.customer_id}`).expect(200)).body.cars[0].blocker;
    };
    expect(await blockerOf('9810011001')).toBeNull();
    expect(await blockerOf('9810066006')).toMatch(/^Already booked for/);
    expect(await blockerOf('9810077007')).toMatch(/no due date/);
    expect(await blockerOf('9810088008')).toMatch(/lapsed/);
    expect(await blockerOf('9810099009')).toMatch(/Service type missing/);
  });

  it('gives free places per pool and drop', async () => {
    const res = await request(app).get('/api/free?days=14').expect(200);
    expect(res.body).toHaveLength(14);
    expect(res.body[2].pools.minor).toEqual({ morning: 0, afternoon: 0 });
    expect(res.body[4].pools.minor.morning).toBe(0);
    expect(res.body[4].pools.minor.afternoon).toBeGreaterThan(0);
  });
});

describe('rescheduling', () => {
  const book = async () =>
    (
      await request(app)
        .post('/api/bookings')
        .send({ vehicleId: vehicleId('HR26AB4471'), pool: 'major', bookingDate: addDays(TODAY, 7), dropSlot: 'morning' })
        .expect(201)
    ).body.reference as string;

  it('moves the booking, keeps its reference, and moves the count both ways', async () => {
    const ref = await book();
    const from = cell(addDays(TODAY, 7), 'major', 'morning');
    const to = cell(addDays(TODAY, 9), 'major', 'afternoon');
    const res = await request(app)
      .post(`/api/bookings/${ref}/reschedule`)
      .send({ bookingDate: addDays(TODAY, 9), dropSlot: 'afternoon' })
      .expect(200);
    expect(res.body).toMatchObject({ reference: ref, bookingDate: addDays(TODAY, 9), dropSlot: 'afternoon', expectedPickup: addDays(TODAY, 10) });
    expect(cell(addDays(TODAY, 7), 'major', 'morning').used).toBe(from.used - 1);
    expect(cell(addDays(TODAY, 9), 'major', 'afternoon').used).toBe(to.used + 1);
  });

  it('refuses a full target and leaves everything where it was', async () => {
    const ref = await book();
    const full = addDays(TODAY, 3);
    const before = cell(addDays(TODAY, 7), 'major', 'morning');
    expect(() => rescheduleBooking(db, ref, { bookingDate: full, dropSlot: 'morning' })).toThrow(SlotFullError);
    const res = await request(app).post(`/api/bookings/${ref}/reschedule`).send({ bookingDate: full, dropSlot: 'morning' }).expect(409);
    expect(res.body.kind).toBe('slot_full');
    expect(cell(addDays(TODAY, 7), 'major', 'morning')).toEqual(before);
    expect(db.prepare(`SELECT booking_date d FROM bookings WHERE booking_reference = ?`).get(ref)).toEqual({ d: addDays(TODAY, 7) });
  });

  it('refuses a closed booking, a bad date and a day that has passed', async () => {
    const ref = await book();
    await request(app).post(`/api/bookings/${ref}/reschedule`).send({ bookingDate: 'soon', dropSlot: 'morning' }).expect(400);
    await request(app).post(`/api/bookings/${ref}/reschedule`).send({ bookingDate: addDays(TODAY, -1), dropSlot: 'morning' }).expect(400);
    await request(app).patch(`/api/bookings/${ref}`).send({ status: 'cancelled' }).expect(200);
    await request(app).post(`/api/bookings/${ref}/reschedule`).send({ bookingDate: addDays(TODAY, 9), dropSlot: 'morning' }).expect(409);
    await request(app).post(`/api/bookings/000000-00000/reschedule`).send({ bookingDate: addDays(TODAY, 9), dropSlot: 'morning' }).expect(404);
  });
});

describe('arrivals', () => {
  it('ticks a car in and can undo it', async () => {
    const ref = (await request(app).get('/api/day')).body.bookings.find((b: { arrived_at: string | null }) => !b.arrived_at).reference;
    await request(app).patch(`/api/bookings/${ref}`).send({ arrived: true }).expect(200);
    const after = (await request(app).get('/api/day')).body.bookings.find((b: { reference: string }) => b.reference === ref);
    expect(after.arrived_at).toMatch(new RegExp(`^${TODAY}`));
    expect(after.late).toBe(false);
    await request(app).patch(`/api/bookings/${ref}`).send({ arrived: false }).expect(200);
    await request(app).patch(`/api/bookings/000000-00000`).send({ arrived: true }).expect(404);
  });
});
