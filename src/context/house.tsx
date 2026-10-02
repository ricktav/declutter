import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { trpc } from "@/providers/trpc";

export const HOUSE_STORAGE_KEY = "declutter.houseId";

// eslint-disable-next-line react-refresh/only-export-components
export function getStoredHouseId(): number | null {
  try {
    const raw = localStorage.getItem(HOUSE_STORAGE_KEY);
    const n = raw == null ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function storeHouseId(id: number | null) {
  try {
    if (id == null) localStorage.removeItem(HOUSE_STORAGE_KEY);
    else localStorage.setItem(HOUSE_STORAGE_KEY, String(id));
  } catch {
    // storage unavailable: the header still carries this session's choice
  }
}

type HouseState = {
  houseId: number | null;
  setHouseId: (id: number | null) => void;
  /** every house, for the switcher */
  houses: { id: number; name: string }[];
};

const Ctx = createContext<HouseState | null>(null);

/**
 * "Which building am I working in." One per session, remembered per
 * browser. Every tRPC call carries it (see providers/trpc.tsx) so server
 * lists default to this house.
 */
export function HouseProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  const houses = trpc.houses.list.useQuery();
  const [chosen, setState] = useState<number | null>(() => getStoredHouseId());

  // first run, or the stored house was deleted: fall back to the first house
  const valid = houses.data ? chosen != null && houses.data.some((h) => h.id === chosen) : true;
  const houseId = valid ? chosen : (houses.data?.[0]?.id ?? null);

  // persist the fallback so the header carries it, then refetch scoped lists
  useEffect(() => {
    if (houseId === chosen) return;
    storeHouseId(houseId);
    utils.invalidate();
  }, [houseId, chosen, utils]);

  // another tab switched house: follow it, and refetch everything scoped by it
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== HOUSE_STORAGE_KEY) return;
      setState(getStoredHouseId());
      utils.invalidate();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [utils]);

  const setHouseId = useCallback(
    (id: number | null) => {
      setState(id);
      storeHouseId(id);
      // every list in the app is scoped by the header; refetch all of them
      utils.invalidate();
    },
    [utils],
  );

  const value = useMemo(
    () => ({ houseId, setHouseId, houses: (houses.data ?? []).map((h) => ({ id: h.id, name: h.name })) }),
    [houseId, setHouseId, houses.data],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useHouse(): HouseState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useHouse outside HouseProvider");
  return v;
}
