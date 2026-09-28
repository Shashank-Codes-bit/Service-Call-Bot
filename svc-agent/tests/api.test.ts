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
import { createSession } from '../src/call/session.ts';
import { addDays, today } from '../src/shared/dates.ts';
import { config } from '../src/config.ts';

/**
 * The HTTP surface, over a real seeded database.
 *
 * This layer had no coverage at all until now, and it is exactly what the bot
 * will call next — so the refusals matter as much as the happy paths. A caller
 * that cannot tell a bad request from a server fault cannot recover from
 * either.
 *
 * Seeded at the real "now" so the date-defaulting endpoints line up.
 */
const NOW = new Date();
const TODAY = today(NOW);

/**
 * Writes are guarded now (reads are not — the portal link is shareable), so
 * every mutating call here carries the password. The guard itself is tested in
 * http.test.ts; these tests are about what the endpoints do once past it.
 */
const ADMIN = config.adminPassword;

let scratch: string;
let db: Database;
let app: express.Express;

const vehicleId = (registration: string) =>
  (db.prepare(`SELECT id FROM vehicles WHERE registration_number = ?`).get(registration) as {
    id: number;
  }).id;

const freeSlot = (date: string, pool: string, dropSlot: string) =>
  (
    db
      .prepare(
        `SELECT total_slots - booked_slots AS free FROM slot_capacity
         WHERE centre_id = 1 AND date = ? AND service_type = ? AND drop_slot = ?`,
      )
      .get(date, pool, dropSlot) as { free: number }
  ).free;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'svc-api-'));
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

describe('the /crm/* lookups are gone', () => {
  // Three unauthenticated endpoints nothing called, one of which took a
  // mobile number and returned the customer. Deleted rather than guarded:
  // C1's swappable boundary is the `Crm` interface, which the call app
  // actually uses, not a second seam over HTTP.
  it.each(['/api/crm/customer?mobile=9810022002', '/api/crm/vehicle/HR26AB4471', '/api/crm/service-due/1'])(
    '%s is no longer served',
    async (path) => {
      await request(app).get(path).expect(404);
    },
  );
});

describe('capacity master', () => {
  it('returns the 7x6 grid', async () => {
    const res = await request(app).get('/api/capacity/master').expect(200);
    expect(Object.keys(res.body)).toHaveLength(7);
    expect(res.body['1'].minor.morning).toBe(6);
  });

  it('SAVING APPLIES — the live window changes without a second call', async () => {
    // The bug: saving used to write the master and leave the window on the old
    // figure until a separate regenerate. One click must be enough.
    const tomorrow = addDays(TODAY, 1);
    const weekday = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 1).getDay();
    const before = freeSlot(tomorrow, 'major', 'morning');

    const master = (await request(app).get('/api/capacity/master')).body;
    master[String(weekday)].major.morning = before + 5;

    await request(app).put('/api/capacity/master').set('x-admin-password', ADMIN).send(master).expect(200);

    expect(freeSlot(tomorrow, 'major', 'morning')).toBe(before + 5);
  });

  it('reports what a cut could not shrink, from the same call that caused it', async () => {
    const tomorrow = addDays(TODAY, 1);
    const weekday = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 1).getDay();

    // Sell two slots, then try to cut the weekday to zero.
    for (const reg of ['HR26AB4471', 'MH12PQ3344']) {
      await request(app)
        .post('/api/bookings').set('x-admin-password', ADMIN)
        .send({ vehicleId: vehicleId(reg), pool: 'major', bookingDate: tomorrow, dropSlot: 'morning' })
        .expect(201);
    }

    const master = (await request(app).get('/api/capacity/master')).body;
    master[String(weekday)].major.morning = 0;
    const res = await request(app).put('/api/capacity/master').set('x-admin-password', ADMIN).send(master).expect(200);

    const conflict = res.body.applied.conflicts.find(
      (c: { date: string; pool: string; dropSlot: string }) =>
        c.date === tomorrow && c.pool === 'major' && c.dropSlot === 'morning',
    );
    expect(conflict).toMatchObject({ requested: 0, heldAt: 2 });
    // Held at what is sold — the two bookings survive and the CHECK is intact.
    expect(freeSlot(tomorrow, 'major', 'morning')).toBe(0);
  });

  it('rejects a negative figure with 400 and writes nothing', async () => {
    const master = (await request(app).get('/api/capacity/master')).body;
    master['1'].minor.morning = -1;
    await request(app).put('/api/capacity/master').set('x-admin-password', ADMIN).send(master).expect(400);
    expect((await request(app).get('/api/capacity/master')).body['1'].minor.morning).toBe(6);
  });

  it('rejects a non-integer figure with 400', async () => {
    const master = (await request(app).get('/api/capacity/master')).body;
    master['1'].minor.morning = 2.5;
    await request(app).put('/api/capacity/master').set('x-admin-password', ADMIN).send(master).expect(400);
  });

  it('rejects a malformed body with 400 rather than a 500', async () => {
    await request(app).put('/api/capacity/master').set('x-admin-password', ADMIN).send({ nonsense: true }).expect(400);
  });
});

