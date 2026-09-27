import { createContext, useContext, useState, type ReactNode } from "react";
import { AskPanel } from "@/components/AskPanel";

export type AskScope = "global" | "area" | "item";

interface AskState {
  open: boolean;
  scope: AskScope;
  scopeId: number;
  label: string;
}

interface AskContextValue {
  openAsk: (scope: AskScope, scopeId: number, label: string) => void;
}

const AskContext = createContext<AskContextValue>({ openAsk: () => {} });

export function useAsk() {
  return useContext(AskContext);
}

export function AskProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AskState>({ open: false, scope: "global", scopeId: 0, label: "Inventory" });

  const openAsk = (scope: AskScope, scopeId: number, label: string) =>
    setState({ open: true, scope, scopeId, label });

  return (
    <AskContext.Provider value={{ openAsk }}>
      {children}
      <AskPanel
        open={state.open}
        onOpenChange={(open) => setState((s) => ({ ...s, open }))}
        scope={state.scope}
        scopeId={state.scopeId}
        label={state.label}
      />
    </AskContext.Provider>
  );
}
