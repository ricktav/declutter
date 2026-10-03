import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { TRPCProvider } from "@/providers/trpc";
import { AuthGate } from "@/components/AuthGate";
import { HouseProvider } from "@/context/house";
import { FlowApp } from "./FlowApp";

// Second front end on the same API and database as the Workbench (src/main.tsx):
// own entry page (flow/index.html), own shell, no shared routing.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TRPCProvider>
      <AuthGate>
        <HouseProvider>
          <FlowApp />
        </HouseProvider>
      </AuthGate>
    </TRPCProvider>
  </StrictMode>,
);