describe('POST /api/capacity/regenerate', () => {
  it('reports the window it rebuilt and is idempotent', async () => {
    const first = await request(app).post('/api/capacity/regenerate').set('x-admin-password', ADMIN).expect(200);
    expect(first.body).toMatchObject({ from: TODAY, to: addDays(TODAY, 30) });

    const second = await request(app).post('/api/capacity/regenerate').set('x-admin-password', ADMIN).expect(200);
    expect(second.body.created).toBe(0);
    expect(second.body.updated).toBe(0);
  });
});

describe('GET /api/capacity/window', () => {
  it('returns the shape the grid renders, with the seeded bends present', async () => {
    const res = await request(app).get('/api/capacity/window?days=6').expect(200);
    const byDate = Object.fromEntries(
      (res.body as { date: string }[]).map((d) => [d.date, d as never]),
    ) as Record<string, { pools: Record<string, Record<string, { free: number }>> }>;

    // +3 is gone entirely; +4 has only the afternoon (D6).
    for (const pool of ['minor', 'major', 'complaint']) {
      expect(byDate[addDays(TODAY, 3)]!.pools[pool]!['morning']!.free).toBe(0);
    }
    expect(byDate[addDays(TODAY, 4)]!.pools['minor']!['morning']!.free).toBe(0);
    expect(byDate[addDays(TODAY, 4)]!.pools['minor']!['afternoon']!.free).toBeGreaterThan(0);
  });

  it('falls back to 30 days for a nonsense days parameter', async () => {
    const res = await request(app).get('/api/capacity/window?days=abc').expect(200);
    expect(res.body).toHaveLength(31);
  });
});

describe('POST /api/bookings', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    vehicleId: vehicleId('HR26AB4471'),
    pool: 'major',
    bookingDate: addDays(TODAY, 7),
    dropSlot: 'morning',
    ...over,
  });

  it('creates a dealer booking and returns reference and EDD', async () => {
    const res = await request(app).post('/api/bookings').set('x-admin-password', ADMIN).send(body()).expect(201);
    expect(res.body.reference).toMatch(/^\d{6}-\d{5}$/);
    // major + morning = same day (D7)
    expect(res.body.expectedPickup).toBe(addDays(TODAY, 7));
  });

  it('books today — the dealer desk is not bound by the agent window', async () => {
    // D5 governs what the bot offers, not what the dealer may enter.
    await request(app).post('/api/bookings').set('x-admin-password', ADMIN).send(body({ bookingDate: TODAY })).expect(201);
  });

  it.each([
    ['vehicleId missing', { vehicleId: undefined }],
    ['vehicleId not an integer', { vehicleId: 'abc' }],
    ['pool invalid', { pool: 'huge' }],
    ['bookingDate malformed', { bookingDate: '14/09/2026' }],
    ['dropSlot invalid', { dropSlot: 'evening' }],
  ])('400s on %s', async (_label, over) => {
    await request(app).post('/api/bookings').set('x-admin-password', ADMIN).send(body(over)).expect(400);
  });

  it('404s on a vehicle that does not exist, rather than a 500', async () => {
    const res = await request(app).post('/api/bookings').set('x-admin-password', ADMIN).send(body({ vehicleId: 99999 })).expect(404);
    expect(res.body.kind).toBe('unknown_vehicle');
  });

  it('409s with slot_full when the slot has no room', async () => {
    const date = addDays(TODAY, 3); // the seeded "whole day gone" bend
    const res = await request(app)
      .post('/api/bookings').set('x-admin-password', ADMIN)
      .send(body({ bookingDate: date }))
      .expect(409);
    expect(res.body.kind).toBe('slot_full');
  });

  it('409s with duplicate and names the existing reference', async () => {
    const res = await request(app)
      .post('/api/bookings').set('x-admin-password', ADMIN)
      .send(body({ vehicleId: vehicleId('GJ01TU2255'), pool: 'minor' }))
      .expect(409);
    expect(res.body.kind).toBe('duplicate');
    expect(res.body.reference).toMatch(/^\d{6}-\d{5}$/);
  });

  it('leaves capacity untouched when it refuses', async () => {
    const date = addDays(TODAY, 7);
    const before = freeSlot(date, 'minor', 'morning');
    await request(app)
      .post('/api/bookings').set('x-admin-password', ADMIN)
      .send(body({ vehicleId: vehicleId('GJ01TU2255'), pool: 'minor', bookingDate: date }))
      .expect(409);
    await request(app).post('/api/bookings').set('x-admin-password', ADMIN).send(body({ vehicleId: 99999 })).expect(404);
    expect(freeSlot(date, 'minor', 'morning')).toBe(before);
  });
});

