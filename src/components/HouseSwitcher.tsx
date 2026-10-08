import { lazy, Suspense, useId, useState } from "react";
import { Home, Map } from "lucide-react";
import { useHouse } from "@/context/house";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const HousesMap = lazy(() => import("@/components/HousesMap").then((m) => ({ default: m.HousesMap })));

/** The one place a session changes building. Rendered in both shells. */
export function HouseSwitcher({ dark = false }: { dark?: boolean }) {
  const id = useId();
  const { houseId, setHouseId, houses } = useHouse();
  const [mapOpen, setMapOpen] = useState(false);
  if (houses.length === 0) return null;
  return (
    <div className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] ${dark ? "bg-[#32361f] text-[#e0e0d0]" : "bg-muted"}`}>
      <label className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5">
        <Home className="h-4 w-4 shrink-0 opacity-70" />
        <select
          id={id}
          aria-label="Current house"
          className="min-w-0 flex-1 truncate bg-transparent outline-none"
          value={houseId ?? ""}
          onChange={(e) => setHouseId(e.target.value ? Number(e.target.value) : null)}
        >
          {houses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        title="Houses on the map"
        aria-label="Houses on the map"
        className={`shrink-0 rounded p-1 ${dark ? "text-[#b4b8a5] hover:bg-[#3a3f2e] hover:text-[#f4f4ed]" : "text-muted-foreground hover:bg-background hover:text-foreground"}`}
        onClick={() => setMapOpen(true)}
      >
        <Map className="h-4 w-4" />
      </button>
      <Dialog open={mapOpen} onOpenChange={setMapOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Houses</DialogTitle>
          </DialogHeader>
          <Suspense fallback={<div className="h-64 rounded-lg border border-border bg-muted/30" />}>
            <HousesMap
              onSelectHouse={(id) => {
                setHouseId(id);
                setMapOpen(false);
              }}
            />
          </Suspense>
        </DialogContent>
      </Dialog>
    </div>
  );
}
