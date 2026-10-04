import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type express from 'express';
import { Accounts } from '../src/orgs/accounts.ts';
import { Registry } from '../src/orgs/registry.ts';
import { buildApp } from '../src/dealer/app.ts';
import { StubClassifier } from '../src/call/classifier.ts';
import { LocalCrm } from '../src/call/crm.ts';
import { callIdentity, DAILY_CAP_LINE, GOODBYE } from '../src/call/vapi.ts';
import { assistantPayload } from '../src/tools/vapi-setup.ts';
import { printCalls } from '../src/tools/calls.ts';
import { config } from '../src/config.ts';

/**
 * The public "Talk to the agent" page and the voice line behind it. Offline:
 * the stub classifier, and Vapi's requests made by hand in the shapes it sends.
 */

const SECRET = 's3cret';
let dir: string;
let accounts: Accounts;
let registry: Registry;
let app: express.Express;

beforeEach(() => {
  vi.spyOn(config, 'callApiSecret', 'get' as never).mockReturnValue(SECRET as never);
  dir = mkdtempSync(join(tmpdir(), 'svc-public-'));
  accounts = new Accounts(dir);
  registry = new Registry(accounts, (db) => ({ classifier: new StubClassifier(), crm: new LocalCrm(db) }));
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

const bookings = (slug: string) =>
  (registry.get(slug)!.db.prepare(`SELECT COUNT(*) n FROM bookings WHERE source = 'ai'`).get() as { n: number }).n;

describe('the page’s data', () => {
  it('shows the centre and its sample callers, and nothing private', async () => {
    const res = await request(app).get('/public/centre-a').expect(200);
    expect(res.body).toMatchObject({ slug: 'centre-a', name: 'Centre A', opens: '09:00', closes: '19:00' });
    expect(res.body.address).toContain('Sector 44');
    expect(res.body.callers.length).toBeGreaterThanOrEqual(5);
    expect(res.body.callers[0]).toMatchObject({ name: 'Rohit Sharma', model: 'Nexon', mobile: '9810011001' });
    // Only the samples: the sample fleet's dozens of customers are not listed.
    expect(res.body.callers.length).toBeLessThanOrEqual(6);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/password|pw_hash|secret|booking_reference/i);
  });

  it('offers Vapi only when the server has it set up', async () => {
    expect((await request(app).get('/public/centre-a')).body.voice).toEqual({ provider: 'browser' });
    vi.spyOn(config, 'vapiPublicKey', 'get' as never).mockReturnValue('pk_public' as never);
    vi.spyOn(config, 'vapiAssistantId', 'get' as never).mockReturnValue('asst_1' as never);
    expect((await request(app).get('/public/centre-a')).body.voice).toEqual({ provider: 'vapi', publicKey: 'pk_public', assistantId: 'asst_1' });
  });

  it('says not found for a centre that does not exist', async () => {
    await request(app).get('/public/nowhere').expect(404);
    await request(app).get('/public/..%2Fetc').expect(404);
  });
});

describe('the typed and browser-voice conversation', () => {
  const say = (slug: string, sessionId: string, utterance: string) =>
    request(app).post(`/public/${slug}/chat/turn`).send({ sessionId, utterance }).expect(200);

  it('books end to end, and the booking lands on that centre only', async () => {
    const start = await request(app).post('/public/centre-a/chat/start').send({ callerNumber: '9810011001' }).expect(200);
    expect(start.body.reply).toContain('Centre A');
    for (const line of ['Yes.', 'Book the Nexon in for Friday.', "No, it's fine.", 'No.', 'Morning.', 'Yes.']) {
      await say('centre-a', start.body.sessionId, line);
    }
    expect(bookings('centre-a')).toBeGreaterThan(bookings('centre-b'));
  });

  it('keeps one centre’s conversation out of another’s page', async () => {
    const start = await request(app).post('/public/centre-a/chat/start').send({ callerNumber: '9810011001' }).expect(200);
    await request(app).post('/public/centre-b/chat/turn').send({ sessionId: start.body.sessionId, utterance: 'Yes.' }).expect(404);
  });

  it('takes only the sample callers when the server is not in demo mode', async () => {
    vi.spyOn(config, 'demoMode', 'get' as never).mockReturnValue(false as never);
    await request(app).post('/public/centre-a/chat/start').send({ callerNumber: '9876543210' }).expect(403);
    await request(app).post('/public/centre-a/chat/start').send({ callerNumber: '9810011001' }).expect(200);
  });

  it('stops at the centre’s daily cap', async () => {
    vi.spyOn(config, 'orgDailyTurns', 'get' as never).mockReturnValue(1 as never);
    const start = await request(app).post('/public/centre-a/chat/start').send({ callerNumber: '9810011001' }).expect(200);
    const res = await request(app).post('/public/centre-a/chat/turn').send({ sessionId: start.body.sessionId, utterance: 'Yes.' }).expect(429);
    expect(res.body.kind).toBe('daily_cap');
  });
});

describe('the Vapi web call', () => {
  /** What the assistant's system message reads once Vapi fills in the page's variables. */
  const system = (org: string, caller: string) => ({ role: 'system', content: `svc-agent org=${org} caller=${caller}` });
  const vapi = (callId: string, messages: unknown[], extra: Record<string, unknown> = {}) =>
    request(app)
      .post('/vapi/chat/completions')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ stream: false, call: { id: callId }, messages, ...extra });
  const reply = (r: request.Response) => r.body.choices[0].message.content as string;

  it('reads the centre and caller from the variables, wherever Vapi puts them', () => {
    expect(callIdentity({ messages: [system('centre-b', '9810011001')] })).toEqual({ org: 'centre-b', callerNumber: '9810011001' });
    expect(callIdentity({ call: { assistantOverrides: { variableValues: { org: 'centre-b', callerNumber: '+91 98100 11001' } } } })).toEqual({
      org: 'centre-b',
      callerNumber: '9810011001',
    });
    expect(callIdentity({ metadata: { org: 'centre-b' } })).toEqual({ org: 'centre-b' });
    // An unfilled template, or junk, is no identity at all.
    expect(callIdentity({ messages: [{ role: 'system', content: 'svc-agent org={{org}} caller={{callerNumber}}' }] })).toEqual({});
    expect(callIdentity({ metadata: { org: '../../etc' } })).toEqual({});
  });

  it('greets as the centre the page named, and books there', async () => {
    const msgs = [system('centre-b', '9810011001')];
    const open = await vapi('web-1', msgs).expect(200);
    expect(reply(open)).toContain('Centre B');
    for (const line of ['Yes.', 'Book the Nexon in for Friday.', "No, it's fine.", 'No.']) {
      msgs.push({ role: 'user', content: line });
      await vapi('web-1', msgs).expect(200);
    }
    for (const line of ['Morning.', 'Yes.']) {
      msgs.push({ role: 'user', content: line });
      // Booked, but not over: the caller is asked if there's anything else.
      expect(reply(await vapi('web-1', msgs).expect(200))).not.toContain(GOODBYE);
    }
    msgs.push({ role: 'user', content: "No, that's all, thanks." });
    const last = await vapi('web-1', msgs).expect(200);
    // The finished call ends with the word the assistant hangs up on.
    expect(reply(last).endsWith(GOODBYE)).toBe(true);
    expect(bookings('centre-b')).toBeGreaterThan(bookings('centre-a'));
  });

  it('only says goodbye when the conversation is over', async () => {
    const msgs = [system('centre-a', '9810011001')];
    expect(reply(await vapi('web-2', msgs))).not.toContain(GOODBYE);
    msgs.push({ role: 'user', content: 'Yes.' });
    expect(reply(await vapi('web-2', msgs))).not.toContain(GOODBYE);
  });

  it('speaks the daily cap rather than going silent', async () => {
    vi.spyOn(config, 'orgDailyTurns', 'get' as never).mockReturnValue(1 as never);
    const res = await vapi('web-3', [system('centre-a', '9810011001')]).expect(200);
    expect(reply(res)).toBe(`${DAILY_CAP_LINE} ${GOODBYE}`);
  });

  it('refuses a call naming a centre that does not exist, and any call without the secret', async () => {
    await vapi('web-4', [system('nowhere', '9810011001')]).expect(404);
    await request(app).post('/vapi/chat/completions').send({ call: { id: 'x' }, messages: [] }).expect(401);
  });
});

