/** The house the client is working in, sent as `x-house-id` on every call. */
export function parseHouseId(headers: Headers): number | null {
  const raw = headers.get("x-house-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
