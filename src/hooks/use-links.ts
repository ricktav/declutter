import { trpc } from "@/providers/trpc";

/** External links from Settings; null when turned off (or still loading), and then not shown. */
export function useLinks() {
  const q = trpc.settings.links.useQuery(undefined, { staleTime: Infinity });
  return q.data ?? { meterkastUrl: null, parcelViewerUrl: null, homebase3dUrl: null };
}
