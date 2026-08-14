/**
 * Cookie session with a deliberately short idle timeout.
 *
 * In-memory and single-process, which is correct for a mock: persistence would add
 * nothing to the automation problem. The short TTL is the point — session expiry is
 * one of the runtime conditions the brief names, and it has to be reachable by
 * waiting as well as by arming a fault. A condition you can only trigger through a
 * test hook is easy to dismiss as staged.
 *
 * Cookies are parsed by hand rather than with `cookie-parser`: it is eight lines,
 * and a reviewer running this should not have to audit a dependency to see how
 * authentication works.
 */

import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";

const COOKIE_NAME = "MERIDIAN_SID";

export interface Session {
  sid: string;
  user: string;
  createdAt: number;
  lastSeenAt: number;
}

const sessions = new Map<string, Session>();

function ttlMs(): number {
  const seconds = Number(process.env.TARGET_APP_SESSION_TTL_SECONDS ?? 120);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 120) * 1000;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function createSession(res: Response, user: string): Session {
  const sid = randomBytes(16).toString("hex");
  const now = Date.now();
  const session: Session = { sid, user, createdAt: now, lastSeenAt: now };
  sessions.set(sid, session);
  // No Secure flag: this is http://localhost by design. HttpOnly is set anyway so
  // the mock does not model a worse app than it needs to.
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  return session;
}

/**
 * Resolve the caller's session, sliding the idle window.
 *
 * Returns null for both "no cookie" and "expired", because the *screen* is the same
 * in either case. Distinguishing them would leak session state to an unauthenticated
 * caller for no benefit to the exercise.
 */
export function getSession(req: Request): Session | null {
  const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!sid) return null;

  const session = sessions.get(sid);
  if (!session) return null;

  if (Date.now() - session.lastSeenAt > ttlMs()) {
    sessions.delete(sid);
    return null;
  }

  session.lastSeenAt = Date.now();
  return session;
}

/** Invalidate immediately. Used by sign-out and by the session_expired fault. */
export function destroySession(req: Request): void {
  const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (sid) sessions.delete(sid);
}

export function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

export function sessionTtlSeconds(): number {
  return Math.round(ttlMs() / 1000);
}