describe('PATCH /api/bookings/:reference', () => {
  const create = async () =>
    (
      await request(app)
        .post('/api/bookings')
        .set('x-admin-password', ADMIN)
        .send({ vehicleId: vehicleId('HR26AB4471'), pool: 'major', bookingDate: addDays(TODAY, 7), dropSlot: 'morning' })
        .expect(201)
    ).body.reference as string;

  const close = (ref: string, status: unknown, password: string | null = ADMIN) => {
    const r = request(app).patch(`/api/bookings/${ref}`);
    return (password ? r.set('x-admin-password', password) : r).send({ status });
  };

  it('cancels, gives the slot back, and takes it off the arrivals list', async () => {
    const date = addDays(TODAY, 7);
    const before = freeSlot(date, 'major', 'morning');
    const ref = await create();
    expect(freeSlot(date, 'major', 'morning')).toBe(before - 1);

    await close(ref, 'cancelled').expect(200);
    expect(freeSlot(date, 'major', 'morning')).toBe(before);

    const arr = await request(app).get(`/api/bookings/arrivals?date=${date}`).expect(200);
    expect(arr.body.rows.map((r: { booking_reference: string }) => r.booking_reference)).not.toContain(ref);
  });

  it('is a write, so it needs the password', async () => {
    const ref = await create();
    await close(ref, 'completed', null).expect(401);
  });

  it('answers 400 for a bad status, 404 for an unknown booking, 409 for a closed one', async () => {
    const ref = await create();
    await close(ref, 'open').expect(400);
    await close('000000-00000', 'completed').expect(404);
    await close(ref, 'completed').expect(200);
    const again = await close(ref, 'completed').expect(409);
    expect(again.body.kind).toBe('not_open');
  });
});

describe('GET /api/calls/:id', () => {
  it('never returns a live OTP code — the portal is open', async () => {
    const s = createSession(
      db,
      { centreId: 1, callerNumber: '9810011001', startedAt: NOW.toISOString(), pushback: 0, otpAttempts: 0, otpCode: '4821' },
      NOW,
    );
    const res = await request(app).get(`/api/calls/${s.id}`).expect(200);
    expect(res.body.data.callerNumber).toBe('9810011001');
    expect(res.body.data).not.toHaveProperty('otpCode');
    expect(JSON.stringify(res.body)).not.toContain('4821');
  });
});

