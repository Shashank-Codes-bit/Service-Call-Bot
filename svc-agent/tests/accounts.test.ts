import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type express from 'express';
import { Accounts, initials } from '../src/orgs/accounts.ts';
import { Registry } from '../src/orgs/registry.ts';
import { buildApp } from '../src/dealer/app.ts';
import { StubClassifier } from '../src/call/classifier.ts';
import { LocalCrm } from '../src/call/crm.ts';
import { readSession, signSession } from '../src/auth.ts';
import { seed } from '../src/db/seed.ts';
import { open } from '../src/db/index.ts';
import { addDays, today } from '../src/shared/dates.ts';
import { config } from '../src/config.ts';

/**
 * Separate centres: who can sign in, and that a sign-in only ever reaches its
 * own centre's file. Offline throughout — the stub classifier.
 */

const PASSWORD = 'counter-desk-1';
let dir: string;
let accounts: Accounts;
let registry: Registry;
let app: express.Express;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'svc-orgs-'));
  accounts = new Accounts(dir);
  registry = new Registry(accounts, (db) => ({ classifier: new StubClassifier(), crm: new LocalCrm(db) }));
  app = buildApp({ accounts, registry });
});

afterEach(() => {
  vi.restoreAllMocks();
  registry.close();
  accounts.close();
  rmSync(dir, { recursive: true, force: true });
});

const signup = (centreName: string, userId: string, password = PASSWORD) =>
  request(app).post('/auth/signup').send({ centreName, userId, password });

const cookieFrom = (res: request.Response) => String(res.headers['set-cookie']).split(';')[0]!;

describe('initials', () => {
  it('takes the first letter of the first two words', () => {
    expect(initials('Auto Vikas')).toBe('AV');
    expect(initials('Voltas Motors Service — Sector 44')).toBe('VM');
  });
  it('gives a single word its first letter and the next consonant', () => {
    expect(initials('Vikas')).toBe('VK');
    expect(initials('Aeon')).toBe('AN');
  });
});

describe('sign-up', () => {
  it('opens a centre with the sample data, named as given, and signs it in', async () => {
    const res = await signup('Sharma Motors', 'sharma-indore').expect(201);
    expect(res.body).toMatchObject({ slug: 'sharma-indore', name: 'Sharma Motors', initials: 'SM' });
    expect(res.headers['set-cookie']![0]).toMatch(/^sid=.+HttpOnly; SameSite=Strict/);

    const db = registry.get('sharma-indore')!.db;
    expect((db.prepare(`SELECT name FROM centres WHERE id = 1`).get() as { name: string }).name).toBe('Sharma Motors');
    expect((db.prepare(`SELECT COUNT(*) n FROM bookings`).get() as { n: number }).n).toBeGreaterThan(10);
    // The sample calls greet with this centre's name, not the template's.
    const greetings = db.prepare(`SELECT text FROM transcripts WHERE turn_index = 0`).all() as { text: string }[];
    expect(greetings.length).toBeGreaterThan(0);
    expect(greetings.every((g) => g.text.startsWith('Sharma Motors.'))).toBe(true);
    // And the essentials form, so saving it later keeps the name.
    const profile = db.prepare(`SELECT json_extract(data, '$.name') AS name FROM centre_profile`).get() as { name: string };
    expect(profile.name).toBe('Sharma Motors');
  });

  it('refuses a taken user ID, a short password and a bad user ID', async () => {
    await signup('Sharma Motors', 'sharma').expect(201);
    expect((await signup('Other', 'SHARMA').expect(409)).body.kind).toBe('taken');
    await signup('Other', 'other', 'short').expect(400);
    await signup('Other', 'has spaces').expect(400);
    await signup('X', 'other').expect(400);
  });
});

describe('sign-in', () => {
  beforeEach(async () => {
    await signup('Sharma Motors', 'sharma');
  });

  it('sets a 12-hour cookie that opens the portal', async () => {
    const res = await request(app).post('/auth/login').send({ userId: 'Sharma', password: PASSWORD }).expect(200);
    expect(res.headers['set-cookie']![0]).toContain('Max-Age=43200');
    const me = await request(app).get('/auth/me').set('cookie', cookieFrom(res)).expect(200);
    expect(me.body).toMatchObject({ userId: 'sharma', name: 'Sharma Motors' });
    await request(app).get('/api/summary').set('cookie', cookieFrom(res)).expect(200);
  });

  it('refuses a wrong password, and the portal without a sign-in', async () => {
    await request(app).post('/auth/login').send({ userId: 'sharma', password: 'nope-nope-nope' }).expect(401);
    await request(app).post('/auth/login').send({ userId: 'nobody', password: PASSWORD }).expect(401);
    await request(app).get('/api/summary').expect(401);
    await request(app).post('/api/chat/start').send({ callerNumber: '9810011001' }).expect(401);
  });

  it('refuses a tampered or expired cookie', async () => {
    const org = accounts.get('sharma')!;
    const key = accounts.secret('');
    const good = signSession(org, key).value;
    expect(readSession(good, accounts, key)?.slug).toBe('sharma');
    expect(readSession(good.replace('sharma', 'other'), accounts, key)).toBeUndefined();
    expect(readSession(`${good}x`, accounts, key)).toBeUndefined();
    const old = signSession(org, key, Date.now() - 13 * 3_600_000).value;
    expect(readSession(old, accounts, key)).toBeUndefined();
    await request(app).get('/api/summary').set('cookie', `sid=${good}x`).expect(401);
  });

  it('signs every device out when the password changes', async () => {
    const res = await request(app).post('/auth/login').send({ userId: 'sharma', password: PASSWORD });
    accounts.setPassword('sharma', 'a-new-password');
    await request(app).get('/api/summary').set('cookie', cookieFrom(res)).expect(401);
  });

  it('accepts Basic auth for scripts', async () => {
    const basic = `Basic ${Buffer.from(`sharma:${PASSWORD}`).toString('base64')}`;
    await request(app).get('/api/summary').set('authorization', basic).expect(200);
    const wrong = `Basic ${Buffer.from('sharma:wrong-one').toString('base64')}`;
    await request(app).get('/api/summary').set('authorization', wrong).expect(401);
  });

  it('signs out', async () => {
    const res = await request(app).post('/auth/logout').expect(200);
    expect(res.headers['set-cookie']![0]).toContain('Max-Age=0');
  });
});

