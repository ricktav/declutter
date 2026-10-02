/**
 * App token (shared secret). Stored in localStorage for the tRPC client's
 * Authorization header and mirrored into a cookie so plain <img src=
 * "/uploads/..."> requests pass the same check.
 */
const KEY = "declutter.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the cookie below still carries the session
  }
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = token
    ? `hb_token=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
    : `hb_token=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