describe('vapi:setup', () => {
  it('points the assistant at this site, carries the variables, and speaks Indian English', () => {
    const p = assistantPayload({ publicUrl: 'https://example.sslip.io/', callSecret: 'cs' });
    expect(p.model).toMatchObject({ provider: 'custom-llm', url: 'https://example.sslip.io/vapi' });
    expect(p.model.messages[0]!.content).toBe('svc-agent org={{org}} caller={{callerNumber}}');
    expect(callIdentity({ messages: [{ role: 'system', content: p.model.messages[0]!.content.replace('{{org}}', 'centre-a').replace('{{callerNumber}}', '9810011001') }] })).toEqual({
      org: 'centre-a',
      callerNumber: '9810011001',
    });
    expect(p.credentials).toEqual([{ provider: 'custom-llm', apiKey: 'cs' }]);
    expect(p.transcriber).toMatchObject({ language: 'en-IN' });
    expect(p.firstMessageMode).toBe('assistant-speaks-first-with-model-generated-message');
    expect(p.endCallPhrases).toEqual(['goodbye']);
    expect(p.maxDurationSeconds).toBeLessThanOrEqual(600);
    // Tuned after the first live call: hard to interrupt by accident, patient before replying, car names known.
    expect(p.stopSpeakingPlan.numWords).toBeGreaterThanOrEqual(2);
    expect(p.startSpeakingPlan.waitSeconds).toBeGreaterThanOrEqual(0.5);
    expect(p.transcriber.keyterm).toEqual(expect.arrayContaining(['Nexon', 'Friday', 'morning']));
    expect(p.backgroundSpeechDenoisingPlan.smartDenoisingPlan.enabled).toBe(true);
  });
});

