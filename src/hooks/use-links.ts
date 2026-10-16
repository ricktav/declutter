import { trpc } from "@/providers/trpc";

/** External links from Settings; each is null until set, and then not shown. */
export function useLinks() {
  const q = trpc.settings.links.useQuery(undefined, { staleTime: Infinity });
  return q.data ?? { meterkastUrl: null, parcelViewerUrl: null };
}
