import type { Database } from 'better-sqlite3';
import type { NextFunction, Request, Response, Router } from 'express';
import { open } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { api } from '../dealer/api.ts';
import { buildDeps, callApi } from '../call/http.ts';
import { vapiApi } from '../call/vapi.ts';
import type { CallDeps } from '../call/machine.ts';
import { today } from '../shared/dates.ts';
import { config } from '../config.ts';
import { allowedCaller } from '../db/sample.ts';
import type { Accounts } from './accounts.ts';

/** One centre, open: its database and the routers that serve it. */
export type OrgHandle = {
  slug: string;
  db: Database;
  /** Demo behaviour for this centre: its own switch, under the server's DEMO_MODE. */
  demo: boolean;
  deps: CallDeps;
  api: Router;
  call: Router;
  vapi: Router;
};

/**
 * Opens each centre's database once, on first use, and keeps it. The routers
 * are built per centre over its own handle, so a request can only ever reach
 * the file its sign-in names.
 */
export class Registry {
  private readonly open = new Map<string, OrgHandle>();

  constructor(
    readonly accounts: Accounts,
    private readonly makeDeps: (db: Database, opts: { demo: boolean }) => CallDeps = buildDeps,
  ) {}

  get(slug: string): OrgHandle | undefined {
    const cached = this.open.get(slug);
    if (cached) return cached;
    if (!this.accounts.get(slug)) return undefined;
    const db = open(this.accounts.orgPath(slug));
    migrate(db);
    return this.build(slug, db);
  }

  /**
   * Rebuild a centre's routers over its open database — after its demo
   * switch changes, so the very next request behaves the new way.
   */
  refresh(slug: string): OrgHandle | undefined {
    const cached = this.open.get(slug);
    return cached ? this.build(slug, cached.db) : this.get(slug);
  }

  private build(slug: string, db: Database): OrgHandle {
    const demo = config.demoMode && this.accounts.get(slug)?.demo !== 0;
    const deps = this.makeDeps(db, { demo });
    const handle: OrgHandle = {
      slug,
      db,
      demo,
      deps,
      api: api(db, { deps }),
      call: callApi(db, deps, { demo }),
      // Voice can't take a 429 — over the day's cap, the caller hears a sentence.
      vapi: vapiApi(db, deps, {
        overCap: () => turnsToday(db) >= (this.accounts.get(slug)?.daily_turn_cap ?? config.orgDailyTurns),
        webCaller: (mobile) => allowedCaller({ demo }, mobile),
      }),
    };
    this.open.set(slug, handle);
    return handle;
  }

  /** Every centre, for the daily jobs. */
  all(): OrgHandle[] {
    return this.accounts
      .list()
      .map((o) => this.get(o.slug))
      .filter((h): h is OrgHandle => Boolean(h));
  }

  close(): void {
    for (const h of this.open.values()) h.db.close();
    this.open.clear();
  }
}

/** Caller turns today: what the daily cap counts. The greeting costs nothing. */
export function turnsToday(db: Database, now = new Date()): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM transcripts
         WHERE speaker = 'caller' AND created_at >= ?`,
      )
      .get(today(now)) as { n: number }
  ).n;
}

/**
 * Each centre gets a number of conversation turns a day, because every turn
 * can cost a model call and the sign-up page is open to anyone. Past it, the
 * agent stops answering until tomorrow; the portal keeps working.
 */
export function dailyTurnCap(db: Database, cap: () => number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST' || req.path === '/start') return next();
    if (turnsToday(db) >= cap()) {
      res.status(429).json({
        error: "Today's conversation limit for this centre is used up. It resets at midnight.",
        kind: 'daily_cap',
      });
      return;
    }
    next();
  };
}
