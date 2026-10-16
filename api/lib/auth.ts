import { timingSafeEqual } from "crypto";

/**
 * Shared-secret access control. Set APP_TOKEN in .env and every API call,
 * upload and file download must carry it, either as
 *   Authorization: Bearer <token>   (the tRPC client sends this)
 * or the cookie
 *   hb_token=<token>                (so <img src="/uploads/..."> works).
 * Without APP_TOKEN the app is open, which is only acceptable on a
 * trusted network: in development a warning is printed once; a production
 * boot refuses to start unless ALLOW_OPEN_ACCESS=1 says so explicitly.
 */

const token = process.env.APP_TOKEN?.trim() || null;
let warned = false;

export function authConfigured(): boolean {
  return token !== null;
}

/**
 * Why a production boot must stop, or null when it may start. The message is
 * printed as is, so it names the fix.
 */
export function productionAuthProblem(e: NodeJS.ProcessEnv): string | null {
  if (e.NODE_ENV !== "production" || e.APP_TOKEN?.trim()) return null;
  if (e.ALLOW_OPEN_ACCESS === "1") return null;
  return [
    "APP_TOKEN is not set, so the API and every photo would be open to anyone who can reach this port.",
    "Set APP_TOKEN=<a long random string> in .env (clients then send it as a Bearer token),",
    "or set ALLOW_OPEN_ACCESS=1 to run open on a trusted network on purpose.",
  ].join("\n");
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
