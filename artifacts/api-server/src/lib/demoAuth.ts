import type { Request } from "express";

/**
 * LOCAL DEMO MODE — offline preview without Clerk.
 *
 * When LOCAL_DEMO_AUTH=true the API trusts a cookie naming one of the seeded
 * demo users (ids starting "demo_") instead of a Clerk session. It exists so
 * the app can be previewed on a laptop with no internet and no accounts.
 *
 * Guard rails:
 *  - refuses to start when NODE_ENV=production;
 *  - only accepts connections from this machine (loopback);
 *  - only ever resolves to users whose id starts with "demo_".
 */
export const LOCAL_DEMO_AUTH = process.env.LOCAL_DEMO_AUTH === "true";

if (LOCAL_DEMO_AUTH && process.env.NODE_ENV === "production") {
  throw new Error("LOCAL_DEMO_AUTH must never be enabled in production.");
}

export const DEMO_COOKIE = "mandovi_demo_user";

function isLoopback(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

/** The demo user id from the cookie, or null if absent / not allowed. */
export function demoUserIdFromRequest(req: Request): string | null {
  if (!isLoopback(req.socket.remoteAddress)) return null;
  const cookies = req.headers.cookie ?? "";
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === DEMO_COOKIE) {
      const value = decodeURIComponent(rest.join("="));
      return /^demo_[a-z0-9_]+$/.test(value) ? value : null;
    }
  }
  return null;
}
