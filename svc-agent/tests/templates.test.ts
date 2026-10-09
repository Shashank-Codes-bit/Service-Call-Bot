import { describe, expect, it } from 'vitest';
import * as T from '../src/call/templates.ts';

/**
 * Every line the agent can say, held to the short-sentence rule: one idea a
 * sentence, at most SENTENCE_WORDS words, at most TURN_SENTENCES sentences a
 * template. Long sentences with asides sounded read out on the live calls.
 */

/** Realistic, long-ish values, so a template passes with the words it will really carry. */
const VALUES: Record<string, string> = {
  centre: 'Voltas Motors Service — Sector 44',
  last4: T.spokenDigits('1001'),
  model: 'Fortuner',
  count: '3',
  number: 'Three',
  ordinal: 'fourth',
  pool: 'major',
  date: 'Wednesday the 27th',
  day: 'Wednesday',
  alt1: 'Thursday the 28th morning',
  alt2: 'Saturday the 30th afternoon',
  slot: 'afternoon',
  asked: 'morning',
  left: 'afternoon',
  time: '8:30',
  back: 'the same evening',
  name: 'Rohit',
  fault: 'a problem with the gears',
  problem: 'the gear problem',
  other: 'morning',
};

/** Words as heard: "1 0 0 1" is one number, "—" is no word. */
export function sentenceWords(sentence: string): number {
  return sentence
    .replace(/\b(\d)(?: \d)+\b/g, '$1')
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w)).length;
}

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Every template string in one language's pools, with where it came from. */
function allTemplates(pools: T.Pools): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (name: string, v: unknown) => {
    if (typeof v === 'string') out.push([name, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(`${name}[${i}]`, x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(`${name}.${k}`, x);
  };
  // Lines only: the word tables (fault, problem, slot…) are filled into lines.
  const WORDS = new Set(['slot', 'back', 'listNumber', 'fault', 'problem']);
  for (const [name, v] of Object.entries(pools)) {
    if (typeof v === 'function' || WORDS.has(name)) continue;
    walk(name, v);
  }
  return out;
}

/** The values a language's lines are really filled with: its own longest words, the worst case. */
function valuesFor(pools: T.Pools): Record<string, string> {
  const longest = (xs: string[]) => xs.reduce((a, b) => (sentenceWords(b) > sentenceWords(a) ? b : a));
  return {
    ...VALUES,
    fault: longest(Object.values(pools.fault)),
    problem: longest(Object.values(pools.problem)),
    slot: longest(Object.values(pools.slot)),
    asked: longest(Object.values(pools.slot)),
    left: longest(Object.values(pools.slot)),
    other: longest(Object.values(pools.slot)),
    back: longest(Object.values(pools.back)),
    time: pools.time('afternoon'),
    date: pools.date('2026-09-30'),
    number: pools.listNumber[2]!,
  };
}

for (const [language, pools] of Object.entries(T.POOLS)) {
  const VALUES = valuesFor(pools);
  describe(`${language}: every line is short sentences`, () => {
    const templates = allTemplates(pools);

    it('finds the pools', () => {
      expect(templates.length).toBeGreaterThan(80);
    });

    for (const [name, template] of templates) {
      it(`${name}`, () => {
        const text = T.fill(template, VALUES);
        expect(text, 'a placeholder was left unfilled').not.toMatch(/\{\w+\}/);
        const parts = sentences(text);
        expect(parts.length, text).toBeLessThanOrEqual(T.TURN_SENTENCES);
        for (const s of parts) expect(sentenceWords(s), s).toBeLessThanOrEqual(T.SENTENCE_WORDS);
      });
    }
  });

  describe(`${language}: a question is the last thing said`, () => {
    for (const [name, template] of allTemplates(pools)) {
      const text = T.fill(template, VALUES);
      if (!text.includes('?')) continue;
      it(name, () => expect(text.trim().endsWith('?'), text).toBe(true));
    }
  });
}

describe('Hinglish has every line English has', () => {
  const keys = (pools: T.Pools) => allTemplates(pools).map(([name]) => name.replace(/\[\d+\]$/, '')).sort();
  it('no missing pools or sub-pools', () => {
    expect([...new Set(keys(T.HI))]).toEqual([...new Set(keys(T.EN))]);
  });
  it('fills the word tables for every fault area and slot', () => {
    for (const p of [T.EN, T.HI]) {
      for (const v of [...Object.values(p.fault), ...Object.values(p.problem), ...Object.values(p.slot)]) expect(v).toBeTruthy();
      expect(p.listNumber).toHaveLength(5);
    }
  });
});

describe('spoken digits', () => {
  it('reads the last four one by one', () => {
    expect(T.spokenDigits('9810011001'.slice(-4))).toBe('1 0 0 1');
  });
});
