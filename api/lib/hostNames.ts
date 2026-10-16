/** Host and IP normalisation shared by the storage tracker and the fleet collector. */

export function normalizeIp(s: string | null | undefined): string | null {
  if (s == null) return null;
  const m = String(s).trim().match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return m ? m[1] : null;
}

export function normHost(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\.local\b/g, "")
    .replace(/\.(lan|home|internal)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}
