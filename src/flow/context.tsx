import { createContext, useContext, useState, type ReactNode } from "react";
import { trpc } from "@/providers/trpc";
import { getLastLocation, setLastLocation } from "@/lib/lastLocation";
import type { FlowArea, FlowCapture, FlowHouse, FlowItem, FlowLocation, Place } from "./data";

type FlowState = {
  ready: boolean;
  items: FlowItem[];
  captures: FlowCapture[];
  houses: FlowHouse[];
  areas: FlowArea[];
  locations: FlowLocation[];
  /** where you stand right now - the default answer to "where is it?" */
  here: Place;
  setHere: (p: Place) => void;
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
  const [here, setHereState] = useState<Place>(() => getLastLocation());

  const value: FlowState = {
    ready: !!(items.data && captures.data && houses.data && areas.data),
    items: items.data ?? [],
    captures: captures.data ?? [],
    houses: houses.data ?? [],
    areas: areas.data ?? [],
    locations: locations.data ?? [],
    here,
    setHere: (p) => {
      setHereState(p);
      setLastLocation(p);
    },
    refresh: () => {
      utils.items.listAll.invalidate();
      utils.inbox.list.invalidate();
      utils.map.listLocations.invalidate();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFlow() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useFlow outside FlowProvider");
  return v;
}
