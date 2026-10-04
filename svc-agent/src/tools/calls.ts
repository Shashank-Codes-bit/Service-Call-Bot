/**
 * The last few calls to a centre, as they went: when, how they ended and
 * why, and every line said. For reading a call back after testing it.
 *
 *   docker compose exec app npm run calls -- voltas 3
 *
 * Voice calls only by default; add `all` to include typed chats.
 * Read-only: it never changes the centre's data.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';

type Row = { id: string; state: string; data: string; started_at: string; ended_at: string | null };
type Line = { speaker: string; text: string; created_at: string };

const clock = (ts: string) => ts.slice(11, 19);

export function printCalls(dbPath: string, count = 3, { all = false } = {}, out: (line: string) => void = console.log): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, state, data, started_at, ended_at FROM sessions
         ${all ? '' : `WHERE json_extract(data, '$.externalId') IS NOT NULL`}
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(count) as Row[];
    if (rows.length === 0) out(all ? 'No calls yet.' : 'No voice calls yet. Add "all" to include typed chats.');
    for (const r of rows.reverse()) {
      const d = JSON.parse(r.data) as Record<string, unknown>;
      const outcome = d['bookingReference']
        ? `booked ${String(d['bookingReference'])}`
        : d['leadReason']
          ? `passed to the team (${String(d['leadReason'])})`
          : r.state === 'ended'
            ? 'no booking'
            : `stopped at "${r.state}"`;
      const why = d['endedReason'] ? ` · line closed: ${String(d['endedReason'])}` : '';
      const length = typeof d['durationSeconds'] === 'number' ? ` · ${d['durationSeconds']}s` : '';
      out(`\n== ${r.started_at.replace('T', ' ').slice(0, 19)} · ${outcome}${why}${length}`);
      for (const l of db
        .prepare(`SELECT speaker, text, created_at FROM transcripts WHERE session_id = ? ORDER BY turn_index`)
        .all(r.id) as Line[]) {
        out(`${clock(l.created_at)} ${l.speaker === 'agent' ? 'agent ' : 'caller'} ${l.text}`);
      }
    }
    return rows.length;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const all = args.includes('all');
  const [slug, n] = args.filter((a) => a !== 'all');
  if (!slug) {
    console.error('Usage: npm run calls -- <centre> [how many] [all]   e.g.  npm run calls -- voltas 3');
    process.exit(1);
  }
  const path = join(config.dataDir, 'orgs', `${slug.toLowerCase()}.db`);
  if (!/^[a-z0-9-]+$/i.test(slug) || !existsSync(path)) {
    console.error(`No centre "${slug}" in ${config.dataDir}.`);
    process.exit(1);
  }
  printCalls(path, Math.min(Math.max(Number(n) || 3, 1), 50), { all });
}