describe('why a call ended (Vapi end-of-call report)', () => {
  const report = (callId: string, extra: Record<string, unknown> = {}) => ({
    message: {
      type: 'end-of-call-report',
      endedReason: 'customer-ended-call',
      durationSeconds: 94.6,
      call: { id: callId, assistantOverrides: { variableValues: { org: 'centre-b', callerNumber: '9810011001' } } },
      ...extra,
    },
  });

  it('logs the reason, keeps it on the call, and closes a call left open', async () => {
    // A call that stopped mid-way: the caller hung up at the readback.
    await request(app)
      .post('/vapi/chat/completions')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ stream: false, call: { id: 'end-1' }, messages: [{ role: 'system', content: 'svc-agent org=centre-b caller=9810011001' }] })
      .expect(200);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await request(app).post('/vapi/events').set('x-vapi-secret', SECRET).send(report('end-1')).expect(200);
    expect(log.mock.calls.flat().join('\n')).toMatch(/vapi end\s+end-1 → Centre B: customer-ended-call, 95s/);

    const s = registry.get('centre-b')!.db
      .prepare(`SELECT state, ended_at, json_extract(data, '$.endedReason') r, json_extract(data, '$.durationSeconds') d
                FROM sessions WHERE json_extract(data, '$.externalId') = 'end-1'`)
      .get() as { state: string; ended_at: string | null; r: string; d: number };
    expect(s).toMatchObject({ state: 'ended', r: 'customer-ended-call', d: 95 });
    expect(s.ended_at).toBeTruthy();
  });

  it('ignores other server messages, and refuses anyone without the secret', async () => {
    await request(app).post('/vapi/events').set('x-vapi-secret', SECRET).send({ message: { type: 'status-update' } }).expect(200);
    await request(app).post('/vapi/events').send(report('end-2')).expect(401);
    await request(app).post('/vapi/events').set('x-vapi-secret', 'wrong').send(report('end-2')).expect(401);
  });

  it('is set up by vapi:setup, with more patience before answering', () => {
    const p = assistantPayload({ publicUrl: 'https://example.sslip.io/', callSecret: 'cs' });
    expect(p.server).toEqual({ url: 'https://example.sslip.io/vapi/events', secret: 'cs' });
    expect(p.serverMessages).toEqual(['end-of-call-report']);
    expect(p.startSpeakingPlan.waitSeconds).toBe(0.8);
    expect(p.silenceTimeoutSeconds).toBe(30);
  });

  it('npm run calls prints the call back, with how it ended', async () => {
    await request(app)
      .post('/vapi/chat/completions')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ stream: false, call: { id: 'end-3' }, messages: [{ role: 'system', content: 'svc-agent org=centre-b caller=9810011001' }] })
      .expect(200);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await request(app).post('/vapi/events').set('x-vapi-secret', SECRET).send(report('end-3', { endedReason: 'silence-timed-out' })).expect(200);
    const lines: string[] = [];
    expect(printCalls(accounts.orgPath('centre-b'), 1, {}, (l) => lines.push(l))).toBe(1);
    const text = lines.join('\n');
    expect(text).toMatch(/stopped at "greeting" · line closed: silence-timed-out · 95s|no booking · line closed: silence-timed-out · 95s/);
    expect(text).toMatch(/agent  Hi, Centre B/);
  });
});