describe('arrivals — one answer, not two', () => {
  it('the tab and the report agree', async () => {
    const date = addDays(TODAY, 5); // Meera's seeded booking
    const tab = await request(app).get(`/api/bookings/arrivals?date=${date}`).expect(200);
    const report = await request(app).get(`/api/reports/bookings-arrivals?date=${date}`).expect(200);
    expect(tab.body.rows).toHaveLength(1);
    expect(report.body.rows.map((r: { booking_reference: string }) => r.booking_reference)).toEqual(
      tab.body.rows.map((r: { booking_reference: string }) => r.booking_reference),
    );
  });

  it('they still agree once a booking is closed — the old divergence', async () => {
    // These used to differ: the tab ignored status, the report ignored centre.
    // Nobody is arriving for a completed booking, so both must drop it.
    const date = addDays(TODAY, 5);
    db.prepare(`UPDATE bookings SET status = 'completed'`).run();

    const tab = await request(app).get(`/api/bookings/arrivals?date=${date}`);
    const report = await request(app).get(`/api/reports/bookings-arrivals?date=${date}`);
    expect(tab.body.rows).toEqual([]);
    expect(report.body.rows).toEqual([]);
  });

  it('defaults to today when no date is given', async () => {
    const res = await request(app).get('/api/bookings/arrivals').expect(200);
    expect(res.body.date).toBe(TODAY);
  });
});

describe('GET /api/bookings/open/:registration', () => {
  it('finds the open booking', async () => {
    const res = await request(app).get('/api/bookings/open/GJ01TU2255').expect(200);
    expect(res.body.open).toBe(true);
    expect(res.body.booking.booking_reference).toMatch(/^\d{6}-\d{5}$/);
  });

  it('reports none for a free vehicle', async () => {
    const res = await request(app).get('/api/bookings/open/HR26AB4471').expect(200);
    expect(res.body).toEqual({ open: false, booking: null });
  });
});

describe('GET /api/reports', () => {
  it('lists all seven', async () => {
    const res = await request(app).get('/api/reports').expect(200);
    expect(res.body).toHaveLength(7);
  });

  it('returns each audience with its rows', async () => {
    for (const audience of [
      'customer-care',
      'retention',
      'service-manager',
      'crm-data',
      'reception',
      'bookings-arrivals',
      'bookings-activity',
    ]) {
      const res = await request(app).get(`/api/reports/${audience}?date=${TODAY}`).expect(200);
      expect(res.body.audience).toBe(audience);
      expect(Array.isArray(res.body.rows)).toBe(true);
    }
  });

  it('splits retention into its two call scripts', async () => {
    const res = await request(app).get(`/api/reports/retention?date=${TODAY}`).expect(200);
    expect(res.body.groups).toHaveLength(2);
    expect(res.body.groups[0].rows).toHaveLength(1); // chase — overdue
    expect(res.body.groups[1].rows).toHaveLength(1); // record fix — no due date
  });

  it('404s on an unknown audience', async () => {
    await request(app).get('/api/reports/marketing-genius').expect(404);
  });

  it('shows every seeded lead exactly once across the five lead reports', async () => {
    let total = 0;
    for (const a of ['customer-care', 'retention', 'service-manager', 'crm-data', 'reception']) {
      total += (await request(app).get(`/api/reports/${a}?date=${TODAY}`)).body.rows.length;
    }
    expect(total).toBe(
      (db.prepare(`SELECT COUNT(*) n FROM leads`).get() as { n: number }).n,
    );
  });
});

describe('GET /api/vehicles and /api/summary', () => {
  it('flags the vehicle that already has an open booking', async () => {
    const res = await request(app).get('/api/vehicles').expect(200);
    const tiago = res.body.find(
      (v: { registration_number: string }) => v.registration_number === 'GJ01TU2255',
    );
    const nexon = res.body.find(
      (v: { registration_number: string }) => v.registration_number === 'HR26AB4471',
    );
    expect(tiago.has_open_booking).toBe(1);
    expect(nexon.has_open_booking).toBe(0);
  });

  it('reports the centre and live counts', async () => {
    const res = await request(app).get('/api/summary').expect(200);
    expect(res.body.today).toBe(TODAY);
    expect(res.body.centre.name).toContain('Sector 44');
    expect(res.body.counts).toMatchObject({ customers: 11, vehicles: 13, openBookings: 1, leads: 10 });
  });

  it('counts move when a booking is made', async () => {
    await request(app)
      .post('/api/bookings').set('x-admin-password', ADMIN)
      .send({
        vehicleId: vehicleId('HR26AB4471'),
        pool: 'major',
        bookingDate: addDays(TODAY, 7),
        dropSlot: 'morning',
      })
      .expect(201);
    const res = await request(app).get('/api/summary').expect(200);
    expect(res.body.counts.openBookings).toBe(2);
  });
});
