import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { trpc } from "@/providers/trpc";

const CACHE_KEY = "declutter.ui.depth";

export const DEPTHS = ["quick", "standard", "detail"] as const;
export type Depth = (typeof DEPTHS)[number];

const RANK: Record<Depth, number> = { quick: 0, standard: 1, detail: 2 };

type DepthState = {
  depth: Depth;
  setDepth: (depth: Depth) => void;
  /** true when the current depth shows parts marked `min` */
  shows: (min: Depth) => boolean;
};

const Ctx = createContext<DepthState | null>(null);

function asDepth(v: unknown): Depth | null {
  return typeof v === "string" && (DEPTHS as readonly string[]).includes(v) ? (v as Depth) : null;
}

/**
 * One Workbench, three depths, stored on the server so every browser agrees.
 * localStorage only caches the last answer, so a reload does not flash the
 * wrong depth before settings.ui arrives.
 */
export function DepthProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  const [cached] = useState(() => {
    try {
      return asDepth(localStorage.getItem(CACHE_KEY));
    } catch {
      return null;
    }
  });
  const ui = trpc.settings.ui.useQuery(undefined, { staleTime: Infinity });
  const save = trpc.settings.setDepth.useMutation({
    onSuccess: (r) => utils.settings.ui.setData(undefined, { depth: r.depth, chosen: true }),
  });
  const depth = asDepth(ui.data?.depth) ?? cached ?? "detail";
  useEffect(() => {
    try {
      localStorage.setItem(CACHE_KEY, depth);
    } catch {
      // storage unavailable: the server value still applies
    }
  }, [depth]);
  const setDepth = (next: Depth) => {
    utils.settings.ui.setData(undefined, { depth: next, chosen: true });
    save.mutate({ depth: next });
  };
  const shows = (min: Depth) => RANK[depth] >= RANK[min];
  return <Ctx.Provider value={{ depth, setDepth, shows }}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useDepth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDepth must be used within DepthProvider");
  return ctx;
}

/** Renders its children only at `min` depth or deeper. */
export function AtDepth({ min, children }: { min: Depth; children: ReactNode }) {
  return useDepth().shows(min) ? <>{children}</> : null;
}
