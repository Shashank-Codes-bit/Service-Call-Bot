import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, configWarnings, hasApiKey } from '../config.ts';
import { purgeOldTranscripts } from '../call/session.ts';
import { addDays, today } from '../shared/dates.ts';
import { regenerateCapacity } from '../shared/capacity.ts';
import { Accounts } from '../orgs/accounts.ts';
import { Registry } from '../orgs/registry.ts';
import { nightlyResets } from '../orgs/demo.ts';
import { buildApp } from './app.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, '..', '..', 'dist', 'dealer');

// ---------------------------------------------------------------------------
// Centres. The single database the server ran on before becomes the first
// centre on the first boot after the move (copied; the original stays as the
// backup). A fresh volume gets the first centre from the sample data.
// ---------------------------------------------------------------------------

const accounts = new Accounts(config.dataDir);
const adopted = accounts.adoptLegacy(config.dbPath, {
  slug: config.defaultOrg,
  password: config.adminPassword,
});
if (accounts.list().length === 0 && config.adminPassword) {
  try {
    accounts.create({ name: 'Voltas Motors Service', userId: config.defaultOrg, password: config.adminPassword });
  } catch (e) {
    console.warn(`  warning    first centre not created: ${(e as Error).message}`);
  }
}
const registry = new Registry(accounts);
const app = buildApp({ accounts, registry, dist: DIST });

// F4's 45-day transcript retention, and the capacity window walking forward
// (D5) — for every centre. Every six hours rather than daily: a daily timer
// drifts against midnight, and one started at 23:50 would leave the +30 day
// missing for most of a day.
const RETENTION_DAYS = 45;
const daily = () => {
  for (const h of registry.all()) {
    const gone = purgeOldTranscripts(h.db, addDays(today(), -RETENTION_DAYS));
    if (gone) console.log(`  purged     ${h.slug}: ${gone} transcript lines older than ${RETENTION_DAYS} days`);
    const r = regenerateCapacity(h.db);
    if (r.created) console.log(`  capacity   ${h.slug}: window now runs ${r.from} to ${r.to} (+${r.created} cells)`);
    if (r.conflicts.length) console.warn(`  warning    ${h.slug}: ${r.conflicts.length} cells held above the master`);
  }
};
setInterval(daily, 6 * 60 * 60 * 1000).unref();

// Demo centres go back to the sample every night after 3:00 (orgs/demo.ts).
// Checked every ten minutes, so a server that was down at 3:00 catches up.
const resets = () => {
  try {
    nightlyResets(accounts, registry);
  } catch (e) {
    console.error('demo reset failed', e);
  }
};
setInterval(resets, 10 * 60 * 1000).unref();

app.listen(config.port, () => {
  daily();
  resets();
  const orgs = accounts.list();
  console.log(`Service desk + call API on http://localhost:${config.port}`);
  console.log(`  centres    ${orgs.length} in ${config.dataDir}${adopted === 'adopted' ? ` (moved ${config.dbPath} in as "${config.defaultOrg}"; original kept)` : ''}`);
  for (const o of orgs) console.log(`             ${o.user_id.padEnd(16)} ${o.name}${config.demoMode && o.demo ? '  (demo: resets nightly)' : ''}`);
  if (orgs.length === 0) console.log('             none yet: open the site and create one, or set ADMIN_PASSWORD');
  console.log(`  classifier ${hasApiKey() ? 'Haiku (live)' : 'stub (no API key)'}`);
  console.log(`  clock      ${config.centreTimezone}, today ${today()}`);
  if (config.demoMode) console.log('  demo mode  on — unknown numbers get a demo car, chat shows SMS');
  for (const w of configWarnings()) console.warn(`  warning    ${w}`);
});
