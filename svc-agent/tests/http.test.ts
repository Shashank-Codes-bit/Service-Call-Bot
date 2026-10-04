import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Database } from 'better-sqlite3';
import { open } from '../src/db/index.ts';
import { seed } from '../src/db/seed.ts';
import { api } from '../src/dealer/api.ts';
import { callApi, sessionIdForExternal } from '../src/call/http.ts';
import { vapiApi } from '../src/call/vapi.ts';
import { requireCallSecret } from '../src/auth.ts';
import { StubClassifier } from '../src/call/classifier.ts';
import { LocalCrm } from '../src/call/crm.ts';
import { addDays, today } from '../src/shared/dates.ts';
import { config } from '../src/config.ts';

/**
 * The HTTP surface of the call, and the guards around every write.
 *
 * Offline throughout: the stub classifier, so this costs nothing and cannot
 * fail because a model had an opinion.
 */

const NOW = new Date();
const TODAY = today(NOW);
const SECRET = config.callApiSecret || 'test-secret';

let scratch: string;
let db: Database;
let app: express.Express;

beforeEach(() => {
  // The guards read config at request time, so tests can set them here.
  vi.spyOn(config, 'callApiSecret', 'get' as never).mockReturnValue(SECRET as never);

  scratch = mkdtempSync(join(tmpdir(), 'svc-http-'));
  seed({ now: NOW, dbPath: join(scratch, 'test.db') });
  db = open(join(scratch, 'test.db'));

  const deps = { classifier: new StubClassifier(), crm: new LocalCrm(db) };
  app = express();
  app.use(express.json());
  app.use('/api', api(db));
  app.use('/call', requireCallSecret, callApi(db, deps));
  app.use('/vapi', requireCallSecret, vapiApi(db, deps));
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const callAuth = (r: request.Test) => r.set('authorization', `Bearer ${SECRET}`);

describe('auth — the call endpoints', () => {
  // The portal's door is the centre's sign-in now (accounts.test.ts); the
  // router itself carries no password, so these reads and writes go straight in.
  it('serves the portal router to whoever mounted it', async () => {
    for (const path of ['/api/summary', '/api/capacity/master', '/api/day', '/api/followups']) {
      await request(app).get(path).expect(200);
    }
    await request(app).post('/api/capacity/regenerate').expect(200);
  });

  it('refuses the call endpoints without the secret', async () => {
    await request(app).post('/call/start').send({ callerNumber: '9810011001' }).expect(401);
    await request(app).post('/vapi/chat/completions').send({}).expect(401);
  });

  it('refuses a wrong secret', async () => {
    await request(app)
      .post('/call/start')
      .set('authorization', 'Bearer not-it')
      .send({ callerNumber: '9810011001' })
      .expect(401);
  });

  it('DISABLES rather than opens an endpoint whose secret is unconfigured', async () => {
    // The failure mode that matters: a deploy with no secret set must not
    // leave the call endpoints wide open. Unset is 503, never a pass-through.
    vi.spyOn(config, 'callApiSecret', 'get' as never).mockReturnValue('' as never);
    const res = await callAuth(request(app).post('/call/start'))
      .send({ callerNumber: '9810011001' })
      .expect(503);
    expect(res.body.kind).toBe('not_configured');
  });
});

describe('a whole call over HTTP', () => {
  it('books, turn by turn', async () => {
    const start = await callAuth(request(app).post('/call/start'))
      .send({ callerNumber: '9810011001' })
      .expect(200);

    expect(start.body.reply).toContain('automated booking assistant');
    const sessionId = start.body.sessionId as string;

    const say = (utterance: string) =>
      callAuth(request(app).post('/call/turn')).send({ sessionId, utterance }).expect(200);

    await say("Yeah, that's right.");
    await say('Book the Nexon in for Friday.');
    await say("No, it's fine.");
    await say('No.');
    const readback = await say('Morning.');
    expect(readback.body.reply).toMatch(/Shall I book it\?/);
    expect(readback.body.ended).toBe(false);
    const booked = await say('Yes.');
    expect(booked.body.ended).toBe(false);
    expect(booked.body.reply).toMatch(/Anything else/);
    const last = await say("No, that's all.");

    expect(last.body.ended).toBe(true);
    expect(last.body.bookingReference).toMatch(/^\d{6}-\d{5}$/);

    // And it is a real booking, not just a reply.
    const row = db
      .prepare(`SELECT source FROM bookings WHERE booking_reference = ?`)
      .get(last.body.bookingReference) as { source: string };
    expect(row.source).toBe('ai');
  });

  it('validates its inputs', async () => {
    await callAuth(request(app).post('/call/start')).send({ callerNumber: '123' }).expect(400);
    await callAuth(request(app).post('/call/turn')).send({ utterance: 'hi' }).expect(400);
    await callAuth(request(app).post('/call/turn'))
      .send({ sessionId: 'nope', utterance: 'hi' })
      .expect(404);
  });

  it('shows the conversation in the Calls view', async () => {
    const start = await callAuth(request(app).post('/call/start'))
      .send({ callerNumber: '9810011001' })
      .expect(200);
    await callAuth(request(app).post('/call/turn'))
      .send({ sessionId: start.body.sessionId, utterance: 'Yes.' })
      .expect(200);

    const res = await request(app).get(`/api/calls/${start.body.sessionId}`).expect(200);
    expect(res.body.transcript.length).toBeGreaterThan(2);
    expect(res.body.data.callerNumber).toBe('9810011001');
  });
});

describe('concurrency — two callers are two conversations', () => {
  it('keeps interleaved sessions separate', async () => {
    const a = (
      await callAuth(request(app).post('/call/start')).send({ callerNumber: '9810011001' })
    ).body.sessionId as string;
    const b = (
      await callAuth(request(app).post('/call/start')).send({ callerNumber: '9810044004' })
    ).body.sessionId as string;

    expect(a).not.toBe(b);

    const say = (sessionId: string, utterance: string) =>
      callAuth(request(app).post('/call/turn')).send({ sessionId, utterance });

    // Interleave every turn, so a shared mutable state bug would show.
    await say(a, 'Yes.');
    await say(b, 'Yes.');
    await say(a, 'Book the Nexon in for Friday.');
    await say(b, 'Book the i20 in for Friday.');

    const [sa, sb] = await Promise.all([
      request(app).get(`/api/calls/${a}`),
      request(app).get(`/api/calls/${b}`),
    ]);
    expect(sa.body.data.model).toBe('Nexon');
    expect(sb.body.data.model).toBe('i20');
    expect(sa.body.data.callerNumber).toBe('9810011001');
    expect(sb.body.data.callerNumber).toBe('9810044004');
  });
});

describe('the chat channel shows SMS only in demo mode', () => {
  // Chat has no phone, so on a demo centre the reply carries what the phone
  // would have got. Outside demo that would hand a one-time code to anyone who
  // typed a number, so it must not appear. The centre's demo switch is fixed
  // when its routers are built (registry.ts), so each case builds its own.
  const toOtp = async () => {
    const chat = express();
    chat.use(express.json());
    chat.use('/call', requireCallSecret, callApi(db, { classifier: new StubClassifier(), crm: new LocalCrm(db) }));
    const start = await callAuth(request(chat).post('/call/start')).send({ callerNumber: '9810011001' });
    const say = (utterance: string) =>
      callAuth(request(chat).post('/call/turn')).send({ sessionId: start.body.sessionId, utterance });
    await say('No, different number.');
    return say('9810044004');
  };

  it('returns the code the caller was sent, in demo mode', async () => {
    vi.spyOn(config, 'demoMode', 'get' as never).mockReturnValue(true as never);
    const res = await toOtp();
    expect(res.body.expectsDigits).toBe(true);
    expect(res.body.sms).toHaveLength(1);
    expect(res.body.sms[0]).toMatch(/verification code is \d{4}/);
  });

  it('never returns it otherwise', async () => {
    vi.spyOn(config, 'demoMode', 'get' as never).mockReturnValue(false as never);
    const res = await toOtp();
    expect(res.body).not.toHaveProperty('sms');
    expect(JSON.stringify(res.body)).not.toMatch(/verification code/);
  });
});

describe('the Vapi adapter', () => {
  const vapiTurn = (callId: string, text: string, history: unknown[] = []) =>
    callAuth(request(app).post('/vapi/chat/completions')).send({
      stream: false,
      call: { id: callId, customer: { number: '9810011001' } },
      messages: [...history, { role: 'user', content: text }],
    });

  it('opens a session on the first turn and reuses it after', async () => {
    const first = await vapiTurn('vapi-call-1', '').expect(200);
    expect(first.body.choices[0].message.content).toContain('automated booking assistant');

    const sessionId = sessionIdForExternal(db, 'vapi-call-1');
    expect(sessionId).toBeTruthy();

    await vapiTurn('vapi-call-1', 'Yes.').expect(200);
    // Still the same session — not a new one per turn.
    expect(sessionIdForExternal(db, 'vapi-call-1')).toBe(sessionId);
  });

  it('IGNORES the resent history and uses our own state', async () => {
    // Vapi replays the whole conversation every turn. If we read it, a retry
    // or a reordered history would rewind the call. Our session is the truth.
    await vapiTurn('vapi-call-2', '').expect(200);
    await vapiTurn('vapi-call-2', 'Yes.').expect(200);

    const before = sessionIdForExternal(db, 'vapi-call-2')!;
    const stateBefore = (
      db.prepare(`SELECT state FROM sessions WHERE id = ?`).get(before) as { state: string }
    ).state;

    // Resend the entire history, including the greeting, plus a new line.
    await vapiTurn('vapi-call-2', 'Book the Nexon in for Friday.', [
      { role: 'assistant', content: 'Voltas Motors Service…' },
      { role: 'user', content: 'Yes.' },
      { role: 'assistant', content: 'Okay, the Nexon then.' },
    ]).expect(200);

    const stateAfter = (
      db.prepare(`SELECT state FROM sessions WHERE id = ?`).get(before) as { state: string }
    ).state;
    // Advanced by exactly one turn, not rewound and not replayed.
    expect(stateBefore).toBe('open_turn');
    expect(stateAfter).toBe('complaint');
  });

  it('streams valid OpenAI SSE by default', async () => {
    const res = await callAuth(request(app).post('/vapi/chat/completions'))
      .send({ call: { id: 'vapi-sse', customer: { number: '9810011001' } }, messages: [] })
      .expect(200);

    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('chat.completion.chunk');
    expect(res.text.trimEnd().endsWith('data: [DONE]')).toBe(true);

    const payloads = res.text
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(6)));
    expect(payloads.at(-1)?.choices[0].finish_reason).toBe('stop');
    expect(payloads.map((p) => p.choices[0].delta.content ?? '').join('')).toContain(
      'automated booking assistant',
    );
  });

  it('refuses a request with no call id rather than inventing a session', async () => {
    await callAuth(request(app).post('/vapi/chat/completions'))
      .send({ messages: [{ role: 'user', content: 'hello' }] })
      .expect(400);
  });

  it('stays put on an empty turn instead of advancing on silence', async () => {
    await vapiTurn('vapi-quiet', '').expect(200);
    const id = sessionIdForExternal(db, 'vapi-quiet')!;
    const before = (db.prepare(`SELECT state FROM sessions WHERE id=?`).get(id) as { state: string }).state;
    await vapiTurn('vapi-quiet', '   ').expect(200);
    const after = (db.prepare(`SELECT state FROM sessions WHERE id=?`).get(id) as { state: string }).state;
    expect(after).toBe(before);
  });

  it('books end to end through the adapter', async () => {
    await vapiTurn('vapi-book', '').expect(200);
    for (const line of [
      'Yes.',
      'Book the Nexon in for Friday.',
      "No, it's fine.",
      'No.',
      'Morning.',
      'Yes.',
    ]) {
      await vapiTurn('vapi-book', line).expect(200);
    }
    const n = db
      .prepare(
        `SELECT COUNT(*) n FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
         WHERE b.source = 'ai' AND v.registration_number = 'HR26AB4471'`,
      )
      .get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe('the seeded window is still there for the call to book against', () => {
  it('has the bends where the machine tests expect them', async () => {
    const res = await request(app).get('/api/capacity/window?days=4').expect(200);
    const plus3 = (res.body as { date: string }[]).find((d) => d.date === addDays(TODAY, 3)) as
      | { pools: Record<string, Record<string, { free: number }>> }
      | undefined;
    expect(plus3?.pools['minor']!['morning']!.free).toBe(0);
  });
});
