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

/** Every template string in the module, with where it came from. */
function allTemplates(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (name: string, v: unknown) => {
    if (typeof v === 'string') out.push([name, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(`${name}[${i}]`, x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(`${name}.${k}`, x);
  };
  for (const [name, v] of Object.entries(T)) {
    if (typeof v === 'function' || typeof v === 'number' || name === 'LIST_NUMBER') continue;
    walk(name, v);
  }
  return out;
}

describe('every line is short sentences', () => {
  const templates = allTemplates();

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

describe('a question is the last thing said', () => {
  for (const [name, template] of allTemplates()) {
    const text = T.fill(template, VALUES);
    if (!text.includes('?')) continue;
    it(name, () => expect(text.trim().endsWith('?'), text).toBe(true));
  }
});

describe('spoken digits', () => {
  it('reads the last four one by one', () => {
    expect(T.spokenDigits('9810011001'.slice(-4))).toBe('1 0 0 1');
  });
});
