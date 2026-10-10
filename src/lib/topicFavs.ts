import { useCallback, useEffect, useState } from "react";
import { useHouse } from "@/context/house";

export const TOPIC_FAVS_KEY = "declutter.topicFavs";

export type TopicFavStore = Record<string, number[]>;

function uniqueIds(ids: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function readTopicFavs(): TopicFavStore {
  try {
    const raw = localStorage.getItem(TOPIC_FAVS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: TopicFavStore = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const ids = uniqueIds(v.map((x) => Number(x)));
      if (ids.length) out[k] = ids;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeTopicFavs(store: TopicFavStore): void {
  try {
    localStorage.setItem(TOPIC_FAVS_KEY, JSON.stringify(store));
  } catch {
    // private browsing / quota — in-memory state still works
  }
}

/** One house's pins, or the union of every house when `houseId` is null. */
export function listedFavIds(store: TopicFavStore, houseId: number | null): number[] {
  if (houseId != null) return uniqueIds(store[String(houseId)] ?? []);
  const merged: number[] = [];
  if (store.all?.length) merged.push(...store.all);
  for (const [k, ids] of Object.entries(store)) {
    if (k === "all") continue;
    merged.push(...ids);
  }
  return uniqueIds(merged);
}

export function isTopicFaved(store: TopicFavStore, houseId: number | null, areaId: number): boolean {
  return listedFavIds(store, houseId).includes(areaId);
}

export function toggleTopicFav(store: TopicFavStore, houseId: number | null, areaId: number): TopicFavStore {
  if (houseId != null) {
    const k = String(houseId);
    const cur = store[k] ?? [];
    const next = cur.includes(areaId) ? cur.filter((id) => id !== areaId) : [...cur, areaId];
    const copy = { ...store };
    if (next.length) copy[k] = next;
    else delete copy[k];
    return copy;
  }
  if (listedFavIds(store, null).includes(areaId)) {
    const copy: TopicFavStore = {};
    for (const [k, ids] of Object.entries(store)) {
      const next = ids.filter((id) => id !== areaId);
      if (next.length) copy[k] = next;
    }
    return copy;
  }
  return { ...store, all: uniqueIds([...(store.all ?? []), areaId]) };
}

export function useTopicFavs() {
  const { houseId } = useHouse();
  const [store, setStore] = useState<TopicFavStore>(readTopicFavs);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== TOPIC_FAVS_KEY) return;
      setStore(readTopicFavs());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const favIds = listedFavIds(store, houseId);
  const toggle = useCallback(
    (areaId: number) => {
      setStore((prev) => {
        const next = toggleTopicFav(prev, houseId, areaId);
        writeTopicFavs(next);
        return next;
      });
    },
    [houseId],
  );
  const isFaved = useCallback((areaId: number) => favIds.includes(areaId), [favIds]);
  return { favIds, toggle, isFaved };
}
