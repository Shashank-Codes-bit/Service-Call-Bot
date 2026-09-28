import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { redactUtterance, type ClassifyRequest } from '../src/call/classifier.ts';
import { HaikuClassifier, toClassification } from '../src/call/haiku-classifier.ts';

/**
 * Offline. No key, no network, no cost — so this runs in CI and on a laptop
 * without credentials. The live suite (`npm run test:live`) is the one that
 * proves comprehension; this one proves the contract.
 */

const REQ: ClassifyRequest = {
  state: 'open_turn',
  utterance: 'Rohit here, book the Nexon HR26AB4471 in for Friday.',
  today: '2026-09-14',
  vehicles: [{ model: 'Nexon', last4: '4471' }],
  redact: ['Rohit Sharma', 'HR26AB4471', 'Nexon', '9810011001'],
};

/** Captures the outgoing request body, then fails the call deliberately. */
function capturing() {
  const seen: string[] = [];
  const client = new Anthropic({
    apiKey: 'test-key-not-real',
    maxRetries: 0,
    fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(init?.body ?? ''));
      // We only care about what went out; the response never matters here.
      return new Response(JSON.stringify({ error: { message: 'stop' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { seen, classifier: new HaikuClassifier({ client }) };
}

describe('B3 — redaction is asserted on the wire, not trusted', () => {
  it('sends none of the identifiers we already hold', async () => {
    const { seen, classifier } = capturing();
    await classifier.classify(REQ).catch(() => undefined);

    expect(seen).toHaveLength(1);
    const body = seen[0]!;
    // These are the four things we hold about this caller. Not one of them may
    // appear in the payload, whatever the caller happened to say.
    expect(body).not.toContain('Rohit Sharma');
    expect(body).not.toContain('HR26AB4471');
    expect(body).not.toContain('9810011001');
    // The utterance still went, with the identifiers removed.
    expect(body).toContain('redacted');
    expect(body).toContain('Friday');
  });

  it('redacts case-insensitively and leaves the rest of the sentence intact', () => {
    const out = redactUtterance('my NEXON, reg hr26ab4471, is rattling', ['Nexon', 'HR26AB4471']);
    expect(out.toLowerCase()).not.toContain('nexon');
    expect(out.toLowerCase()).not.toContain('hr26ab4471');
    expect(out).toContain('rattling');
  });

  it('leaves a short term alone rather than shredding the sentence', () => {
    // A two-character "identifier" would redact half the alphabet.
    expect(redactUtterance('i20 is due', ['i2'])).toBe('i20 is due');
  });
});

describe('the candidate set is closed', () => {
  it("offers only this caller's own vehicles as options", async () => {
    const { seen, classifier } = capturing();
    await classifier
      .classify({ ...REQ, vehicles: [{ model: 'Swift', last4: '2213' }] })
      .catch(() => undefined);

    const body = seen[0]!;
    expect(body).toContain('Swift');
    // The model cannot return a car they do not own, because it is not offered.
    expect(body).not.toContain('Creta');
  });

  it('survives an account with no vehicles yet', async () => {
    const { seen, classifier } = capturing();
    await classifier.classify({ ...REQ, state: 'greeting', vehicles: [] }).catch(() => undefined);
    expect(seen).toHaveLength(1);
  });
});

describe('G7 — one call per turn', () => {
  it('makes exactly one request per classify', async () => {
    const { seen, classifier } = capturing();
    for (let i = 0; i < 5; i++) await classifier.classify(REQ).catch(() => undefined);
    expect(seen).toHaveLength(5);
    expect(classifier.calls).toBe(5);
  });

  it('sends an identical system prompt every turn, so the prefix can cache', async () => {
    const { seen, classifier } = capturing();
    await classifier.classify({ ...REQ, state: 'day' }).catch(() => undefined);
    await classifier.classify({ ...REQ, state: 'complaint' }).catch(() => undefined);

    const systems = seen.map((b) => JSON.parse(b).system);
    expect(systems[0]).toBe(systems[1]);
    // The volatile part rides in the user message, after the breakpoint.
    expect(JSON.parse(seen[0]!).messages[0].content).not.toBe(
      JSON.parse(seen[1]!).messages[0].content,
    );
  });

  it('asks for no thinking and a small budget — this is the latency path', async () => {
    const { seen, classifier } = capturing();
    await classifier.classify(REQ).catch(() => undefined);
    const body = JSON.parse(seen[0]!);
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(256);
    expect(body.model).toBe('claude-haiku-4-5');
  });
});

describe('mapping the model answer onto the machine contract', () => {
  const base = { ...REQ, utterance: 'whatever' };

  it('treats a cost question as out-of-band and stops there', () => {
    const c = toClassification(base, { out_of_band: 'cost', intent: 'book', date: '2026-09-18' });
    expect(c.outOfBand).toBe('cost');
    // Nothing else is acted on — the turn is answered, then resumed.
    expect(c.intent).toBeUndefined();
    expect(c.day).toBeUndefined();
  });

  it('treats a general question as out-of-band', () => {
    const c = toClassification(base, { out_of_band: 'general' });
    expect(c.outOfBand).toBe('general');
    expect(c.generalQuestion).toBe('whatever');
  });

  it('escalates a breakdown ahead of anything else in the sentence', () => {
    const c = toClassification(base, { out_of_band: 'none', escalation: true, intent: 'book' });
    expect(c.intent).toBe('another_problem');
  });

  it('accepts a resolved date but never a malformed one', () => {
    expect(toClassification(base, { date: '2026-09-18' }).day).toBe('2026-09-18');
    for (const bad of ['next Friday', '18/09/2026', '', 'soon']) {
      expect(toClassification(base, { date: bad }).day).toBeUndefined();
    }
  });

  it('ignores a "none" vehicle and a non-four-digit last4', () => {
    expect(toClassification(base, { model: 'none', last4: '' }).vehicleModel).toBeUndefined();
    expect(toClassification(base, { model: 'Nexon', last4: '44' }).vehicleLast4).toBeUndefined();
    expect(toClassification(base, { model: 'Nexon', last4: '4471' })).toMatchObject({
      vehicleModel: 'Nexon',
      vehicleLast4: '4471',
    });
  });

  it('keeps complaint and special request apart (D8)', () => {
    expect(toClassification(base, { kind: 'complaint', text: 'grinding noise' }).complaint).toBe(
      'grinding noise',
    );
    expect(
      toClassification(base, { kind: 'special_request', text: 'a wash' }).specialRequest,
    ).toBe('a wash');
    expect(toClassification(base, { kind: 'nothing', text: '' }).nothing).toBe(true);
  });

  it('maps yes/no but not "unclear"', () => {
    expect(toClassification(base, { answer: 'yes' }).yesNo).toBe('yes');
    expect(toClassification(base, { answer: 'no' }).yesNo).toBe('no');
    expect(toClassification(base, { answer: 'unclear' }).yesNo).toBeUndefined();
  });

  it('always carries the caller\'s raw words for the lead (F2)', () => {
    // Unredacted here on purpose: the lead is ours, and the dealer needs what
    // was actually said. Only the LLM gets the redacted copy.
    const c = toClassification({ ...base, utterance: 'Rohit here, the Nexon' }, {});
    expect(c.callerWords).toBe('Rohit here, the Nexon');
  });

  it('degrades to an empty classification rather than throwing on a null parse', () => {
    expect(() => toClassification(base, {})).not.toThrow();
  });
});
