import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import { TRPCProvider } from "@/providers/trpc"
import App from './App.tsx'
import { AuthGate } from "@/components/AuthGate"
import { HouseProvider } from "@/context/house"
import { WorkbenchModeProvider } from "@/context/workbenchMode"

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <TRPCProvider>
        <AuthGate>
          <HouseProvider>
            <WorkbenchModeProvider>
              <App />
            </WorkbenchModeProvider>
          </HouseProvider>
        </AuthGate>
      </TRPCProvider>
    </BrowserRouter>
  </StrictMode>,
)
