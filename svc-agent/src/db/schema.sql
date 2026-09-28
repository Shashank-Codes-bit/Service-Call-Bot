-- AI Service Booking Agent — schema
--
-- One database, two apps. Dealer-owned tables are read by the call app over
-- HTTP (the swappable CRM boundary); capacity and call-owned tables are written
-- directly.
--
-- SQL kept plain and Postgres-portable: dates and timestamps are ISO TEXT,
-- booleans are INTEGER 0/1 with a CHECK.

DROP TABLE IF EXISTS sms_log;
DROP TABLE IF EXISTS transcripts;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS leads;
DROP TABLE IF EXISTS booking_counter;
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS slot_capacity;
DROP TABLE IF EXISTS capacity_master;
DROP TABLE IF EXISTS knowledge_bank;
DROP TABLE IF EXISTS service_due;
DROP TABLE IF EXISTS vehicles;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS centres;

-- ---------------------------------------------------------------------------
-- Dealer-owned
-- ---------------------------------------------------------------------------

CREATE TABLE centres (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  landline  TEXT NOT NULL,
  -- Knowledge-bank data only. D14 removed out-of-hours handling, so these
  -- never gate a booking; drop times are fixed at 08:30 and 14:00.
  opens_at  TEXT NOT NULL,
  closes_at TEXT NOT NULL
);

CREATE TABLE customers (
  id            INTEGER PRIMARY KEY,
  -- UNIQUE already creates the index; the old idx_customers_mobile was
  -- redundant (I4-5).
  mobile_number TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE vehicles (
  id                  INTEGER PRIMARY KEY,
  customer_id         INTEGER NOT NULL REFERENCES customers(id),
  registration_number TEXT NOT NULL UNIQUE,
  model               TEXT NOT NULL,
  purchase_date       TEXT
);

CREATE INDEX idx_vehicles_customer ON vehicles(customer_id);

-- The CRM lookup result: the *next* due service for a vehicle. One row per
-- vehicle. Replaces the old service_history entirely (C1) — we never derive
-- service-due ourselves (D1).
CREATE TABLE service_due (
  vehicle_id     INTEGER PRIMARY KEY REFERENCES vehicles(id),
  service_number INTEGER NOT NULL,
  -- NULL is legal and blocks booking (D3). CHECK must therefore admit NULL.
  service_type   TEXT CHECK (service_type IS NULL OR service_type IN ('minor', 'major')),
  is_free        INTEGER NOT NULL CHECK (is_free IN (0, 1)),
  -- NULL is legal (D2): vehicle serviced outside the network.
  due_date       TEXT
);

CREATE TABLE knowledge_bank (
  id           INTEGER PRIMARY KEY,
  centre_id    INTEGER NOT NULL REFERENCES centres(id),
  question_key TEXT NOT NULL,
  answer_text  TEXT NOT NULL,
  UNIQUE (centre_id, question_key)
);

-- ---------------------------------------------------------------------------
-- Capacity — ours, central, shared by both apps
-- ---------------------------------------------------------------------------

-- 7 weekdays x {minor, major, complaint} x {morning, afternoon} = 42 rows.
-- Renders as the 7x6 grid in the dealer UI. Set NET of expected walk-in load
-- (D4): if a day has 6 major bays and ~2 go to walk-ins, this says 4.
CREATE TABLE capacity_master (
  id           INTEGER PRIMARY KEY,
  -- 0 = Sunday .. 6 = Saturday. The centre is open 7 days (D5) — there is no
  -- closed-day concept, so every weekday carries rows.
  weekday      INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  service_type TEXT NOT NULL CHECK (service_type IN ('minor', 'major', 'complaint')),
  drop_slot    TEXT NOT NULL CHECK (drop_slot IN ('morning', 'afternoon')),
  total_slots  INTEGER NOT NULL CHECK (total_slots >= 0),
  UNIQUE (weekday, service_type, drop_slot)
);

-- Generated 30 days forward from capacity_master. Split by drop slot (C1):
-- capacity is checked at day + pool + morning/afternoon.
CREATE TABLE slot_capacity (
  id           INTEGER PRIMARY KEY,
  centre_id    INTEGER NOT NULL REFERENCES centres(id),
  date         TEXT NOT NULL,
  service_type TEXT NOT NULL CHECK (service_type IN ('minor', 'major', 'complaint')),
  drop_slot    TEXT NOT NULL CHECK (drop_slot IN ('morning', 'afternoon')),
  total_slots  INTEGER NOT NULL CHECK (total_slots >= 0),
  booked_slots INTEGER NOT NULL DEFAULT 0,
  -- The DB-level overbooking guard missing from the earlier build (I4-3).
  -- Belt to the conditional UPDATE's braces: writes use
  --   UPDATE ... SET booked_slots = booked_slots + 1
  --   WHERE ... AND booked_slots < total_slots
  -- and assert changes = 1. Never read-then-increment (D4).
  CHECK (booked_slots >= 0 AND booked_slots <= total_slots),
  UNIQUE (centre_id, date, service_type, drop_slot)
);

CREATE INDEX idx_slot_capacity_lookup ON slot_capacity(centre_id, date, service_type);

-- ---------------------------------------------------------------------------
-- Call-app owned
-- ---------------------------------------------------------------------------

CREATE TABLE bookings (
  id                INTEGER PRIMARY KEY,
  -- YYMMDD-NNNNN, per centre per day, from 00000. Never sufficient alone to
  -- retrieve a booking — lookup requires reference + registered mobile.
  booking_reference TEXT NOT NULL UNIQUE,
  vehicle_id        INTEGER NOT NULL REFERENCES vehicles(id),
  centre_id         INTEGER NOT NULL REFERENCES centres(id),
  -- A complaint moves the booking into the complaint pool (D8), so this is the
  -- pool, not just the CRM's minor/major.
  service_type      TEXT NOT NULL CHECK (service_type IN ('minor', 'major', 'complaint')),
  booking_date      TEXT NOT NULL,
  drop_slot         TEXT NOT NULL CHECK (drop_slot IN ('morning', 'afternoon')),
  -- EDD: our computed output (D7), never a CRM field. Always an estimate.
  expected_pickup   TEXT NOT NULL,
  -- One note field. Complaint and special request on consecutive lines if both
  -- somehow arrive (D8).
  complaint_note    TEXT,
  -- D13: an open booking is an open booking, no date condition.
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'completed', 'cancelled')),
  -- Lets the demo show both channels on one table.
  source            TEXT NOT NULL CHECK (source IN ('ai', 'dealer')),
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_bookings_vehicle_status ON bookings(vehicle_id, status);
CREATE INDEX idx_bookings_date ON bookings(centre_id, booking_date);
CREATE INDEX idx_bookings_created ON bookings(created_at);

