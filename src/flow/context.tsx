import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { trpc } from "@/providers/trpc";
import { getLastLocation, setLastLocation } from "@/lib/lastLocation";
import type { FlowArea, FlowCapture, FlowHouse, FlowItem, FlowLocation, Place } from "./data";
import { BACKS_UP, getLens, storeLens, type LensKey, type Rel } from "./lenses";

type FlowState = {
  ready: boolean;
  items: FlowItem[];
  captures: FlowCapture[];
  houses: FlowHouse[];
  areas: FlowArea[];
  locations: FlowLocation[];
  /** confirmed "backs-up" links whose backup target is still in the house */
  backups: Rel[];
  /** where you stand right now - the default answer to "where is it?" */
  here: Place;
  setHere: (p: Place) => void;
  lens: LensKey | null;
  setLens: (l: LensKey | null) => void;
  refresh: () => void;
};

const Ctx = createContext<FlowState | null>(null);

export function FlowProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  // includeArchived: things marked gone stay counted in a sprint's progress
  const items = trpc.items.listAll.useQuery({ includeArchived: true });
  const captures = trpc.inbox.list.useQuery();
  const houses = trpc.houses.list.useQuery();
  const areas = trpc.areas.list.useQuery();
  const locations = trpc.map.listLocations.useQuery();
  // loaded in every mode: the data-safety check before "Gone" needs it
  const rels = trpc.items.listRelations.useQuery({ type: BACKS_UP });
  const [here, setHereState] = useState<Place>(() => getLastLocation());
  const [lens, setLensState] = useState<LensKey | null>(() => getLens());

  const backups = useMemo(() => {
    const active = new Set((items.data ?? []).filter((it) => it.status === "active").map((it) => it.id));
    return (rels.data ?? []).filter((r) => r.status === "confirmed" && active.has(r.fromItemId));
  }, [items.data, rels.data]);

  const value: FlowState = {
    ready: !!(items.data && captures.data && houses.data && areas.data),
    items: items.data ?? [],
    captures: captures.data ?? [],
    houses: houses.data ?? [],
    areas: areas.data ?? [],
    locations: locations.data ?? [],
    backups,
    here,
    setHere: (p) => {
      setHereState(p);
      setLastLocation(p);
    },
    lens,
    setLens: (l) => {
      setLensState(l);
      storeLens(l);
    },
    refresh: () => {
      utils.items.listAll.invalidate();
      utils.items.listRelations.invalidate();
      utils.inbox.list.invalidate();
      utils.map.listLocations.invalidate();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- the hook belongs with its provider
export function useFlow() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useFlow outside FlowProvider");
  return v;
}
