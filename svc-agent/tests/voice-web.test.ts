import { describe, expect, it } from 'vitest';
import { vapiClassOf } from '../src/web/dealer/try/voice.ts';

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
