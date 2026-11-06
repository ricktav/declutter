import { useMemo } from "react";
import { trpc } from "@/providers/trpc";
import { chunkKeys } from "@/lib/photoUrls";

/** One `photos.urls` row. */
export type PhotoUrlInfo = {
  id: number | null;
  key: string;
  url: string | null;
  width: number | null;
  height: number | null;
};

/** width / height when both are known and positive, else null. */
export function aspectOf(info: PhotoUrlInfo | undefined): number | null {
  const w = info?.width;
  const h = info?.height;
  return w != null && h != null && w > 0 && h > 0 ? w / h : null;
}

/**
 * Urls and pixel sizes for many storage keys in one `photos.urls` call per
 * 200 keys, instead of one `photos.url` query per Photo.
 */
export function usePhotoUrls(keys: ReadonlyArray<string | null | undefined>): {
  byKey: ReadonlyMap<string, PhotoUrlInfo>;
  isLoading: boolean;
} {
  const joined = keys.filter(Boolean).join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const chunks = useMemo(() => chunkKeys(keys), [joined]);
  const queries = trpc.useQueries((t) => chunks.map((c) => t.photos.urls({ keys: c })));
  const byKey = new Map<string, PhotoUrlInfo>();
  for (const q of queries) for (const row of q.data ?? []) byKey.set(row.key, row);
  return { byKey, isLoading: queries.some((q) => q.isPending) };
}
