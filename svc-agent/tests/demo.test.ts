import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import type express from 'express';
import { Accounts } from '../src/orgs/accounts.ts';
import { Registry } from '../src/orgs/registry.ts';
import { buildApp } from '../src/dealer/app.ts';
import { StubClassifier } from '../src/call/classifier.ts';
import { DemoCrm, LocalCrm } from '../src/call/crm.ts';
import { nightlyResets, resetDemoActivity, resetDue, resetKey } from '../src/orgs/demo.ts';
import { DEMO_CALLERS_PER_DAY } from '../src/dealer/public.ts';
import { addDemoCaller, DEMO_CALLER_PREFIX } from '../src/db/sample.ts';
import { createKnowledge, readEssentials, saveEssentials } from '../src/kb/knowledge.ts';
import { assistantPayload, DEFAULT_VOICE, describeVoice, parseVoice, voiceFor } from '../src/tools/vapi-setup.ts';
import { at } from '../src/db/sample.ts';
import { addDays, today } from '../src/shared/dates.ts';
import { config } from '../src/config.ts';

/**
 * Demo centres: the switch, the nightly return to the sample, and what the
 * public page offers a visitor because of it. Offline — the stub classifier.
 */

const SECRET = 's3cret';
const ROHIT = '9810011001';
let dir: string;
let accounts: Accounts;
let registry: Registry;
let app: express.Express;

/** The real wiring's choice (http.ts buildDeps), with the stub classifier. */
const deps = (db: Database.Database, { demo }: { demo: boolean }) => ({
  classifier: new StubClassifier(),
  crm: demo ? new DemoCrm(db, new LocalCrm(db)) : new LocalCrm(db),
});

beforeEach(() => {
  vi.spyOn(config, 'callApiSecret', 'get' as never).mockReturnValue(SECRET as never);
  vi.spyOn(config, 'demoMode', 'get' as never).mockReturnValue(true as never);
  dir = mkdtempSync(join(tmpdir(), 'svc-demo-'));
  accounts = new Accounts(dir);
  registry = new Registry(accounts, deps);
  app = buildApp({ accounts, registry });
  accounts.create({ name: 'Centre A', userId: 'centre-a', password: 'password-a' });
  accounts.create({ name: 'Centre B', userId: 'centre-b', password: 'password-b' });
});

afterEach(() => {
  vi.restoreAllMocks();
  registry.close();
  accounts.close();
  rmSync(dir, { recursive: true, force: true });
});

const db = (slug = 'centre-a') => registry.get(slug)!.db;
const count = (sql: string, slug = 'centre-a', ...args: unknown[]) =>
  (db(slug).prepare(sql).get(...args) as { n: number }).n;

/** Book a caller's only car through the public chat, as a visitor would. */
async function bookByChat(slug: string, mobile: string, model: string) {
  const start = await request(app).post(`/public/${slug}/chat/start`).send({ callerNumber: mobile }).expect(200);
  let last = start;
  for (const line of ['Yes.', `Book the ${model} in for Friday.`, "No, it's fine.", 'No.', 'Morning.', 'Yes.']) {
    last = await request(app).post(`/public/${slug}/chat/turn`).send({ sessionId: start.body.sessionId, utterance: line }).expect(200);
  }
  return last.body as { reply: string; ended: boolean; bookingReference?: string };
}

const signIn = async (userId: string, password: string) =>
  String((await request(app).post('/auth/login').send({ userId, password }).expect(200)).headers['set-cookie']).split(';')[0]!;

