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

  /**
   * Where the centres live: `accounts.db` and `orgs/<slug>.db`. Beside the old
   * single database by default, so the volume that held it holds these too.
   */
  get dataDir(): string {
    return str('DATA_DIR') || dirname(this.dbPath);
  },

  /**
   * The password the first centre signs in with. Read once, at the first boot
   * after the move to separate centres; after that the hash in accounts.db is
   * what counts, and changing this does nothing.
   */
  adminPassword: str('ADMIN_PASSWORD'),

  /** The slug of the first centre, made from the old single database. Also
   *  where the voice endpoints go when a request names no centre. */
  defaultOrg: str('DEFAULT_ORG', 'voltas'),

  /** Signs the portal's session cookie. Unset, one is generated once and kept
   *  in accounts.db, so restarts don't sign everyone out. */
  sessionSecret: str('SESSION_SECRET'),

  /**
   * Vapi web calls on the public page. The public key and assistant id go to
   * the browser — Vapi designs the public key to be public; lock it to this
   * site in Vapi's dashboard. Unset, the page uses the browser's own speech.
   */
  vapiPublicKey: str('VAPI_PUBLIC_KEY'),
  vapiAssistantId: str('VAPI_ASSISTANT_ID'),
  /** Only for `npm run vapi:setup`. Never sent anywhere but Vapi's API. */
  vapiPrivateKey: str('VAPI_PRIVATE_KEY'),
  /** This site's own address, e.g. https://140-238-251-141.sslip.io — Vapi calls back to it. */
  publicUrl: str('PUBLIC_URL').replace(/\/+$/, ''),

  /** Conversation turns a centre gets per day — every turn can cost a model call. */
  orgDailyTurns: Number(str('ORG_DAILY_TURNS', '300')),

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
};

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
  if (!config.callApiSecret) out.push('CALL_API_SECRET unset — call endpoints will be refused');
  if (!config.anthropicApiKey) out.push('CLAUDE_API_KEY unset — falling back to the stub classifier');
  return out;
}
