import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../db/index.ts';
import { seedIfEmpty } from '../db/bootstrap.ts';
import { config, configWarnings, hasApiKey } from '../config.ts';
import { rateLimit, requireCallSecret } from '../auth.ts';
import { api } from './api.ts';
import { purgeOldTranscripts } from '../call/session.ts';
import { addDays, today } from '../shared/dates.ts';
import { regenerateCapacity } from '../shared/capacity.ts';
import { buildDeps, callApi } from '../call/http.ts';
import { vapiApi } from '../call/vapi.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, '..', '..', 'dist', 'dealer');

// Before open(): seed() opens and closes its own handle.
const seeded = seedIfEmpty();
const db = open();
const app = express();

if (config.behindProxy) app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// One set of dependencies, so a single classifier instance serves every
// conversation whichever door it came through.
const deps = buildDeps(db);

// The chat panel. Open like the rest of the portal, because it is the demo —
// with its own, tighter ceiling, since every turn can cost a model call.
app.use('/api/chat', rateLimit({ max: 30 }), callApi(db, deps));

// The portal. Reads are open — the link is meant to be shareable — and writes
// are guarded inside the router. Shareable also means public, so it gets a
// ceiling too.
app.use('/api', rateLimit({ max: 600 }), api(db));

// The same conversation for a voice layer: our own contract, and Vapi's.
app.use('/call', rateLimit({ max: 120 }), requireCallSecret, callApi(db, deps));
app.use('/vapi', rateLimit({ max: 240 }), requireCallSecret, vapiApi(db, deps));

// The platform needs somewhere to check we are alive that costs nothing.
app.get('/health', (_req, res) => res.json({ ok: true, today: new Date().toISOString() }));

// An unknown /api path is a client bug and should say so in JSON. Without
// this the SPA catch-all below answers it with index.html and a 200, so a
// mistyped endpoint — or one that has been removed — looks like it worked.
app.use('/api', (_req, res) => res.status(404).json({ error: 'no such endpoint' }));

if (existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/.*/, (_req, res) => res.sendFile(join(DIST, 'index.html')));
} else {
  app.get('/', (_req, res) =>
    res
      .status(503)
      .type('text/plain')
      .send('Frontend not built yet. Run `npm run build:web`, or use `npm run dev:web`.'),
  );
}

// Anything reaching here is a genuine fault — expected outcomes like a full
// slot or a bad password already returned their own status.
app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  },
);

// F4's 45-day transcript retention. An obligation nothing calls is an
// obligation nobody keeps, so it runs at boot and once a day after.
const RETENTION_DAYS = 45;
const purge = () => {
  const gone = purgeOldTranscripts(db, addDays(today(), -RETENTION_DAYS));
  if (gone) console.log(`  purged     ${gone} transcript lines older than ${RETENTION_DAYS} days`);
};
setInterval(purge, 24 * 60 * 60 * 1000).unref();

// Capacity only exists for today..+30 (D5), and nothing walked that window
// forward, so a server left alone ran out of days to offer within a month.
// Every six hours rather than daily: a daily timer drifts against midnight,
// and one started at 23:50 would leave the +30 day missing for most of a day.
const rollCapacity = () => {
  const r = regenerateCapacity(db);
  if (r.created) console.log(`  capacity   window now runs ${r.from} to ${r.to} (+${r.created} cells)`);
  if (r.conflicts.length) console.warn(`  warning    ${r.conflicts.length} cells held above the master`);
};
setInterval(rollCapacity, 6 * 60 * 60 * 1000).unref();

app.listen(config.port, () => {
  purge();
  rollCapacity();
  console.log(`Dealer portal + call API on http://localhost:${config.port}`);
  console.log(`  database   ${config.dbPath} (${seeded === 'seeded' ? 'seeded fresh' : 'existing data kept'})`);
  console.log(`  classifier ${hasApiKey() ? 'Haiku (live)' : 'stub (no API key)'}`);
  console.log(`  clock      ${config.centreTimezone}, today ${today()}`);
  if (config.demoMode) console.log('  demo mode  on — unknown numbers get a demo car, chat shows SMS');
  for (const w of configWarnings()) console.warn(`  warning    ${w}`);
});
