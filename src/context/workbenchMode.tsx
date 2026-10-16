import type { ReactNode } from "react";
import { DepthProvider, useDepth } from "@/context/depth";

export type WorkbenchMode = "simple" | "advanced";

/** Older two-state view of the depth: Quick is "simple", Standard and Detail are "advanced". */
export function WorkbenchModeProvider({ children }: { children: ReactNode }) {
  return <DepthProvider>{children}</DepthProvider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWorkbenchMode() {
  const { depth, setDepth } = useDepth();
  const mode: WorkbenchMode = depth === "quick" ? "simple" : "advanced";
  const setMode = (next: WorkbenchMode) => setDepth(next === "simple" ? "quick" : "detail");
  return { mode, setMode };
}
