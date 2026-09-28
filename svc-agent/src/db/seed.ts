/**
 * Rebuilds service.db from scratch. DESTRUCTIVE — `npm run db:rebuild`, and
 * stop the server first.
 *
 * Every row exists to exercise a branch; the data is hand-written, and where
 * a row's purpose isn't obvious it carries a comment (I4-6).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, resetSchema, DB_PATH } from './index.ts';
import { addDays, today, timestamp, weekdayOf, type IsoDate } from '../shared/dates.ts';
import { nextBookingReference } from '../shared/bookings.ts';

const BOOKING_WINDOW_DAYS = 30; // D5: latest bookable day is 30 days ahead.

export type SeedOptions = {
  /** Injectable so tests can seed at any weekday, and at 00:30 local (I4-7). */
  now?: Date;
  dbPath?: string;
};

export type SeedSummary = {
  today: IsoDate;
  weekday: number;
  counts: Record<string, number>;
  bends: Array<{ date: IsoDate; offset: number; note: string }>;
};

export function seed({ now = new Date(), dbPath = DB_PATH }: SeedOptions = {}): SeedSummary {
const db = open(dbPath);
resetSchema(db);

const TODAY = today(now);
const NOW = timestamp(now);

// ---------------------------------------------------------------------------
// Centres — three seeded, only centre 1 is used (F6).
// ---------------------------------------------------------------------------

const centres = [
  { id: 1, name: 'Voltas Motors Service — Sector 44', landline: '01244567890' },
  { id: 2, name: 'Voltas Motors Service — Sector 18', landline: '01244567891' },
  { id: 3, name: 'Voltas Motors Service — Golf Course Road', landline: '01244567892' },
];

const insertCentre = db.prepare(
  `INSERT INTO centres (id, name, landline, opens_at, closes_at) VALUES (?, ?, ?, ?, ?)`,
);
for (const c of centres) insertCentre.run(c.id, c.name, c.landline, '09:00', '19:00');

// ---------------------------------------------------------------------------
// Capacity master — 7 weekdays x 3 pools x 2 slots = 42 rows (D4).
// Numbers are NET of expected walk-in load: the workshop has more bays than
// this, but walk-ins take the difference.
// ---------------------------------------------------------------------------

/** [minor, major, complaint] slots per drop slot, by weekday. */
const masterByWeekday: Record<number, { minor: number; major: number; complaint: number }> = {
  0: { minor: 8, major: 3, complaint: 2 }, // Sunday — busy for minor, thin on bays
  1: { minor: 6, major: 4, complaint: 3 },
  2: { minor: 6, major: 4, complaint: 3 },
  3: { minor: 6, major: 4, complaint: 3 },
  4: { minor: 6, major: 4, complaint: 3 },
  5: { minor: 6, major: 4, complaint: 3 },
  6: { minor: 8, major: 3, complaint: 2 }, // Saturday — same shape as Sunday
};

const POOLS = ['minor', 'major', 'complaint'] as const;
const SLOTS = ['morning', 'afternoon'] as const;

const insertMaster = db.prepare(
  `INSERT INTO capacity_master (weekday, service_type, drop_slot, total_slots) VALUES (?, ?, ?, ?)`,
);
for (let weekday = 0; weekday <= 6; weekday++) {
  const row = masterByWeekday[weekday]!;
  for (const pool of POOLS) {
    for (const slot of SLOTS) insertMaster.run(weekday, pool, slot, row[pool]);
  }
}

// ---------------------------------------------------------------------------
// Customers, vehicles, and the CRM's next-due-service.
//
// 9899999999 is deliberately absent — it tests the not-found lead.
// ---------------------------------------------------------------------------

type SeedVehicle = {
  registration: string;
  model: string;
  purchasedDaysAgo: number;
  serviceNumber: number;
  /** null blocks booking outright (D3). */
  serviceType: 'minor' | 'major' | null;
  isFree: boolean;
  /** Days before today. null = no due date on record (D2). */
  dueDaysAgo: number | null;
};

type SeedCustomer = { mobile: string; name: string; why: string; vehicles: SeedVehicle[] };

const customers: SeedCustomer[] = [
  {
    mobile: '9810011001',
    name: 'Rohit Sharma',
    why: 'happy path — the E10 reference script',
    vehicles: [
      {
        registration: 'HR26AB4471',
        model: 'Nexon',
        purchasedDaysAgo: 1180,
        serviceNumber: 4,
        serviceType: 'major',
        isFree: false,
        dueDaysAgo: 9,
      },
    ],
  },
  {
    mobile: '9810022002',
    name: 'Priya Menon',
    why: 'two vehicles, different models — forces disambiguation, and both are due (D12 upsell)',
    vehicles: [
      {
        registration: 'DL8CAF2213',
        model: 'Swift',
        purchasedDaysAgo: 900,
        serviceNumber: 3,
        serviceType: 'minor',
        isFree: true,
        dueDaysAgo: 20,
      },
      {
        registration: 'DL8CAG5567',
        model: 'Creta',
        purchasedDaysAgo: 600,
        serviceNumber: 2,
        serviceType: 'minor',
        isFree: true,
        dueDaysAgo: 5,
      },
    ],
  },
  {
    mobile: '9810111011',
    name: 'Arjun Das',
    why: 'two vehicles of the SAME model — model alone can never disambiguate, so the third '
      + 'cascade pass fails and the call ends with model_not_recognised',
    vehicles: [
      {
        registration: 'KA01AA1234',
        model: 'Swift',
        purchasedDaysAgo: 1000,
        serviceNumber: 2,
        serviceType: 'minor',
        isFree: true,
        dueDaysAgo: 8,
      },
      {
        registration: 'KA01AA5678',
        model: 'Swift',
        purchasedDaysAgo: 1400,
        serviceNumber: 4,
        serviceType: 'major',
        isFree: false,
        dueDaysAgo: 22,
      },
    ],
  },
  {
    mobile: '9810033003',
    name: 'Anil Verma',
    why: 'due date in the FUTURE — not a blocker (D2), can still book now',
    vehicles: [
      {
        registration: 'KA05MN0918',
        model: 'Baleno',
        purchasedDaysAgo: 40,
        serviceNumber: 1,
        serviceType: 'minor',
        isFree: true,
        dueDaysAgo: -45,
      },
    ],
  },
  {
    mobile: '9810044004',
    name: 'Sunita Rao',
    why: '2nd free service, overdue but inside the 60-day window — bookable',
    vehicles: [
      {
        registration: 'MH12PQ3344',
        model: 'i20',
        purchasedDaysAgo: 420,
        serviceNumber: 2,
        serviceType: 'minor',
        isFree: true,
        dueDaysAgo: 30,
      },
    ],
  },
  {
    mobile: '9810055005',
    name: 'Karan Gill',
    why: 'free window exhausted, paid service due',
    vehicles: [
      {
        registration: 'PB10RS7788',
        model: 'Fortuner',
        purchasedDaysAgo: 1800,
        serviceNumber: 6,
        serviceType: 'major',
        isFree: false,
        dueDaysAgo: 12,
      },
    ],
  },
  {
    mobile: '9810066006',
    name: 'Meera Joshi',
    why: 'already has an open booking — duplicate check fires at intent (E4)',
    vehicles: [
      {
        registration: 'GJ01TU2255',
        model: 'Tiago',
        purchasedDaysAgo: 700,
        serviceNumber: 3,
        serviceType: 'minor',
        isFree: true,
        dueDaysAgo: 15,
      },
    ],
  },
  {
    mobile: '9810077007',
    name: 'Vikram Nair',
    why: 'free service with NULL due date — no booking, route out (D2)',
    vehicles: [
      {
        registration: 'TN09VW6600',
        model: 'Venue',
        purchasedDaysAgo: 500,
        serviceNumber: 2,
        serviceType: 'minor',
        isFree: true,
        dueDaysAgo: null,
      },
    ],
  },
  {
    mobile: '9810088008',
    name: 'Deepa Iyer',
    why: 'free service 75 days overdue — past the 60-day cutoff, route out (D2)',
    vehicles: [
      {
        registration: 'RJ14XY1177',
        model: 'Altroz',
        purchasedDaysAgo: 800,
        serviceNumber: 3,
        serviceType: 'minor',
        isFree: true,
        dueDaysAgo: 75,
      },
    ],
  },
  {
    mobile: '9810099009',
    name: 'Farhan Qureshi',
    why: 'service type NULL — cannot create a booking (D3), lead names the missing field',
    vehicles: [
      {
        registration: 'UP16ZA8899',
        model: 'Kwid',
        purchasedDaysAgo: 650,
        serviceNumber: 3,
        serviceType: null,
        isFree: true,
        dueDaysAgo: 10,
      },
    ],
  },
  {
    mobile: '9810100010',
    name: 'Neha Kapoor',
    why: 'PAID service with NULL due date — books normally (D2), the mirror of Vikram',
    vehicles: [
      {
        registration: 'KL07BC4433',
        model: 'Ertiga',
        purchasedDaysAgo: 1500,
        serviceNumber: 5,
        serviceType: 'major',
        isFree: false,
        dueDaysAgo: null,
      },
    ],
  },
];

const insertCustomer = db.prepare(
  `INSERT INTO customers (mobile_number, name, created_at) VALUES (?, ?, ?)`,
);
const insertVehicle = db.prepare(
  `INSERT INTO vehicles (customer_id, registration_number, model, purchase_date)
   VALUES (?, ?, ?, ?)`,
);
const insertServiceDue = db.prepare(
  `INSERT INTO service_due (vehicle_id, service_number, service_type, is_free, due_date)
   VALUES (?, ?, ?, ?, ?)`,
);

/** registration -> vehicle id, for the booking below. */
const vehicleIds = new Map<string, number>();

for (const c of customers) {
  const customerId = Number(insertCustomer.run(c.mobile, c.name, NOW).lastInsertRowid);
  for (const v of c.vehicles) {
    const vehicleId = Number(
      insertVehicle.run(
        customerId,
        v.registration,
        v.model,
        addDays(TODAY, -v.purchasedDaysAgo),
      ).lastInsertRowid,
    );
    vehicleIds.set(v.registration, vehicleId);
    insertServiceDue.run(
      vehicleId,
      v.serviceNumber,
      v.serviceType,
      v.isFree ? 1 : 0,
      v.dueDaysAgo === null ? null : addDays(TODAY, -v.dueDaysAgo),
    );
  }
}

// ---------------------------------------------------------------------------
// slot_capacity — generated from the master, today through +30, all centres.
//
// The centre is open 7 days with no holidays (D5), so this is a plain walk
// forward. The old isSunday guard is gone (I4-1) — it was zeroing the very days
// the bends below target, which is why the "one slot left" case vanished.
// ---------------------------------------------------------------------------

const insertSlot = db.prepare(
  `INSERT INTO slot_capacity (centre_id, date, service_type, drop_slot, total_slots, booked_slots)
   VALUES (?, ?, ?, ?, ?, 0)`,
);
const masterFor = db.prepare(
  `SELECT total_slots FROM capacity_master
   WHERE weekday = ? AND service_type = ? AND drop_slot = ?`,
);

const generateCapacity = db.transaction(() => {
  for (let offset = 0; offset <= BOOKING_WINDOW_DAYS; offset++) {
    const date = addDays(TODAY, offset);
    const weekday = weekdayOf(date);
    for (const pool of POOLS) {
      for (const slot of SLOTS) {
        const { total_slots } = masterFor.get(weekday, pool, slot) as { total_slots: number };
        for (const c of centres) insertSlot.run(c.id, date, pool, slot, total_slots);
      }
    }
  }
});
generateCapacity();

// ---------------------------------------------------------------------------
// Capacity bends — centre 1 only (I3). Centres 2 and 3 stay wide open.
// These are what make day selection worth testing.
// ---------------------------------------------------------------------------

const fill = db.prepare(
  `UPDATE slot_capacity SET booked_slots = total_slots
   WHERE centre_id = 1 AND date = ? AND service_type = ?
     AND (? IS NULL OR drop_slot = ?)`,
);

const bends: Array<{ offset: number; note: string; apply: (date: IsoDate) => void }> = [
  {
    offset: 2,
    note: 'minor full both slots — a minor booking must move to another day',
    apply: (date) => fill.run(date, 'minor', null, null),
  },
  {
    offset: 3,
    note: 'every pool full both slots — the day is unavailable entirely (D6)',
    apply: (date) => {
      for (const pool of POOLS) fill.run(date, pool, null, null);
    },
  },
  {
    offset: 4,
    note: 'minor morning full, afternoon open — the agent states the slot rather than asking (D6)',
    apply: (date) => fill.run(date, 'minor', 'morning', 'morning'),
  },
];

for (const bend of bends) bend.apply(addDays(TODAY, bend.offset));

// ---------------------------------------------------------------------------
// Meera's existing open booking (E4). A dealer-channel booking, so the demo
// shows both sources on one table and capacity decrements the same way.
// ---------------------------------------------------------------------------

const OPEN_BOOKING_DATE = addDays(TODAY, 5);
const meeraVehicleId = vehicleIds.get('GJ01TU2255')!;

const bookOne = db.prepare(
  `UPDATE slot_capacity SET booked_slots = booked_slots + 1
   WHERE centre_id = ? AND date = ? AND service_type = ? AND drop_slot = ?
     AND booked_slots < total_slots`,
);

const seedBooking = db.transaction(() => {
  // Conditional decrement, asserted — never read-then-increment (D4).
  const taken = bookOne.run(1, OPEN_BOOKING_DATE, 'minor', 'morning');
  if (taken.changes !== 1) throw new Error('seed: could not reserve the slot for Meera');

  const reference = nextBookingReference(db, 1, TODAY);

  db.prepare(
    `INSERT INTO bookings
       (booking_reference, vehicle_id, centre_id, service_type, booking_date, drop_slot,
        expected_pickup, complaint_note, status, source, created_at)
     VALUES (?, ?, 1, 'minor', ?, 'morning', ?, NULL, 'open', 'dealer', ?)`,
  ).run(reference, meeraVehicleId, OPEN_BOOKING_DATE, OPEN_BOOKING_DATE, NOW);
});
seedBooking();

// ---------------------------------------------------------------------------
// Leads — one per routing outcome (F2), so all five lead reports render with
// something in them. `free_service_not_bookable` appears twice on purpose,
// with and without a due date: the retention report splits it into its two
// call scripts.
// ---------------------------------------------------------------------------

type SeedLead = {
  reason: string;
  mobile: string;
  /** Registration, or null where we never identified the vehicle. */
  registration: string | null;
  requestedDate?: IsoDate;
  requestedSlot?: string;
  requestedPool?: string;
  callerWords?: string;
  /** CRM facts frozen at call time. The retention split reads due_date. */
  crm?: Record<string, unknown>;
};

const leads: SeedLead[] = [
  {
    reason: 'number_not_found',
    mobile: '9899999999',
    registration: null,
    callerWords: 'I want to book a service for my car.',
  },
  {
    reason: 'model_not_recognised',
    mobile: '9810111011',
    registration: null,
    callerWords: "It's the Swift.",
  },
  {
    reason: 'missing_required_field',
    mobile: '9810099009',
    registration: 'UP16ZA8899',
    callerWords: 'Need to get the Kwid serviced this week.',
    crm: { service_number: 3, service_type: null, is_free: true, missing_field: 'service_type' },
  },
  {
    reason: 'another_problem',
    mobile: '9810055005',
    registration: 'PB10RS7788',
    callerWords:
      "The car won't start at all, it's sitting in my building basement. I need someone to come out.",
  },
  {
    reason: 'free_service_not_bookable',
    mobile: '9810088008',
    registration: 'RJ14XY1177',
    callerWords: 'I think the free service is still pending on the Altroz?',
    // Overdue — the "chase" half of the retention report.
    crm: { service_number: 3, service_type: 'minor', is_free: true, due_date: addDays(TODAY, -75) },
  },
  {
    reason: 'free_service_not_bookable',
    mobile: '9810077007',
    registration: 'TN09VW6600',
    callerWords: 'Want to book the Venue in for its service.',
    // No due date — the "record fix / win-back" half.
    crm: { service_number: 2, service_type: 'minor', is_free: true, due_date: null },
  },
  {
    reason: 'existing_open_booking',
    mobile: '9810066006',
    registration: 'GJ01TU2255',
    callerWords: 'Can I book the Tiago in for Friday?',
  },
  {
    reason: 'forced_full_day',
    mobile: '9810044004',
    registration: 'MH12PQ3344',
    requestedDate: addDays(TODAY, 3),
    requestedSlot: 'morning',
    requestedPool: 'minor',
    callerWords: 'No, it has to be Wednesday. Wednesday is the only day I can do.',
  },
  {
    reason: 'nothing_available_30_days',
    mobile: '9810022002',
    registration: 'DL8CAG5567',
    requestedPool: 'major',
    callerWords: 'Any day at all works, whenever you have something.',
  },
  {
    reason: 'same_day_demanded',
    mobile: '9810100010',
    registration: 'KL07BC4433',
    requestedDate: addDays(TODAY, 6),
    requestedSlot: 'afternoon',
    requestedPool: 'major',
    callerWords: 'I need it back the same evening, I have to drive to Jaipur the next morning.',
  },
];

const findCustomer = db.prepare(`SELECT id FROM customers WHERE mobile_number = ?`);
const findVehicle = db.prepare(`SELECT model FROM vehicles WHERE registration_number = ?`);
const insertLead = db.prepare(
  `INSERT INTO leads
     (mobile_number, reason, customer_id, vehicle_registration, vehicle_model,
      requested_date, requested_slot, requested_pool, crm_snapshot, caller_words,
      session_id, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
);

for (const l of leads) {
  const customer = findCustomer.get(l.mobile) as { id: number } | undefined;
  const vehicle = l.registration
    ? (findVehicle.get(l.registration) as { model: string } | undefined)
    : undefined;
  insertLead.run(
    l.mobile,
    l.reason,
    customer?.id ?? null,
    l.registration,
    vehicle?.model ?? null,
    l.requestedDate ?? null,
    l.requestedSlot ?? null,
    l.requestedPool ?? null,
    l.crm ? JSON.stringify(l.crm) : null,
    l.callerWords ?? null,
    NOW,
  );
}

// ---------------------------------------------------------------------------
// Knowledge bank — per-dealer org facts only, no customer data (D10).
// A question the bank cannot answer ends the call; it never guesses.
// ---------------------------------------------------------------------------

const kb: Array<[string, string]> = [
  ['opening_hours', 'The workshop is open every day, 9 in the morning to 7 in the evening.'],
  ['location', "We're in Sector 44, just behind the HUDA City Centre metro station."],
  ['parking', "There's customer parking on site, to the left of the service entrance."],
  ['waiting_area', "There's a waiting lounge upstairs with tea, coffee and wifi."],
  ['pickup_drop', 'Pickup and drop is available within a 10 kilometre radius, at a charge.'],
  ['payment_methods', 'Cards, UPI and cash are all accepted at the counter.'],
];

const insertKb = db.prepare(
  `INSERT INTO knowledge_bank (centre_id, question_key, answer_text) VALUES (1, ?, ?)`,
);
for (const [key, answer] of kb) insertKb.run(key, answer);

// ---------------------------------------------------------------------------

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const summary: SeedSummary = {
  today: TODAY,
  weekday: weekdayOf(TODAY),
  counts: Object.fromEntries(
    ['centres', 'customers', 'vehicles', 'service_due', 'capacity_master', 'slot_capacity',
      'bookings', 'leads', 'knowledge_bank'].map((t) => [t, count(t)]),
  ),
  bends: bends.map((b) => ({ date: addDays(TODAY, b.offset), offset: b.offset, note: b.note })),
};

db.close();
return summary;
}

// ---------------------------------------------------------------------------

// resolve() both sides: on Windows import.meta.url is file:///C:/... while
// argv[1] is C:\... — string comparison of the two never matches.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const s = seed();
  console.log(`Rebuilt ${DB_PATH}`);
  console.log(`  today ............... ${s.today} (weekday ${s.weekday})`);
  for (const [table, n] of Object.entries(s.counts)) {
    console.log(`  ${table.padEnd(19, '.')} ${n}`);
  }
  for (const b of s.bends) console.log(`  bend day +${b.offset} (${b.date}) — ${b.note}`);
}
