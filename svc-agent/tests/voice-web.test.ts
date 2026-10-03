import { describe, expect, it } from 'vitest';
import { errorText, groupLines, isNormalEnd, vapiClassOf, type Line } from '../src/web/dealer/try/voice.ts';

/**
 * The Vapi SDK is CommonJS (`exports.default = Vapi`), and how it arrives from
 * `import()` depends on the bundler: the class itself under `default` (dev),
 * or wrapped once more under `default.default` (the production build). The
 * live site got the wrapper and failed with "n is not a constructor".
 */
describe('loading the Vapi SDK', () => {
  class FakeVapi {}

  it('finds the class however the bundle wrapped it', () => {
    expect(vapiClassOf({ default: FakeVapi })).toBe(FakeVapi);
    expect(vapiClassOf({ default: { default: FakeVapi, __esModule: true } })).toBe(FakeVapi);
    expect(vapiClassOf(FakeVapi)).toBe(FakeVapi);
  });

  it('says so plainly when there is no class at all', () => {
    expect(() => vapiClassOf({ default: { nothing: true } })).toThrow(/browser’s voice/);
  });
});


describe('the live call’s transcript', () => {
  it('shows each turn as one bubble, not one box per phrase', () => {
    // As the first live call arrived: the greeting in four final pieces.
    const lines: Line[] = [
      { who: 'agent', text: 'Voltas Motors Service' },
      { who: 'agent', text: 'sector 44.' },
      { who: 'agent', text: "I'm an automated assistant," },
      { who: 'agent', text: 'I can book you in or take a message for the team.' },
      { who: 'caller', text: 'Yes,' },
      { who: 'caller', text: "that's me." },
      { who: 'agent', text: 'Got it — the Nexon.' },
      { who: 'sms', text: 'Booking 261004-00001' },
      { who: 'sms', text: 'Another message' },
    ];
    expect(groupLines(lines)).toEqual([
      { who: 'agent', text: "Voltas Motors Service sector 44. I'm an automated assistant, I can book you in or take a message for the team.", interim: false },
      { who: 'caller', text: "Yes, that's me.", interim: false },
      { who: 'agent', text: 'Got it — the Nexon.', interim: false },
      { who: 'sms', text: 'Booking 261004-00001', interim: false },
      { who: 'sms', text: 'Another message', interim: false },
    ]);
  });

  it('shows what the caller is still saying at the end of their bubble', () => {
    const lines: Line[] = [
      { who: 'agent', text: 'Which day?' },
      { who: 'caller', text: 'Friday' },
      { who: 'caller', text: 'in the mor', interim: true },
    ];
    expect(groupLines(lines).at(-1)).toEqual({ who: 'caller', text: 'Friday in the mor', interim: true });
  });
});

describe('the end of a call', () => {
  it('reads every error shape as a sentence, never [object Object]', () => {
    expect(errorText({ error: { message: 'Microphone blocked' } })).toBe('Microphone blocked');
    expect(errorText({ errorMsg: 'Network down' })).toBe('Network down');
    expect(errorText({ error: { error: { msg: 'deeply nested' } } })).toBe('deeply nested');
    expect(errorText('plain')).toBe('plain');
    expect(errorText({})).toBe('{}');
    expect(errorText({ type: 'daily-error', error: { type: 'ejected', msg: 'Meeting has ended' } })).not.toContain('[object');
  });

  it('treats the hang-up after the goodbye as a normal end', () => {
    expect(isNormalEnd({ type: 'daily-error', error: { type: 'ejected', msg: 'Meeting has ended' } })).toBe(true);
    expect(isNormalEnd({ errorMsg: 'Meeting has ended' })).toBe(true);
    expect(isNormalEnd({ error: { message: 'Microphone blocked' } })).toBe(false);
  });
});