describe('isolation', () => {
  it('keeps one centre’s bookings out of another’s portal', async () => {
    const a = cookieFrom(await signup('Centre A', 'centre-a').expect(201));
    const b = cookieFrom(await signup('Centre B', 'centre-b').expect(201));

    const vehicle = (await request(app).get('/api/vehicles').set('cookie', a)).body.find(
      (v: { registration_number: string }) => v.registration_number === 'HR26AB4471',
    );
    const made = await request(app)
      .post('/api/bookings')
      .set('cookie', a)
      .send({ vehicleId: vehicle.id, pool: 'major', bookingDate: addDays(today(), 7), dropSlot: 'morning' })
      .expect(201);

    const inA = await request(app).get(`/api/day?date=${addDays(today(), 7)}`).set('cookie', a);
    const inB = await request(app).get(`/api/day?date=${addDays(today(), 7)}`).set('cookie', b);
    const refs = (r: request.Response) => r.body.bookings.map((x: { reference: string }) => x.reference);
    expect(refs(inA)).toContain(made.body.reference);
    expect(refs(inB)).not.toContain(made.body.reference);
    expect((await request(app).get('/auth/me').set('cookie', b)).body.name).toBe('Centre B');
  });
});

describe('the daily turn cap', () => {
  it('stops the agent, not the portal, once a centre has used its turns', async () => {
    vi.spyOn(config, 'orgDailyTurns', 'get' as never).mockReturnValue(2 as never);
    const c = cookieFrom(await signup('Capped', 'capped').expect(201));
    // The sample conversations already used some of today's turns.
    const start = await request(app).post('/api/chat/start').set('cookie', c).send({ callerNumber: '9810011001' }).expect(200);
    const res = await request(app)
      .post('/api/chat/turn')
      .set('cookie', c)
      .send({ sessionId: start.body.sessionId, utterance: 'yes' })
      .expect(429);
    expect(res.body.kind).toBe('daily_cap');
    await request(app).get('/api/summary').set('cookie', c).expect(200);
  });
});

describe('the voice endpoints', () => {
  it('reach the centre named by x-org, behind the call secret', async () => {
    vi.spyOn(config, 'callApiSecret', 'get' as never).mockReturnValue('s3cret' as never);
    await signup('Voice Centre', 'voice').expect(201);
    await request(app).post('/call/start').set('x-org', 'voice').send({ callerNumber: '9810011001' }).expect(401);
    const ok = await request(app)
      .post('/call/start')
      .set('x-org', 'voice')
      .set('authorization', 'Bearer s3cret')
      .send({ callerNumber: '9810011001' })
      .expect(200);
    expect(ok.body.reply).toContain('Voice Centre');
    await request(app)
      .post('/call/start')
      .set('x-org', 'nowhere')
      .set('authorization', 'Bearer s3cret')
      .send({ callerNumber: '9810011001' })
      .expect(404);
  });
});

describe('moving the old single database in', () => {
  it('copies it as the first centre once, keeps the original, and signs in with the old password', () => {
    const legacy = join(dir, 'service.db');
    seed({ dbPath: legacy });
    const d = open(legacy);
    d.prepare(`UPDATE customers SET name = 'Live Customer' WHERE id = 1`).run();
    d.close();

    expect(accounts.adoptLegacy(legacy, { slug: 'voltas', password: 'old-admin-pass' })).toBe('adopted');
    expect(existsSync(legacy)).toBe(true);
    expect(accounts.verify('voltas', 'old-admin-pass')?.name).toContain('Sector 44');
    const h = registry.get('voltas')!;
    expect((h.db.prepare(`SELECT name FROM customers WHERE id = 1`).get() as { name: string }).name).toBe('Live Customer');
    // The follow-up columns were added to the copy.
    const cols = (h.db.prepare(`PRAGMA table_info(leads)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['status', 'outcome', 'team', 'closed_by', 'closed_at', 'note']));

    expect(accounts.adoptLegacy(legacy, { slug: 'voltas', password: 'old-admin-pass' })).toBe('skipped');
  });

  it('does nothing without a password or a database', () => {
    expect(accounts.adoptLegacy(join(dir, 'missing.db'), { slug: 'voltas', password: 'x' })).toBe('skipped');
    expect(accounts.list()).toHaveLength(0);
  });
});
