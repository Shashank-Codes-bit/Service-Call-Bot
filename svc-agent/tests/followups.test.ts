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
import { csvCell, CSV_COLUMNS, formatWait } from '../src/dealer/followups.ts';
import { today } from '../src/shared/dates.ts';

/** The follow-up queue over the seeded week: 26 leads, 9 still open. */

const NOW = new Date();
const TODAY = today(NOW);
let scratch: string;
let db: Database.Database;
let app: express.Express;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'svc-fu-'));
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

const get = (q = '') => request(app).get(`/api/followups${q}`).expect(200);
const n = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

describe('the seeded week', () => {
  it('has the counts every view agrees on', async () => {
    const res = await get('?status=open&when=all');
    expect(res.body.total).toBe(9);
    expect(res.body.openTotal).toBe(9);
    expect(n(`SELECT COUNT(*) n FROM leads`)).toBe(26);
    const open = res.body.teams.reduce((s: number, t: { open: number }) => s + t.open, 0);
    expect(open).toBe(9);
    expect(res.body.week.total).toBe(26);
    expect(res.body.week.closed).toBe(17);
    expect(res.body.week.booked).toBeGreaterThan(0);
    expect(res.body.week.medianWaitMin).toBeGreaterThan(0);
  });
});

describe('filters and paging', () => {
  it('pages ten at a time, oldest first by default', async () => {
    const first = await get('?status=all&when=all');
    expect(first.body.rows).toHaveLength(10);
    expect(first.body.total).toBe(26);
    const created = first.body.rows.map((r: { created_at: string }) => r.created_at);
    expect([...created].sort()).toEqual(created);
    const next = await get('?status=all&when=all&offset=20');
    expect(next.body.rows).toHaveLength(6);
    const newest = await get('?status=all&when=all&sort=newest');
    expect(newest.body.rows[0].created_at >= newest.body.rows[1].created_at).toBe(true);
  });

  it('filters by status, day, team and search', async () => {
    expect((await get('?status=open&when=today')).body.total).toBe(7);
    expect((await get('?status=open&when=yesterday')).body.total).toBe(2);
    expect((await get('?status=done&when=7d')).body.total).toBe(17);
    const care = await get('?status=all&teams=customer-care');
    expect(care.body.rows.every((r: { team: string }) => r.team === 'customer-care')).toBe(true);
    const two = await get('?status=all&teams=customer-care,reception');
    expect(two.body.total).toBeGreaterThan(care.body.total);
    const byPlate = await get('?status=all&q=gj01 tu');
    expect(byPlate.body.rows.every((r: { vehicle_registration: string }) => r.vehicle_registration === 'GJ01TU2255')).toBe(true);
    expect(byPlate.body.total).toBeGreaterThan(0);
    expect((await get('?status=all&q=98100')).body.total).toBeGreaterThan(0);
  });

  it('shows a person what the reason means', async () => {
    const res = await get('?status=all&when=all&limit=100');
    const labels = res.body.rows.map((r: { reason_label: string }) => r.reason_label);
    expect(labels).toContain('Free service lapsed (over 60 days)');
    expect(labels).toContain('Free service with no due date');
    expect(labels).toContain('Service type missing in the CRM');
  });
});

describe('working the queue', () => {
  const firstOpen = async () => (await get('?status=open')).body.rows[0] as { id: number; team: string };

  it('closes with an outcome and a note, then reopens', async () => {
    const l = await firstOpen();
    await request(app)
      .patch(`/api/followups/${l.id}`)
      .send({ close: { outcome: 'booked', note: 'Booked Tue 8:30' }, by: 'Ritu' })
      .expect(200);
    const row = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(l.id) as Record<string, string>;
    expect(row).toMatchObject({ status: 'done', outcome: 'booked', note: 'Booked Tue 8:30', closed_by: 'Ritu' });
    expect(row['closed_at']!.slice(0, 10)).toBe(TODAY);
    expect((await get('?status=open')).body.total).toBe(8);

    await request(app).patch(`/api/followups/${l.id}`).send({ reopen: true }).expect(200);
    const back = db.prepare(`SELECT status, outcome, closed_at FROM leads WHERE id = ?`).get(l.id);
    expect(back).toEqual({ status: 'open', outcome: null, closed_at: null });
  });

  it('reassigns, and the team follows it into the filters', async () => {
    const l = await firstOpen();
    const to = l.team === 'reception' ? 'retention' : 'reception';
    await request(app).patch(`/api/followups/${l.id}`).send({ team: to }).expect(200);
    const res = await get(`?status=open&teams=${to}`);
    expect(res.body.rows.map((r: { id: number }) => r.id)).toContain(l.id);
  });

  it('refuses a bad outcome, a bad team and an unknown follow-up', async () => {
    const l = await firstOpen();
    await request(app).patch(`/api/followups/${l.id}`).send({ close: { outcome: 'maybe' } }).expect(400);
    await request(app).patch(`/api/followups/${l.id}`).send({ team: 'marketing' }).expect(400);
    await request(app).patch(`/api/followups/99999`).send({ reopen: true }).expect(404);
  });

  it('closes and reassigns in bulk, in one go', async () => {
    const ids = (await get('?status=open&limit=3')).body.rows.map((r: { id: number }) => r.id);
    const res = await request(app)
      .post('/api/followups/bulk')
      .send({ ids, close: { outcome: 'no_answer' } })
      .expect(200);
    expect(res.body.changed).toBe(3);
    expect((await get('?status=open')).body.total).toBe(6);
    await request(app).post('/api/followups/bulk').send({ ids: [], team: 'reception' }).expect(400);
  });
});

describe('CSV', () => {
  it('downloads the filtered rows with the thirteen columns', async () => {
    const res = await request(app).get('/api/followups.csv?status=all&when=all').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="follow-ups-${TODAY}.csv"`);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(CSV_COLUMNS).toHaveLength(13);
    expect(lines).toHaveLength(27);
    const open = await request(app).get('/api/followups.csv?status=open').expect(200);
    expect(open.text.trim().split('\r\n')).toHaveLength(10);
  });

  it('exports only the selected rows when asked', async () => {
    const ids = (await get('?status=all&limit=2')).body.rows.map((r: { id: number }) => r.id);
    const res = await request(app).get(`/api/followups.csv?status=all&ids=${ids.join(',')}`).expect(200);
    expect(res.text.trim().split('\r\n')).toHaveLength(3);
  });

  it('quotes per RFC 4180 and defuses formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('she said "hi"')).toBe('"she said ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+91 98100')).toBe("'+91 98100");
    expect(csvCell(null)).toBe('');
    expect(formatWait(45)).toBe('45 m');
    expect(formatWait(130)).toBe('2 h 10 m');
    expect(formatWait(1500)).toBe('1 d 1 h');
  });
});

describe('the migration', () => {
  it('adds the follow-up columns to an old database and keeps its rows', () => {
    const path = join(scratch, 'old.db');
    const old = new Database(path);
    old.exec(`
      CREATE TABLE bookings (id INTEGER PRIMARY KEY, booking_reference TEXT);
      CREATE TABLE leads (id INTEGER PRIMARY KEY, mobile_number TEXT, reason TEXT, created_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at TEXT);
      INSERT INTO leads (mobile_number, reason, created_at) VALUES ('9810011001', 'another_problem', '2026-10-01');
    `);
    expect(migrate(old)).toBe(7);
    expect(migrate(old)).toBe(0);
    expect(old.prepare(`SELECT status, outcome FROM leads`).get()).toEqual({ status: 'open', outcome: null });
    old.close();
  });
});
