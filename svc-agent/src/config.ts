import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(here, '..', '.env');

/**
 * The one place the environment enters this process. Everything that differs
 * between a laptop and a server is read here with a local default, so
 * deploying changes values, not code. Nothing else touches `process.env`.
 */

let loaded = false;
function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  // Node's own loader — no dotenv dependency. Absent in production, where the
  // platform supplies real environment variables instead.
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}
loadEnv();

const str = (key: string, fallback = ''): string => process.env[key]?.trim() || fallback;

export const config = {
  port: Number(str('PORT', '3001')),

  /** On a server this points at a mounted volume — defaulting to the source
   *  tree would make every deploy ship a fresh, empty database. */
  dbPath: str('DB_PATH', join(here, '..', 'service.db')),

  /** Portal writes: save capacity, regenerate, take a slot. Reads stay open. */
  adminPassword: str('ADMIN_PASSWORD'),

  /** The call endpoints and the Vapi webhook. */
  callApiSecret: str('CALL_API_SECRET'),

  /** CLAUDE_API_KEY is the name now; the old ANTHROPIC_API_KEY is still read
   *  so an existing .env or Fly secret keeps working until it is renamed. */
  anthropicApiKey: str('CLAUDE_API_KEY') || str('ANTHROPIC_API_KEY'),

  /**
   * An unknown number gets a demo customer and one car instead of
   * `number_not_found`, and the chat panel shows the SMS it would have sent.
   * For a public demo only — never with real customer data.
   */
  demoMode: str('DEMO_MODE') === 'true',

  /**
   * Every date in this app is the service centre's calendar date
   * (shared/dates.ts, I4-7), not the host's. A cloud machine runs UTC, which
   * in India is still yesterday until 05:30 — and the agent would offer today
   * as the earliest booking, the one thing D5 forbids.
   */
  centreTimezone: str('CENTRE_TIMEZONE', 'Asia/Kolkata'),

  /**
   * Behind a platform proxy the client's address arrives in X-Forwarded-For;
   * without this every visitor shares one rate-limit bucket. Off locally,
   * where honouring that header would let a client choose its own address.
   */
  behindProxy: str('BEHIND_PROXY') === 'true',
} as const;

// Node re-reads TZ when it is assigned, so this pins every Date in the process
// to the centre's clock whatever the host is set to.
process.env.TZ = config.centreTimezone;

export const hasApiKey = (): boolean => Boolean(config.anthropicApiKey);

/**
 * Warn at boot, never crash: the server must start without credentials so the
 * flow can be demonstrated offline. The guards themselves refuse rather than
 * wave requests through — an unset password blocks writes, it does not open
 * them.
 */
export function configWarnings(): string[] {
  const out: string[] = [];
  if (!config.adminPassword) out.push('ADMIN_PASSWORD unset — portal writes will be refused');
  if (!config.callApiSecret) out.push('CALL_API_SECRET unset — call endpoints will be refused');
  if (!config.anthropicApiKey) out.push('CLAUDE_API_KEY unset — falling back to the stub classifier');
  return out;
}