describe('the switch', () => {
  it('is on for a new centre, and for one from before the switch existed', () => {
    expect(accounts.get('centre-a')!.demo).toBe(1);

    // An accounts file from before: no demo column.
    const legacyDir = mkdtempSync(join(tmpdir(), 'svc-demo-legacy-'));
    const legacy = new Database(join(legacyDir, 'accounts.db'));
    legacy.exec(`
      CREATE TABLE orgs (slug TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, daily_turn_cap INTEGER, created_at TEXT NOT NULL);
      INSERT INTO orgs VALUES ('voltas', 'Voltas', 'voltas', 's', 'h', NULL, '2026-09-01');
    `);
    legacy.close();
    const migrated = new Accounts(legacyDir);
    expect(migrated.get('voltas')!.demo).toBe(1);
    migrated.setDemo('voltas', false);
    expect(migrated.get('voltas')!.demo).toBe(0);
    migrated.close();
    rmSync(legacyDir, { recursive: true, force: true });
  });

  it('turns on and off from the portal, and the very next call behaves the new way', async () => {
    const cookie = await signIn('centre-a', 'password-a');
    const me = await request(app).get('/auth/me').set('cookie', cookie).expect(200);
    expect(me.body).toMatchObject({ demo: true, demoAvailable: true });

    // Demo: any number gets a demo car.
    await request(app).post('/public/centre-a/chat/start').send({ callerNumber: '9876543210' }).expect(200);

    const off = await request(app).put('/auth/demo').set('cookie', cookie).send({ demo: false }).expect(200);
    expect(off.body.demo).toBe(false);
    expect(registry.get('centre-a')!.demo).toBe(false);
    // Not demo: only the sample callers, and no reset to run.
    await request(app).post('/public/centre-a/chat/start').send({ callerNumber: '9876543211' }).expect(403);
    await request(app).post('/public/centre-a/chat/start').send({ callerNumber: ROHIT }).expect(200);
    await request(app).post('/auth/demo/reset').set('cookie', cookie).expect(409);
    // The other centre is untouched.
    expect(registry.get('centre-b')!.demo).toBe(true);

    await request(app).put('/auth/demo').set('cookie', cookie).send({ demo: true }).expect(200);
    expect(registry.get('centre-a')!.demo).toBe(true);
  });

  it('needs a sign-in and a true or false', async () => {
    await request(app).put('/auth/demo').send({ demo: false }).expect(401);
    const cookie = await signIn('centre-a', 'password-a');
    await request(app).put('/auth/demo').set('cookie', cookie).send({ demo: 'no' }).expect(400);
  });

  it('is off everywhere when the server is not in demo mode', async () => {
    vi.spyOn(config, 'demoMode', 'get' as never).mockReturnValue(false as never);
    expect(registry.get('centre-a')!.demo).toBe(false);
    const cookie = await signIn('centre-a', 'password-a');
    const me = await request(app).get('/auth/me').set('cookie', cookie).expect(200);
    expect(me.body.demoAvailable).toBe(false);
  });

  it('only lets a non-demo centre’s voice call name a sample caller', async () => {
    const call = (id: string, slug: string, caller: string) =>
      request(app)
        .post('/vapi/chat/completions')
        .set('authorization', `Bearer ${SECRET}`)
        .send({ stream: false, call: { id }, messages: [{ role: 'system', content: `svc-agent org=${slug} caller=${caller}` }] })
        .expect(200);
    // A sample-fleet customer, not one of the public callers.
    const fleet = (db().prepare(`SELECT mobile_number m FROM customers WHERE mobile_number LIKE '98201%' LIMIT 1`).get() as { m: string }).m;
    accounts.setDemo('centre-a', false);
    registry.refresh('centre-a');
    await call('v-1', 'centre-a', fleet);
    const s = db().prepare(`SELECT json_extract(data, '$.callerNumber') n FROM sessions WHERE json_extract(data, '$.externalId') = 'v-1'`).get() as { n: string };
    expect(s.n).not.toBe(fleet);
    await call('v-2', 'centre-a', ROHIT);
    const r = db().prepare(`SELECT json_extract(data, '$.callerNumber') n FROM sessions WHERE json_extract(data, '$.externalId') = 'v-2'`).get() as { n: string };
    expect(r.n).toBe(ROHIT);
    // A demo centre takes the number it's given.
    await call('v-3', 'centre-b', fleet);
    const b = db('centre-b').prepare(`SELECT json_extract(data, '$.callerNumber') n FROM sessions WHERE json_extract(data, '$.externalId') = 'v-3'`).get() as { n: string };
    expect(b.n).toBe(fleet);
  });
});

