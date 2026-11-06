/** Server limit of `photos.urls` (ids and keys combined). */
export const PHOTO_URLS_MAX = 200;

/** Drops empty keys, dedupes keeping first order, splits into chunks of `size`. */
export function chunkKeys(keys: ReadonlyArray<string | null | undefined>, size = PHOTO_URLS_MAX): string[][] {
  const unique = [...new Set(keys.filter((k): k is string => !!k))];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}
