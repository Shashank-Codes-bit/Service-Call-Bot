import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { open } from '../src/db/index.ts';
import { seed } from '../src/db/seed.ts';
import { deleteEntry, TableKnowledgeBank, upsertEntry } from '../src/kb/index.ts';
import { matchKbKey, StubClassifier } from '../src/call/classifier.ts';
import { LocalCrm } from '../src/call/crm.ts';
import { handleTurn, startCall, type CallDeps } from '../src/call/machine.ts';
import type { TurnResult } from '../src/call/types.ts';

const MONDAY = new Date(2026, 8, 14, 10, 0, 0);

let scratch: string;
let db: Database;
let deps: CallDeps;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'svc-kb-'));
  seed({ now: MONDAY, dbPath: join(scratch, 'test.db') });
  db = open(join(scratch, 'test.db'));
  deps = {
    classifier: new StubClassifier(),
    crm: new LocalCrm(db),
    kb: new TableKnowledgeBank(db),
  };
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function call(number: string, lines: string[]): Promise<TurnResult[]> {
  const first = await startCall(db, number, MONDAY);
  const out = [first];
  let last = first;
  for (const line of lines) {
    if (last.ended) break;
    last = await handleTurn(db, deps, first.sessionId, line, MONDAY);
    out.push(last);
  }
  return out;
}

describe('the knowledge bank comes from the data, not from code', () => {
  it('answers from a seeded row', async () => {
    const turns = await call('9810011001', ['Yes.', 'Nexon service Friday.', 'what time do you open?']);
    expect(turns.at(-1)!.reply).toMatch(/9 in the morning/);
    expect(turns.at(-1)!.ended).toBe(false);
  });

  it('ANSWERS A ROW ADDED AT RUNTIME — the whole point of the rewrite', async () => {
    // Previously impossible: questions were routed by a regex list hardcoded
    // in machine.ts, so a new row was unreachable without a code change.
    upsertEntry(db, 'loaner_car', 'We keep a few courtesy cars — ask the advisor when you drop it in.');

    const turns = await call('9810011001', [
      'Yes.',
      'Nexon service Friday.',
      'do you have a loaner car?',
    ]);
    expect(turns.at(-1)!.reply).toMatch(/courtesy cars/);
    expect(turns.at(-1)!.ended).toBe(false);
  });

  it('stops answering a row that was deleted', async () => {
    expect(deleteEntry(db, 'parking')).toBe(true);
    const turns = await call('9810011001', ['Yes.', 'Nexon service Friday.', 'is there parking?']);
    // Nothing matches now, so D10 applies: end the call rather than guess.
    expect(turns.at(-1)!.ended).toBe(true);
    expect(turns.at(-1)!.leadReason).toBe('another_problem');
  });

  it('returns to the question it was asking', async () => {
    const turns = await call('9810011001', ['Yes.', 'Nexon service Friday.', 'where are you located?']);
    expect(turns.at(-1)!.state).toBe('complaint');
    expect(turns.at(-1)!.reply).toMatch(/Sector 44/);
  });
});

describe('D10 — never guess', () => {
  // A matcher that always returns its nearest option is the failure mode here:
  // ask about insurance and get told about parking. No match must mean no
  // answer, and the call ends with a customer-care lead.
  it.each([
    'do you handle insurance claims?',
    'can I get finance on the repair?',
    'do you sell used cars?',
    'is the manager available?',
  ])('ends the call on: %s', async (question) => {
    const turns = await call('9810011001', ['Yes.', 'Nexon service Friday.', question]);
    expect(turns.at(-1)!.ended).toBe(true);
    expect(turns.at(-1)!.leadReason).toBe('another_problem');
  });

  it('matches nothing when nothing is close', () => {
    const keys = ['opening_hours', 'location', 'parking'];
    expect(matchKbKey('do you handle insurance claims', keys)).toBeUndefined();
    expect(matchKbKey('', keys)).toBeUndefined();
    expect(matchKbKey('what time do you open', [])).toBeUndefined();
  });

  it('matches on a stem, both directions', () => {
    const keys = ['opening_hours', 'location', 'payment_methods'];
    expect(matchKbKey('what time do you open', keys)).toBe('opening_hours');
    expect(matchKbKey('where are you located', keys)).toBe('location');
    expect(matchKbKey('can I pay by card', keys)).toBe('payment_methods');
  });
});

describe('editing the bank', () => {
  it('normalises a key and rejects a bad one', () => {
    upsertEntry(db, '  Courtesy Car  ', 'Yes, ask the advisor.');
    expect(new TableKnowledgeBank(db).answerFor('courtesy_car')).toBe('Yes, ask the advisor.');

    expect(() => upsertEntry(db, 'x', 'too short a key')).toThrow(/2-60/);
    expect(() => upsertEntry(db, 'valid_key', '   ')).toThrow(/empty/);
  });

  it('overwrites rather than duplicating', () => {
    upsertEntry(db, 'parking', 'Parking is round the back now.');
    const entries = new TableKnowledgeBank(db).entries().filter((e) => e.key === 'parking');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.answer).toBe('Parking is round the back now.');
  });

  it('deletes by the name it was saved under, not the normalised one', () => {
    // upsert normalised the key and delete did not, so an entry created as
    // "Courtesy Car" became `courtesy_car` and then could not be removed by
    // the only name the dealer ever typed.
    upsertEntry(db, 'Loan Car', 'Ask the advisor.');
    expect(new TableKnowledgeBank(db).answerFor('loan_car')).toBe('Ask the advisor.');
    expect(deleteEntry(db, 'Loan Car')).toBe(true);
    expect(new TableKnowledgeBank(db).answerFor('loan_car')).toBeUndefined();
  });

  it('reports a delete that matched nothing', () => {
    expect(deleteEntry(db, 'never_existed')).toBe(false);
  });
});

describe('the fast path only fires when it is certain (G7)', () => {
  const stub = new StubClassifier();
  const ask = (state: string, utterance: string) =>
    stub.classify({ state: state as never, utterance, today: '2026-09-14' });

  it.each([
    ['greeting', 'yes'],
    ['greeting', "yeah that's right"],
    ['greeting', 'no'],
    ['drop_slot', 'morning'],
    ['drop_slot', 'afternoon please'],
    ['awaiting_otp', '4471'],
  ])('is confident on %s: "%s"', async (state, utterance) => {
    expect((await ask(state, utterance)).confident).toBe(true);
  });

  it.each([
    // Anything carrying meaning the stub cannot read must reach the model.
    ['open_turn', 'yes'],
    ['complaint', 'no'],
    ['day', 'day after next if you have a gap'],
    ['greeting', 'yes but can I ask how much it costs'],
    ['drop_slot', 'morning would be better but afternoon works too'],
    ['vehicle', 'the Swift I think, or maybe the other one'],
    ['day', 'whenever you like'],
  ])('DEFERS on %s: "%s"', async (state, utterance) => {
    // A wrong fast answer costs far more than a slow right one.
    expect((await ask(state, utterance)).confident).toBeUndefined();
  });

  it('never claims certainty about an out-of-band question', async () => {
    expect((await ask('day', 'how much?')).confident).toBeUndefined();
    expect((await ask('day', 'are you open?')).confident).toBeUndefined();
  });
});
