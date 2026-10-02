import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { trpc } from "@/providers/trpc";
import { setLastRoomId } from "@/lib/lastRoom";
import { useHouse } from "@/context/house";
import { useLastRoomId } from "@/hooks/use-last-room";
import type { FlowArea, FlowCapture, FlowItem, FlowLocation, Place } from "./data";
import { BACKS_UP, getLens, storeLens, type LensKey, type Rel } from "./lenses";

type FlowState = {
  ready: boolean;
  items: FlowItem[];
  captures: FlowCapture[];
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
  const areas = trpc.areas.list.useQuery();
  const locations = trpc.rooms.list.useQuery();
  // loaded in every mode: the data-safety check before "Gone" needs it
  const rels = trpc.items.listRelations.useQuery({ type: BACKS_UP });
  // start from the last-used room once it is known to exist in this house,
  // unless the user has already chosen (or cleared) a place
  const lastRoomId = useLastRoomId();
  const { houseId } = useHouse();
  const [here, setHereState] = useState<Place>({ roomId: null });
  const [touched, setTouched] = useState(false);
  // a room id belongs to one house: switching house forgets the old place
  const [prevHouseId, setPrevHouseId] = useState(houseId);
  if (prevHouseId !== houseId) {
    setPrevHouseId(houseId);
    setHereState({ roomId: null });
    setTouched(false);
  }
  if (prevHouseId === houseId && !touched && here.roomId == null && lastRoomId != null) setHereState({ roomId: lastRoomId });
  // never hand out a room that is not in the current house's list
  const effectiveHere = useMemo<Place>(
    () =>
      here.roomId != null && locations.isSuccess && !locations.data.some((l) => l.id === here.roomId)
        ? { roomId: null }
        : here,
    [here, locations.isSuccess, locations.data],
  );
  const [lens, setLensState] = useState<LensKey | null>(() => getLens());

  const backups = useMemo(() => {
    const active = new Set((items.data ?? []).filter((it) => it.status === "active").map((it) => it.id));
    return (rels.data ?? []).filter((r) => r.status === "confirmed" && active.has(r.fromItemId));
  }, [items.data, rels.data]);

  const value: FlowState = {
    ready: !!(items.data && captures.data && areas.data),
    items: items.data ?? [],
    captures: captures.data ?? [],
    areas: areas.data ?? [],
    locations: locations.data ?? [],
    backups,
    here: effectiveHere,
    setHere: (p) => {
      setTouched(true);
      setHereState(p);
      setLastRoomId(p.roomId);
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
      utils.rooms.list.invalidate();
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
