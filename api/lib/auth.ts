import { timingSafeEqual } from "crypto";

/**
 * Shared-secret access control. Set APP_TOKEN in .env and every API call,
 * upload and file download must carry it, either as
 *   Authorization: Bearer <token>   (the tRPC client sends this)
 * or the cookie
 *   hb_token=<token>                (so <img src="/uploads/..."> works).
 * Without APP_TOKEN the app is open, which is only acceptable on a
 * trusted network; a warning is printed once at boot.
 */

const token = process.env.APP_TOKEN?.trim() || null;
let warned = false;

export function authConfigured(): boolean {
  return token !== null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function isAuthorized(req: Request): boolean {
  if (!token) {
    if (!warned) {
      warned = true;
      console.warn("[auth] APP_TOKEN is not set: the API and uploads are open to anyone who can reach this port.");
    }
    return true;
  }
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ") && safeEqual(auth.slice(7).trim(), token)) return true;
  const cookie = cookieValue(req.headers.get("cookie"), "hb_token");
  return cookie !== null && safeEqual(cookie, token);
}
