const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i;

/** Prefer a LAN IP; fall back to hostname. Skip localhost-like values. */
export function pickReachHost(ip?: string | null, hostname?: string | null): string | null {
  const ipn = String(ip ?? "").trim();
  if (ipn && !LOCAL_HOST.test(ipn)) return ipn;
  const h = String(hostname ?? "").trim();
  if (h && !LOCAL_HOST.test(h)) return h;
  return null;
}

export function hostHref(host: string | null | undefined): string | null {
  const h = String(host ?? "").trim();
  if (!h || LOCAL_HOST.test(h)) return null;
  return `http://${h}/`;
}

export function portHref(host: string | null | undefined, port: number): string | null {
  const h = String(host ?? "").trim();
  if (!h || LOCAL_HOST.test(h) || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return port === 80 ? `http://${h}/` : `http://${h}:${port}/`;
}

/** Rewrite localhost / 127.0.0.1 / 0.0.0.0 to `host`. Other URLs stay as-is. */
export function rewriteLocalHostUrl(url: string, host: string | null | undefined): string {
  const h = String(host ?? "").trim();
  if (!h || !url || LOCAL_HOST.test(h)) return url;
  try {
    const u = new URL(url);
    if (!LOCAL_HOST.test(u.hostname)) return url;
    u.hostname = h;
    return u.toString();
  } catch {
    return url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)(?=[:/]|$)/i, `$1${h}`);
  }
}

export type StatusTone = "ok" | "warn" | "error" | "dim";

export const STATUS_DOT: Record<StatusTone, string> = {
  ok: "#22c55e",
  warn: "#f59e0b",
  error: "#ef4444",
  dim: "#9ca3af",
};

/** Fleet uses ok / amber / red; docker uses warn / unhealthy / stopped. */
const TONE_RANK: Record<StatusTone, number> = { dim: 0, ok: 1, warn: 2, error: 3 };

/** Red > amber > green > grey. Used for a collapsed list's summary dot. */
export function worstStatusTone(tones: Iterable<StatusTone | undefined | null>): StatusTone | undefined {
  let worst: StatusTone | undefined;
  let rank = -1;
  for (const t of tones) {
    if (!t) continue;
    const r = TONE_RANK[t];
    if (r > rank) {
      worst = t;
      rank = r;
    }
  }
  return worst;
}

export function statusTone(status: string | undefined | null): StatusTone | undefined {
  const s = String(status ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if (s === "amber" || s === "warn" || s === "warning" || s === "unhealthy" || s === "restarting" || s === "degraded") {
    return "warn";
  }
  if (
    s === "red" ||
    s === "error" ||
    s === "down" ||
    s === "fail" ||
    s === "failed" ||
    s === "critical" ||
    s === "exited-with-error" ||
    /exited\s*\(\s*[1-9]/.test(s)
  ) {
    return "error";
  }
  if (s === "stopped" || s === "exited" || s.startsWith("exited") || s === "dead" || s === "paused" || s === "unknown") {
    return "dim";
  }
  return "ok";
}

export function fmtBytes(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || !(n > 0)) return "";
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 10e9 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 10e6 ? 0 : 1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${Math.round(n)} B`;
}