-- Atomic source for the booking reference's sequence. Incremented with
--   UPDATE ... SET last_seq = last_seq + 1 ... RETURNING last_seq
-- never with COUNT(*), which races.
CREATE TABLE booking_counter (
  centre_id INTEGER NOT NULL REFERENCES centres(id),
  date      TEXT NOT NULL,
  last_seq  INTEGER NOT NULL,
  PRIMARY KEY (centre_id, date)
);

-- The nine routing outcomes (F2, as amended). Every route to the service
-- centre writes one, and each reason belongs to exactly one report (F3).
CREATE TABLE leads (
  id                   INTEGER PRIMARY KEY,
  mobile_number        TEXT NOT NULL,
  reason               TEXT NOT NULL CHECK (reason IN (
                         'number_not_found',          -- CRM/data
                         'model_not_recognised',      -- CRM/data
                         'missing_required_field',    -- CRM/data
                         'another_problem',           -- customer care (also KB miss)
                         'free_service_not_bookable', -- retention
                         'existing_open_booking',     -- reception
                         'forced_full_day',           -- service manager
                         'nothing_available_30_days', -- service manager
                         'same_day_demanded'          -- service manager
                       )),
  customer_id          INTEGER REFERENCES customers(id),
  vehicle_registration TEXT,
  vehicle_model        TEXT,
  -- What they were trying to do.
  requested_date       TEXT,
  requested_slot       TEXT,
  requested_pool       TEXT,
  -- CRM facts frozen at call time, as JSON.
  crm_snapshot         TEXT,
  -- The caller's own words.
  caller_words         TEXT,
  session_id           TEXT REFERENCES sessions(id),
  created_at           TEXT NOT NULL
);

CREATE INDEX idx_leads_created_reason ON leads(created_at, reason);

-- Server-side conversation state, keyed on session id (F5). The voice layer
-- inherits it unchanged.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  -- Current state-machine state.
  state      TEXT NOT NULL,
  -- Identified customer/vehicle, prefetched CRM result, filled slots, the
  -- pushback counter (D11 cannot work without it), OTP attempts and resends,
  -- and the same-day-nudge-declined flag (D7). JSON.
  data       TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at   TEXT
);

-- Separate from sessions so the 45-day retention purge is one DELETE.
CREATE TABLE transcripts (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_index INTEGER NOT NULL,
  speaker    TEXT NOT NULL CHECK (speaker IN ('agent', 'caller')),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, turn_index)
);

-- F1: for the chat build, log what the SMS would say rather than integrating a
-- provider. Every "call the service centre" outcome sends one too.
CREATE TABLE sms_log (
  id            INTEGER PRIMARY KEY,
  booking_id    INTEGER REFERENCES bookings(id),
  lead_id       INTEGER REFERENCES leads(id),
  mobile_number TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
