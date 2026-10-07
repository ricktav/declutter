import { createContext, useContext, type ReactNode } from "react";
import { usePersistedState } from "@/hooks/use-persisted-state";

export type WorkbenchMode = "simple" | "advanced";

type WorkbenchModeState = {
  mode: WorkbenchMode;
  setMode: (mode: WorkbenchMode) => void;
};

const Ctx = createContext<WorkbenchModeState | null>(null);

function asMode(v: unknown): WorkbenchMode {
  return v === "simple" ? "simple" : "advanced";
}

/** One Workbench, two depths: Simple is room-first Focus; Advanced is the full OS. */
export function WorkbenchModeProvider({ children }: { children: ReactNode }) {
  const [raw, setRaw] = usePersistedState<WorkbenchMode>("workbenchMode", "advanced");
  const mode = asMode(raw);
  const setMode = (next: WorkbenchMode) => setRaw(asMode(next));
  return <Ctx.Provider value={{ mode, setMode }}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWorkbenchMode() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkbenchMode must be used within WorkbenchModeProvider");
  return ctx;
}
