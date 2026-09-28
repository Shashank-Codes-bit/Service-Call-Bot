import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.ts';

/**
 * Two guards, one rule: unset means refuse. "No password configured, so skip
 * the check" is frictionless locally and ships the app wide open the first
 * time someone forgets a secret; this fails closed and says so.
 *
 * Reads are unguarded on purpose — the portal link is meant to be shareable.
 */

/** Constant-time, so a wrong secret leaks nothing through response timing. */
function matches(supplied: string, expected: string): boolean {
  if (!expected || !supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal — compare lengths first and always run the comparison.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <secret>`, or the simpler `x-admin-password`. */
function presented(req: Request): string {
  const header = req.get('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  return bearer || req.get('x-admin-password')?.trim() || '';
}

function guard(secret: () => string, name: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expected = secret();
    if (!expected) {
      res.status(503).json({
        error: `${name} is not configured on this server, so this endpoint is disabled`,
        kind: 'not_configured',
      });
      return;
    }
    if (!matches(presented(req), expected)) {
      res.status(401).json({ error: 'unauthorised', kind: 'unauthorised' });
      return;
    }
    next();
  };
}

/** Portal writes — capacity edits, regeneration, taking a slot. */
export const requireAdmin = guard(() => config.adminPassword, 'ADMIN_PASSWORD');

/** The call endpoints and the Vapi webhook. */
export const requireCallSecret = guard(() => config.callApiSecret, 'CALL_API_SECRET');

/**
 * A crude fixed-window limiter, per IP per route — enough to stop a public
 * phone webhook turning into an unbounded bill. Not a substitute for a real
 * limiter behind a proxy, and it resets with the process.
 */
export function rateLimit({ windowMs = 60_000, max = 60 } = {}) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${req.ip ?? 'unknown'}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (entry.count >= max) {
      res.status(429).json({ error: 'too many requests', kind: 'rate_limited' });
      return;
    }
    entry.count += 1;
    next();

    // Opportunistic sweep so the Map cannot grow without bound.
    if (hits.size > 5_000) {
      for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    }
  };
}
