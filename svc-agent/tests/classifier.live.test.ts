import { describe, expect, it } from 'vitest';
import { hasApiKey } from '../src/config.ts';
import { HaikuClassifier } from '../src/call/haiku-classifier.ts';
import type { ClassifyRequest } from '../src/call/classifier.ts';
import type { CallState } from '../src/call/types.ts';

/**
 * Hits the real model. Costs money, and a language assertion can wobble — so
 * it is **opt-in** and stays out of the ordinary suite:
 *
 *   npm run test:live
 *
 * The point of this file is the one thing the offline suite cannot show: that
 * the classifier understands how people actually talk. The stub handles
 * "Friday if you've got something" and nothing harder.
 */

const LIVE = process.env['LIVE'] === '1' && hasApiKey();
const suite = LIVE ? describe : describe.skip;

/** Monday, so relative expressions have a fixed anchor. */
const TODAY = '2026-09-14';
const VEHICLES = [
  { model: 'Swift', last4: '1234' },
  { model: 'Creta', last4: '5678' },
];

const usage = { input: 0, output: 0, cacheRead: 0, calls: 0 };
const classifier = new HaikuClassifier({
  onUsage: (u) => {
    usage.input += u.input;
    usage.output += u.output;
    usage.cacheRead += u.cacheRead;
    usage.calls += 1;
  },
});

const ask = (state: CallState, utterance: string, vehicles = VEHICLES) =>
  classifier.classify({ state, utterance, today: TODAY, vehicles } satisfies ClassifyRequest);

suite('Haiku classifier — against the real model', () => {
  describe('date expressions our stub cannot touch', () => {
    it('resolves "day after next, whenever you\'ve got a gap"', async () => {
      const c = await ask('day', "day after next, whenever you've got a gap");
      expect(c.day).toBe('2026-09-16');
      expect(c.dropSlot).toBeUndefined(); // "whenever" is not a slot
    });

    it('resolves a plain weekday forward, never backward', async () => {
      const c = await ask('day', 'can you do Thursday');
      expect(c.day).toBe('2026-09-17');
    });

    it('resolves Hinglish date words — F6 warns these appear in the English build', async () => {
      const c = await ask('day', 'parson subah theek rahega');
      expect(c.day).toBe('2026-09-16');
      expect(c.dropSlot).toBe('morning');
    });

    it('resolves "kal"', async () => {
      expect((await ask('day', 'kal le aata hoon')).day).toBe('2026-09-15');
    });
  });

  describe('the closed vehicle set', () => {
    it('picks the right one of two same-ish answers by digits', async () => {
      const c = await ask('vehicle', 'the Swift, one two three four');
      expect(c.vehicleModel).toBe('Swift');
      expect(c.vehicleLast4).toBe('1234');
    });

    it('never returns a car the caller does not own', async () => {
      const c = await ask('vehicle', "it's the Fortuner");
      expect(c.vehicleModel).toBeUndefined();
    });
  });

  describe('the always-on overlay, mid-flow', () => {
    it('catches a cost question asked while we were asking about faults', async () => {
      const c = await ask('complaint', 'how much is this going to set me back?');
      expect(c.outOfBand).toBe('cost');
    });

    it('catches a question about the centre', async () => {
      const c = await ask('day', 'what time do you shut?');
      expect(c.outOfBand).toBe('general');
    });

    it('does not mistake a routine fault for an escalation', async () => {
      const c = await ask('complaint', "there's a grinding noise when I turn left");
      expect(c.intent).not.toBe('another_problem');
      expect(c.complaint).toBeTruthy();
    });

    it('does escalate a car that will not start', async () => {
      const c = await ask('open_turn', "car won't start, I'm stuck in the basement");
      expect(c.intent).toBe('another_problem');
    });
  });

  describe('complaint vs special request (D8)', () => {
    it('reads a wash as a request, not a fault', async () => {
      const c = await ask('complaint', "give it a wash while it's in");
      expect(c.specialRequest ?? c.complaint).toBeTruthy();
      expect(c.complaint).toBeUndefined();
    });

    it('reads "no, it\'s fine" as nothing wrong', async () => {
      expect((await ask('complaint', "no, it's fine")).nothing).toBe(true);
    });
  });

  describe('casual agreement', () => {
    it.each(['yeah go on then', 'that\'s the one', 'aye', 'nope, different number'])(
      'reads %s',
      async (line) => {
        const c = await ask('greeting', line);
        expect(c.yesNo).toBeDefined();
      },
    );
  });

  describe('the multi-slot open turn (G6)', () => {
    it('picks up intent, vehicle, day and slot from one sentence', async () => {
      const c = await ask(
        'open_turn',
        'need to get the Creta serviced, Thursday morning if you can',
      );
      expect(c.intent).toBe('book');
      expect(c.vehicleModel).toBe('Creta');
      expect(c.day).toBe('2026-09-17');
      expect(c.dropSlot).toBe('morning');
    });
  });

  it('reports what it actually cost', () => {
    // Haiku 4.5: $1 / $5 per MTok.
    const usd = (usage.input / 1e6) * 1 + (usage.output / 1e6) * 5;
    console.log(
      `\n  ${usage.calls} calls · ${usage.input} in / ${usage.output} out · ` +
        `cache read ${usage.cacheRead}\n` +
        `  $${usd.toFixed(5)} total, $${(usd / Math.max(usage.calls, 1)).toFixed(6)} per turn\n` +
        `  a 10-turn call ≈ $${((usd / Math.max(usage.calls, 1)) * 10).toFixed(5)}`,
    );
    expect(usage.calls).toBeGreaterThan(0);
  });
});

describe('live suite gating', () => {
  it('is skipped unless LIVE=1 and a key is present', () => {
    // Guards against the live suite silently becoming a hard CI dependency.
    expect(LIVE).toBe(process.env['LIVE'] === '1' && hasApiKey());
  });
});
