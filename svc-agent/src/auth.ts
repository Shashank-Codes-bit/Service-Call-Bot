import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.ts';
import type { Accounts, Org } from './orgs/accounts.ts';

/**
 * Two kinds of door. The portal: a centre signs in once and holds a cookie for
 * the working day. The call endpoints: a shared secret, for the voice
 * provider. Both fail closed — an unset secret refuses, it never waves
 * requests through.
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

// ---------------------------------------------------------------------------
// Portal sessions
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'sid';
export const SESSION_HOURS = 12;

/**
 * `<slug>.<expires-ms>.<mac>`. The MAC covers the centre's password hash, so
 * changing the password signs every device out with no session table to clear.
 */
function mac(secret: string, slug: string, expires: number, pwHash: string): string {
  return createHmac('sha256', secret).update(`${slug}|${expires}|${pwHash}`).digest('base64url');
}

export function signSession(org: Org, secret: string, now = Date.now()): { value: string; expires: number } {
  const expires = now + SESSION_HOURS * 3_600_000;
  return { value: `${org.slug}.${expires}.${mac(secret, org.slug, expires, org.pw_hash)}`, expires };
}

export function readSession(
  value: string,
  accounts: Accounts,
  secret: string,
  now = Date.now(),
): Org | undefined {
  const [slug, exp, sig] = value.split('.');
  const expires = Number(exp);
  if (!slug || !sig || !Number.isFinite(expires) || expires <= now) return undefined;
  const org = accounts.get(slug);
  if (!org) return undefined;
  return matches(sig, mac(secret, slug, expires, org.pw_hash)) ? org : undefined;
}

/** One cookie by name, without a parser dependency for the one we use. */
export function cookie(req: Request, name: string): string {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return '';
}

export function sessionCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    ...(config.behindProxy ? ['Secure'] : []),
  ].join('; ');
}

/**
 * The portal's door: the session cookie, or `Authorization: Basic` with the
 * centre's user ID and password for scripts. Sets `res.locals.org`.
 */
export function requireOrg(accounts: Accounts, secret: () => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let org = readSession(cookie(req, SESSION_COOKIE), accounts, secret());
    const header = req.get('authorization') ?? '';
    if (!org && header.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i > 0) org = accounts.verify(decoded.slice(0, i), decoded.slice(i + 1));
    }
    if (!org) {
      res.status(401).json({ error: 'Please sign in', kind: 'unauthorised' });
      return;
    }
    res.locals['org'] = org;
    next();
  };
}