describe('the reset', () => {
  it('puts activity back to the sample and keeps what the centre set up', async () => {
    const before = {
      bookings: count(`SELECT COUNT(*) n FROM bookings`),
      leads: count(`SELECT COUNT(*) n FROM leads`),
      customers: count(`SELECT COUNT(*) n FROM customers`),
    };
    // A day of use: a booking, a demo caller, an entry, the essentials, places, a rename.
    expect((await bookByChat('centre-a', ROHIT, 'Nexon')).bookingReference).toBeTruthy();
    addDemoCaller(db());
    const kb = createKnowledge(db(), { category: 'offers', title: 'Wiper week', answer: 'Free wiper check all week.', phrases: 'wiperweek', validUntil: null });
    const { essentials } = readEssentials(db());
    saveEssentials(db(), { ...essentials, address: '12 New Road, Sector 9' });
    db().prepare(`UPDATE capacity_master SET total_slots = 7 WHERE weekday = 1 AND service_type = 'minor' AND drop_slot = 'morning'`).run();
    db().prepare(`UPDATE centres SET name = 'Centre A Renamed' WHERE id = 1`).run();
    expect(count(`SELECT COUNT(*) n FROM bookings`)).toBe(before.bookings + 1);

    const r = resetDemoActivity(db());
    expect(r.bookings).toBe(before.bookings);
    expect(count(`SELECT COUNT(*) n FROM leads`)).toBe(before.leads);
    expect(count(`SELECT COUNT(*) n FROM customers`)).toBe(before.customers);
    expect(count(`SELECT COUNT(*) n FROM customers WHERE mobile_number LIKE '${DEMO_CALLER_PREFIX}%'`)).toBe(0);
    // Kept.
    expect(count(`SELECT COUNT(*) n FROM knowledge_bank WHERE id = ?`, 'centre-a', kb)).toBe(1);
    expect(readEssentials(db()).essentials.address).toBe('12 New Road, Sector 9');
    expect(count(`SELECT total_slots n FROM capacity_master WHERE weekday = 1 AND service_type = 'minor' AND drop_slot = 'morning'`)).toBe(7);
    // The new window's Mondays use the centre's own places.
    const monday = Array.from({ length: 8 }, (_, i) => addDays(today(), i)).find((d) => new Date(`${d}T12:00`).getDay() === 1)!;
    expect(count(`SELECT total_slots n FROM slot_capacity WHERE date = ? AND service_type = 'minor' AND drop_slot = 'morning'`, 'centre-a', monday)).toBeGreaterThanOrEqual(7);
    // The sample's calls speak with this centre's name, not the sample's.
    expect(count(`SELECT COUNT(*) n FROM transcripts WHERE text LIKE '%Centre A Renamed%'`)).toBeGreaterThan(0);
    // The knowledge search still works over the kept entries.
    expect(count(`SELECT COUNT(*) n FROM knowledge_fts WHERE knowledge_fts MATCH 'wiperweek'`)).toBe(1);

    // Rohit is free to book again.
    const page = await request(app).get('/public/centre-a').expect(200);
    expect(page.body.callers.find((c: { mobile: string }) => c.mobile === ROHIT)).toMatchObject({ booked: null, canBook: true });
  });

  it('can be run from the portal, for a demo centre', async () => {
    await bookByChat('centre-a', ROHIT, 'Nexon');
    const cookie = await signIn('centre-a', 'password-a');
    const res = await request(app).post('/auth/demo/reset').set('cookie', cookie).expect(200);
    expect(res.body.ok).toBe(true);
    expect(count(`SELECT COUNT(*) n FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id JOIN customers c ON c.id = v.customer_id WHERE c.mobile_number = ? AND b.status = 'open'`, 'centre-a', ROHIT)).toBe(0);
    // Counted as tonight's: the night doesn't do it again.
    expect(accounts.getMeta(resetKey('centre-a'))).toBe(today());
  });
});

describe('the night', () => {
  const day = today();
  const log = () => {};

  it('is due after 3:00 on a day not yet done', () => {
    expect(resetDue(at(day, '02:59'), addDays(day, -1))).toBe(false);
    expect(resetDue(at(day, '03:00'), addDays(day, -1))).toBe(true);
    expect(resetDue(at(day, '23:00'), day)).toBe(false);
  });

  it('marks a centre on first sight, resets it once a night after, and skips non-demo centres', async () => {
    expect(nightlyResets(accounts, registry, at(day, '04:00'), log)).toEqual([]);
    expect(accounts.getMeta(resetKey('centre-a'))).toBe(day);

    accounts.setDemo('centre-b', false);
    registry.refresh('centre-b');
    await bookByChat('centre-a', ROHIT, 'Nexon');
    const next = addDays(day, 1);
    expect(nightlyResets(accounts, registry, at(next, '02:00'), log)).toEqual([]);
    expect(nightlyResets(accounts, registry, at(next, '03:10'), log)).toEqual(['centre-a']);
    expect(nightlyResets(accounts, registry, at(next, '03:20'), log)).toEqual([]);
    expect(accounts.getMeta(resetKey('centre-a'))).toBe(next);
    // Seen on the first night, then switched off: never reset.
    expect(accounts.getMeta(resetKey('centre-b'))).toBe(day);
  });
});

