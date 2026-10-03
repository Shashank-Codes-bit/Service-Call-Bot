import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { open } from '../src/db/index.ts';
import { seed } from '../src/db/seed.ts';
import { migrate } from '../src/db/migrate.ts';
import { api } from '../src/dealer/api.ts';
import { StubClassifier } from '../src/call/classifier.ts';
import { LocalCrm } from '../src/call/crm.ts';
import { handleTurn, startCall, type CallDeps } from '../src/call/machine.ts';
import { TableKnowledgeBank, SHORTLIST_SIZE } from '../src/kb/index.ts';
import { createKnowledge, spokenTime } from '../src/kb/knowledge.ts';
import { addDays, today } from '../src/shared/dates.ts';

/**
 * The Knowledge page and the agent reading it. The point of the design is
 * that there is no update step: a save is what the very next turn hears.
 * Offline throughout — the stub classifier.
 */

const NOW = new Date();
const TODAY = today(NOW);
let scratch: string;
let db: Database.Database;
let app: express.Express;
let deps: CallDeps;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'svc-know-'));
  seed({ now: NOW, dbPath: join(scratch, 'test.db') });
  db = open(join(scratch, 'test.db'));
  deps = { classifier: new StubClassifier(), crm: new LocalCrm(db), kb: new TableKnowledgeBank(db) };
  app = express();
  app.use(express.json());
  app.use('/api', api(db, { deps }));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A call already in progress, at the "anything wrong with the car?" question. */
async function liveCall() {
  const first = await startCall(db, '9810011001', NOW);
  await handleTurn(db, deps, first.sessionId, 'Yes.', NOW);
  await handleTurn(db, deps, first.sessionId, 'Nexon service Friday.', NOW);
  return (line: string) => handleTurn(db, deps, first.sessionId, line, NOW);
}

const add = (body: Record<string, unknown>) => request(app).post('/api/knowledge').send(body);
const nexonEv = {
  category: 'cars',
  title: 'Tata Nexon EV',
  answer: 'Yes, we service the Nexon EV, battery health check included.',
  phrases: 'nexon ev, electric nexon',
};

describe('no update step: the agent reads what was just saved', () => {
  it('answers an entry added during a call on the very next turn', async () => {
    const say = await liveCall();
    const before = await say('is the nexon ev something you work on?');
    expect(before.reply).toMatch(/passed/); // not known yet

    await add(nexonEv).expect(201);
    const after = await say('is the nexon ev something you work on?');
    expect(after.reply).toMatch(/battery health check included/);
    expect(after.ended).toBe(false);
    expect(after.state).toBe('complaint');
  });

  it('speaks an edit on the next turn, and stops after a removal', async () => {
    const { body } = await add(nexonEv).expect(201);
    const say = await liveCall();
    expect((await say('is the nexon ev something you work on?')).reply).toMatch(/battery health/);

    await request(app).put(`/api/knowledge/${body.id}`).send({ ...nexonEv, answer: 'Yes, and EV service takes three hours.' }).expect(200);
    expect((await say('is the nexon ev something you work on?')).reply).toMatch(/three hours/);

    await request(app).delete(`/api/knowledge/${body.id}`).expect(200);
    expect((await say('is the nexon ev something you work on?')).reply).toMatch(/passed/);
  });

  it('drops an offer after its last day, with nobody touching it', async () => {
    const kb = new TableKnowledgeBank(db);
    const monsoon = () => kb.shortlist('any monsoon offer?', TODAY).map((t) => t.title);
    expect(monsoon()).toContain('Monsoon check-up ₹499');
    expect(kb.shortlist('any free wash offer?', TODAY).map((t) => t.title)).not.toContain('Independence Day free wash');

    const until = addDays(TODAY, 28);
    expect(kb.shortlist('any monsoon offer?', until).map((t) => t.title)).toContain('Monsoon check-up ₹499');
    expect(kb.shortlist('any monsoon offer?', addDays(until, 1)).map((t) => t.title)).not.toContain('Monsoon check-up ₹499');
    expect(kb.answerFor('monsoon_check_up_rs_499', addDays(until, 1))).toBeUndefined();
  });
});

describe('the shortlist stays small as the bank grows', () => {
  it('finds the right entry by a customer phrase among sixty', () => {
    for (let i = 0; i < 60; i++) {
      createKnowledge(db, {
        category: i % 2 ? 'services' : 'cars',
        title: `Model ${i} package`,
        answer: `Details for item number ${i}.`,
        phrases: [`thing${i}`],
      });
    }
    const list = new TableKnowledgeBank(db).shortlist('do you service the curvv?', TODAY);
    const essentials = list.filter((t) => ['opening_hours', 'location'].includes(t.key));
    expect(essentials).toHaveLength(2);
    expect(list.length).toBeLessThanOrEqual(7 + SHORTLIST_SIZE);
    expect(list.map((t) => t.title)).toContain('Tata Curvv EV');
  });

  it('matches word forms, not just exact words', () => {
    const titles = new TableKnowledgeBank(db).shortlist('my car keeps pulling to one side', TODAY).map((t) => t.title);
    expect(titles).toContain('Wheel alignment');
  });
});

describe('the test panel tells the truth', () => {
  it('answers through the same code the call uses', async () => {
    const hit = await request(app).post('/api/knowledge/ask').send({ question: 'do you service the curvv?' }).expect(200);
    expect(hit.body).toMatchObject({ kind: 'answer', title: 'Tata Curvv EV' });
    expect(hit.body.answer).toMatch(/battery health check/);

    const miss = await request(app).post('/api/knowledge/ask').send({ question: 'do you handle insurance claims?' }).expect(200);
    expect(miss.body.kind).toBe('passed');

    const say = await liveCall();
    expect((await say('do you service the curvv?')).reply).toContain(hit.body.answer);
  });

  it('refuses an empty question', async () => {
    await request(app).post('/api/knowledge/ask').send({ question: '' }).expect(400);
  });
});

