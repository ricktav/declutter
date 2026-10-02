import { useState, type ReactNode } from "react";
import { trpc } from "@/providers/trpc";
import { setToken } from "@/lib/auth";
import { Button } from "@/components/ui/button";

/**
 * Blocks the app until the server accepts our token. When APP_TOKEN is not
 * configured on the server, ping succeeds and the gate is invisible.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const ping = trpc.ping.useQuery(undefined, { retry: false, staleTime: Infinity });
  const [draft, setDraft] = useState("");

  const unauthorized = ping.isError && (ping.error as { data?: { code?: string } })?.data?.code === "UNAUTHORIZED";

  if (ping.isPending) return null;
  if (!unauthorized) return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#282c20] text-[#e0e0d0] px-4">
      <form
        className="w-full max-w-sm rounded-lg bg-[#32361f] p-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const t = draft.trim();
          if (!t) return;
          setToken(t);
          location.reload();
        }}
      >
        <div>
          <div className="font-data text-[15px] font-semibold text-[#f4f4ed]">⌂ HomeBase</div>
          <p className="text-[13px] text-[#b4b8a5] mt-1">This server asks for its app token (APP_TOKEN in .env).</p>
        </div>
        <input
          id="app-token"
          type="password"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="App token"
          className="w-full rounded-md border border-[#4a4f3a] bg-[#282c20] px-3 py-2 text-[14px] text-[#f4f4ed] outline-none focus:border-[#d2ff00]"
        />
        <Button type="submit" className="w-full bg-[#d2ff00] text-[#282c20] hover:bg-[#e2ff4d]">
          Unlock
        </Button>
      </form>
    </div>
  );
}
