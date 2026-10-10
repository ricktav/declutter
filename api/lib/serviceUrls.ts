const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i;

/** Prefer a LAN IP; fall back to hostname. Skip localhost-like values. */
export function pickReachHost(ip?: string | null, hostname?: string | null): string | null {
  const ipn = String(ip ?? "").trim();
  if (ipn && !LOCAL_HOST.test(ipn)) return ipn;
  const h = String(hostname ?? "").trim();
  if (h && !LOCAL_HOST.test(h)) return h;
  return null;
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

/** Fleet uses ok / amber / red; docker uses warn / unhealthy / stopped. */
export function statusTone(status: string | undefined | null): StatusTone | undefined {
  const s = String(status ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if (s === "amber" || s === "warn" || s === "warning" || s === "unhealthy" || s === "restarting" || s === "degraded") {
    return "warn";
  }
  if (s === "red" || s === "error" || s === "down" || s === "fail" || s === "failed" || s === "critical") {
    return "error";
  }
  if (s === "stopped" || s === "exited" || s === "dead" || s === "paused") return "dim";
  return "ok";
}