describe('editing', () => {
  it('lists every entry with its section and whether it has ended', async () => {
    const res = await request(app).get('/api/knowledge').expect(200);
    const byTitle = Object.fromEntries(res.body.entries.map((e: { title: string }) => [e.title, e]));
    expect(byTitle['Tata Curvv EV']).toMatchObject({ category: 'cars', expired: false });
    expect(byTitle['Independence Day free wash']).toMatchObject({ category: 'offers', expired: true });
    expect(byTitle['Opening hours']).toMatchObject({ category: 'essentials' });
    expect(res.body.saved).toBe(true);
    expect(res.body.essentials.address).toContain('Sector 44');
  });

  it('refuses bad input, and essentials outside their form', async () => {
    await add({ ...nexonEv, category: 'essentials' }).expect(400);
    await add({ ...nexonEv, title: 'x' }).expect(400);
    await add({ ...nexonEv, answer: 'hi' }).expect(400);
    await add({ ...nexonEv, validUntil: 'next week' }).expect(400);
    const opening = (await request(app).get('/api/knowledge')).body.entries.find((e: { key: string }) => e.key === 'opening_hours');
    await request(app).delete(`/api/knowledge/${opening.id}`).expect(400);
    await request(app).put(`/api/knowledge/999999`).send(nexonEv).expect(404);
  });

  it('gives each entry its own key, even with the same name', async () => {
    const a = await add(nexonEv).expect(201);
    const b = await add(nexonEv).expect(201);
    const keys = (await request(app).get('/api/knowledge')).body.entries
      .filter((e: { id: number }) => [a.body.id, b.body.id].includes(e.id))
      .map((e: { key: string }) => e.key);
    expect(keys.sort()).toEqual(['tata_nexon_ev', 'tata_nexon_ev_2']);
  });
});

describe('Centre essentials', () => {
  const form = async () => (await request(app).get('/api/knowledge')).body.essentials;

  it('rewrites what the agent says and the number every SMS carries', async () => {
    const e = await form();
    await request(app)
      .put('/api/knowledge/essentials')
      .send({ ...e, opens: '08:30', closes: '20:00', desk: '0124 999 0000', parking: '' })
      .expect(200);

    const say = await liveCall();
    expect((await say('what time do you open?')).reply).toMatch(/8:30 in the morning to 8 in the evening/);
    expect((await say('is there parking?')).reply).toMatch(/passed/); // emptied, so no answer
    const sms = db.prepare(`SELECT body FROM sms_log ORDER BY id DESC LIMIT 1`).get() as { body: string };
    expect(sms.body).toContain('01249990000');
  });

  it('renames the centre', async () => {
    await request(app).put('/api/knowledge/essentials').send({ ...(await form()), name: 'Auto Vikas' }).expect(200);
    expect((db.prepare(`SELECT name FROM centres WHERE id = 1`).get() as { name: string }).name).toBe('Auto Vikas');
  });

  it('refuses a form that would leave the agent wrong', async () => {
    const e = await form();
    await request(app).put('/api/knowledge/essentials').send({ ...e, opens: '19:00', closes: '09:00' }).expect(400);
    await request(app).put('/api/knowledge/essentials').send({ ...e, desk: '12' }).expect(400);
    await request(app).put('/api/knowledge/essentials').send({ ...e, address: '' }).expect(400);
  });

  it('speaks times the way people say them', () => {
    expect(spokenTime('09:00')).toBe('9 in the morning');
    expect(spokenTime('13:30')).toBe('1:30 in the afternoon');
    expect(spokenTime('19:00')).toBe('7 in the evening');
    expect(spokenTime('12:00')).toBe('noon');
  });
});

describe('the migration', () => {
  it('gives an old bank sections, titles and a search index, keeping its answers', () => {
    const path = join(scratch, 'old.db');
    const old = new Database(path);
    old.exec(`
      CREATE TABLE centres (id INTEGER PRIMARY KEY, name TEXT, landline TEXT, opens_at TEXT, closes_at TEXT);
      INSERT INTO centres VALUES (1, 'Old Centre', '01244567890', '09:00', '19:00');
      CREATE TABLE knowledge_bank (id INTEGER PRIMARY KEY, centre_id INTEGER, question_key TEXT, answer_text TEXT,
        UNIQUE (centre_id, question_key));
      INSERT INTO knowledge_bank (centre_id, question_key, answer_text) VALUES (1, 'loaner_car', 'Ask the advisor about a loaner.');
    `);
    migrate(old);
    migrate(old); // idempotent
    expect(old.prepare(`SELECT category, title FROM knowledge_bank`).get()).toEqual({ category: 'essentials', title: 'Loaner car' });
    const kb = new TableKnowledgeBank(old);
    expect(kb.shortlist('loaner?', TODAY).map((t) => t.key)).toContain('loaner_car');
    old.prepare(`INSERT INTO knowledge_bank (centre_id, question_key, answer_text, category, title, phrases)
                 VALUES (1, 'curvv', 'Yes.', 'cars', 'Tata Curvv', 'curvv')`).run();
    expect(kb.shortlist('do you do the curvv', TODAY).map((t) => t.key)).toContain('curvv');
    old.close();
  });
});