describe('the public page’s callers', () => {
  it('says who is already booked, and lists who can book first', async () => {
    await bookByChat('centre-a', ROHIT, 'Nexon');
    const { callers } = (await request(app).get('/public/centre-a').expect(200)).body as {
      callers: Array<{ mobile: string; booked: { date: string; slot: string } | null; canBook: boolean }>;
    };
    const rohit = callers.find((c) => c.mobile === ROHIT)!;
    expect(rohit.canBook).toBe(false);
    expect(rohit.booked).toMatchObject({ slot: 'morning' });
    expect(callers[0]!.canBook).toBe(true);
    const firstBooked = callers.findIndex((c) => !c.canBook);
    expect(callers.slice(firstBooked).every((c) => !c.canBook)).toBe(true);
  });

  it('adds a made-up demo caller who books straight through', async () => {
    const res = await request(app).post('/public/centre-a/demo-caller').expect(201);
    expect(res.body).toMatchObject({ canBook: true, booked: null });
    expect(res.body.mobile).toMatch(new RegExp(`^${DEMO_CALLER_PREFIX}\\d{6}$`));
    expect(res.body.name).toMatch(/^\w+ \w+$/);
    const done = await bookByChat('centre-a', res.body.mobile, res.body.model);
    expect(done.bookingReference).toBeTruthy();
    // Only on this centre.
    expect(count(`SELECT COUNT(*) n FROM customers WHERE mobile_number = ?`, 'centre-b', res.body.mobile)).toBe(0);
  });

  it('adds none on a centre that isn’t a demo, and stops at the day’s ceiling', async () => {
    accounts.setDemo('centre-b', false);
    registry.refresh('centre-b');
    await request(app).post('/public/centre-b/demo-caller').expect(403);
    expect((await request(app).get('/public/centre-b')).body.demo).toBe(false);

    for (let i = 0; i < DEMO_CALLERS_PER_DAY; i++) addDemoCaller(db());
    await request(app).post('/public/centre-a/demo-caller').expect(429);
  });
});

describe('the voice', () => {
  it('goes to the voice in whole sentences, Neerja unless chosen', () => {
    const p = assistantPayload({ publicUrl: 'https://x.sslip.io', callSecret: 'cs' });
    expect(p.voice).toMatchObject({ ...DEFAULT_VOICE, chunkPlan: { enabled: false } });
  });

  it('reads VAPI_VOICE, and refuses anything else', () => {
    expect(parseVoice('azure:en-IN-NeerjaNeural')).toEqual({ provider: 'azure', voiceId: 'en-IN-NeerjaNeural' });
    expect(parseVoice('11labs:abc123', 'eleven_flash_v2_5')).toEqual({ provider: '11labs', voiceId: 'abc123', model: 'eleven_flash_v2_5' });
    expect(parseVoice(' cartesia:3b5c-ff ')).toEqual({ provider: 'cartesia', voiceId: '3b5c-ff' });
    for (const bad of ['', 'Neerja', 'azure:', 'acme:voice', 'azure:two words']) expect(() => parseVoice(bad)).toThrow(/VAPI_VOICE/);
  });

  it('keeps the assistant’s own voice unless one is chosen, and never splits it', () => {
    const dashboard = { provider: '11labs', voiceId: 'picked-in-dashboard', model: 'eleven_turbo_v2_5', stability: 0.5 };
    expect(voiceFor(undefined, dashboard)).toEqual({ ...dashboard, chunkPlan: { enabled: false } });
    expect(voiceFor(parseVoice('cartesia:c1'), dashboard)).toEqual({ provider: 'cartesia', voiceId: 'c1', chunkPlan: { enabled: false } });
    expect(voiceFor(undefined, undefined)).toEqual({ ...DEFAULT_VOICE, chunkPlan: { enabled: false } });
    expect(voiceFor(undefined, { provider: 'azure', voiceId: 'v', chunkPlan: { enabled: true } }).chunkPlan).toEqual({ enabled: false });
    expect(describeVoice(parseVoice('11labs:abc', 'm'))).toBe('11labs abc (m), whole sentences');
  });
});
