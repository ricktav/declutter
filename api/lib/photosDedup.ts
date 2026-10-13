// Pure plan for scripts/photos-dedup.ts. No DB, no filestore, no @db
// imports — the script hashes files and calls this. Apply is gated by
// DEDUP_APPLY_ENABLED=true plus --apply --i-have-a-snapshot.
//
// Live dry-run of the first script (248 photos, 18 groups, 60 extras)
// showed two holes this plan closes:
//   1. Removing an extra that is a Thing's only photo left it with no
//      photo and no pin. Plan creates a WHOLE_SCENE_BOX pin on the kept
//      photo first (same box acceptMany uses for a no-crop accept).
//   2. Some groups share one storageKey between keep and extras. A file
//      is deletable only when no remaining photo row (and no item_link
//      or capture) still points at it.

/** Same literal as WHOLE_SCENE_BOX in photos.ts. Duplicated so the dry-run
 * script can import this file without drizzle / @db path aliases. */
export const DEDUP_WHOLE_SCENE_BOX = { xPct: 50, yPct: 50, wPct: 0, hPct: 0 } as const;

/** Must equal the string `true` in the environment. `--apply` still needs
 * `--i-have-a-snapshot` after a DB snapshot. Read at call time so tests can
 * flip it. */
export function isDedupApplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEDUP_APPLY_ENABLED === "true";
}

export const APPLY_SNAPSHOT_FLAG = "--i-have-a-snapshot";

export type DedupPhoto = {
  id: number;
  itemId: number | null;
  sourceCaptureId: number | null;
  storageKey: string;
  cropBox: unknown;
  title: string | null;
  /** sha256 of the file bytes; empty when the file is missing on disk. */
  hash: string;
};

export type DedupPin = { id: number; photoId: number; itemId: number | null };

export type PlannedPin = {
  photoId: number;
  itemId: number;
  box: typeof DEDUP_WHOLE_SCENE_BOX;
  /** The Thing's only photo row is an extra being removed. */
  onlyPhotoRemoved: boolean;
  extraPhotoId: number;
};

export type RePointPin = { pinId: number; fromPhotoId: number; toPhotoId: number; itemId: number | null };

export type SharedFile = {
  storageKey: string;
  remainingPhotoIds: number[];
  extraPhotoIds: number[];
};

export type DedupGroup = {
  hash: string;
  keep: DedupPhoto;
  extras: DedupPhoto[];
  createPins: PlannedPin[];
  rePointPins: RePointPin[];
  captureId: number | null;
};

export type PhotosDedupPlan = {
  groups: DedupGroup[];
  createPins: PlannedPin[];
  rePointPins: RePointPin[];
  removePhotoIds: number[];
  deleteFiles: string[];
  sharedFiles: SharedFile[];
  otherRefFiles: string[];
  totals: {
    photos: number;
    hashGroups: number;
    uncroppedGroups: number;
    extras: number;
    createPins: number;
    orphanPins: number;
    rePointPins: number;
    removePhotos: number;
    deleteFiles: number;
    sharedFiles: number;
    otherRefFiles: number;
  };
};

export function isUncropped(photo: { cropBox: unknown }): boolean {
  return photo.cropBox == null;
}

export function pickKeep(uncropped: DedupPhoto[]): DedupPhoto {
  return uncropped.find((p) => p.itemId == null) ?? [...uncropped].sort((a, b) => a.id - b.id)[0];
}

export function applyGuard(args: string[]): { mode: "dry-run" } | { mode: "blocked"; message: string } | { mode: "apply" } {
  const wantsApply = args.includes("--apply") || args.includes("--write");
  if (!wantsApply) return { mode: "dry-run" };
  const snapshot =
    "When you enable it: take a MySQL snapshot of declutter and a copy of uploads/, then set DEDUP_APPLY_ENABLED=true and pass --apply --i-have-a-snapshot.";
  if (!isDedupApplyEnabled()) {
    return {
      mode: "blocked",
      message: ["photos-dedup --apply is not enabled yet (DEDUP_APPLY_ENABLED is not 'true').", snapshot].join("\n"),
    };
  }
  if (!args.includes(APPLY_SNAPSHOT_FLAG)) {
    return {
      mode: "blocked",
      message: [
        "photos-dedup --apply needs --i-have-a-snapshot after a MySQL dump of declutter and a copy of uploads/.",
        snapshot,
      ].join("\n"),
    };
  }
  return { mode: "apply" };
}

export type DedupApplyIo = {
  /** DB writes only. Files are unlinked after this resolves (after commit). */
  withTransaction: <T>(work: () => Promise<T>) => Promise<T>;
  createPin: (pin: PlannedPin) => Promise<void>;
  rePointPin: (move: RePointPin) => Promise<void>;
  removePhotoRow: (photoId: number) => Promise<void>;
  deleteFileIfUnused: (storageKey: string) => Promise<void>;
};

/** Pins first, then extra rows, inside one transaction; files only after commit.
 * deleteFileIfUnused must still refcount (a capture, link, or remaining photo). */
export async function applyPhotosDedupPlan(plan: PhotosDedupPlan, io: DedupApplyIo): Promise<void> {
  if (!isDedupApplyEnabled()) {
    throw new Error(
      "photos-dedup apply is not enabled (DEDUP_APPLY_ENABLED is not 'true'). Take a DB snapshot first.",
    );
  }
  await io.withTransaction(async () => {
    for (const pin of plan.createPins) await io.createPin(pin);
    for (const move of plan.rePointPins) await io.rePointPin(move);
    for (const id of plan.removePhotoIds) await io.removePhotoRow(id);
  });
  for (const key of plan.deleteFiles) await io.deleteFileIfUnused(key);
}

export function buildPhotosDedupPlan(input: {
  photos: DedupPhoto[];
  pins: DedupPin[];
  otherFileRefs?: string[];
}): PhotosDedupPlan {
  const photos = input.photos;
  const pins = input.pins;
  const otherFileRefs = input.otherFileRefs ?? [];

  const byHash = new Map<string, DedupPhoto[]>();
  for (const p of photos) {
    if (!p.hash) continue;
    const g = byHash.get(p.hash) ?? [];
    g.push(p);
    byHash.set(p.hash, g);
  }
  const hashGroups = [...byHash.values()].filter((m) => m.length > 1);

  const groups: DedupGroup[] = [];
  for (const members of hashGroups) {
    const uncropped = members.filter(isUncropped);
    if (uncropped.length < 2) continue;
    const keep = pickKeep(uncropped);
    const extras = uncropped.filter((p) => p.id !== keep.id);
    groups.push({
      hash: keep.hash,
      keep,
      extras,
      createPins: [],
      rePointPins: [],
      captureId: keep.sourceCaptureId ?? extras.find((p) => p.sourceCaptureId != null)?.sourceCaptureId ?? null,
    });
  }

  const removePhotoIds = new Set(groups.flatMap((g) => g.extras.map((p) => p.id)));
  const remainingByItem = new Map<number, number[]>();
  for (const p of photos) {
    if (p.itemId == null || removePhotoIds.has(p.id)) continue;
    const list = remainingByItem.get(p.itemId) ?? [];
    list.push(p.id);
    remainingByItem.set(p.itemId, list);
  }

  const pinsOn = (photoId: number) => pins.filter((pin) => pin.photoId === photoId);

  for (const g of groups) {
    const keepItemPins = new Set(pinsOn(g.keep.id).map((pin) => pin.itemId).filter((id): id is number => id != null));
    for (const extra of g.extras) {
      for (const pin of pinsOn(extra.id)) {
        if (pin.itemId != null && keepItemPins.has(pin.itemId)) continue;
        g.rePointPins.push({ pinId: pin.id, fromPhotoId: extra.id, toPhotoId: g.keep.id, itemId: pin.itemId });
        if (pin.itemId != null) keepItemPins.add(pin.itemId);
      }
    }
    const plannedItems = new Set<number>();
    for (const extra of g.extras) {
      if (extra.itemId == null || plannedItems.has(extra.itemId)) continue;
      plannedItems.add(extra.itemId);
      if (keepItemPins.has(extra.itemId)) continue;
      const onlyPhotoRemoved = (remainingByItem.get(extra.itemId) ?? []).length === 0;
      g.createPins.push({
        photoId: g.keep.id,
        itemId: extra.itemId,
        box: DEDUP_WHOLE_SCENE_BOX,
        onlyPhotoRemoved,
        extraPhotoId: extra.id,
      });
      keepItemPins.add(extra.itemId);
    }
  }

  const createPins = groups.flatMap((g) => g.createPins);
  const rePointPins = groups.flatMap((g) => g.rePointPins);
  const extraByKey = new Map<string, number[]>();
  for (const g of groups) {
    for (const extra of g.extras) {
      const list = extraByKey.get(extra.storageKey) ?? [];
      list.push(extra.id);
      extraByKey.set(extra.storageKey, list);
    }
  }

  const remainingByKey = new Map<string, number[]>();
  for (const p of photos) {
    if (removePhotoIds.has(p.id)) continue;
    const list = remainingByKey.get(p.storageKey) ?? [];
    list.push(p.id);
    remainingByKey.set(p.storageKey, list);
  }
  const otherRefSet = new Set(otherFileRefs.filter(Boolean));

  const deleteFiles: string[] = [];
  const sharedFiles: SharedFile[] = [];
  const otherRefFiles: string[] = [];
  for (const [storageKey, extraPhotoIds] of extraByKey) {
    const remainingPhotoIds = remainingByKey.get(storageKey) ?? [];
    if (remainingPhotoIds.length > 0) {
      sharedFiles.push({ storageKey, remainingPhotoIds, extraPhotoIds });
      continue;
    }
    if (otherRefSet.has(storageKey)) {
      otherRefFiles.push(storageKey);
      continue;
    }
    deleteFiles.push(storageKey);
  }

  const removeIds = [...removePhotoIds].sort((a, b) => a - b);
  return {
    groups,
    createPins,
    rePointPins,
    removePhotoIds: removeIds,
    deleteFiles,
    sharedFiles,
    otherRefFiles,
    totals: {
      photos: photos.length,
      hashGroups: hashGroups.length,
      uncroppedGroups: groups.length,
      extras: removeIds.length,
      createPins: createPins.length,
      orphanPins: createPins.filter((p) => p.onlyPhotoRemoved).length,
      rePointPins: rePointPins.length,
      removePhotos: removeIds.length,
      deleteFiles: deleteFiles.length,
      sharedFiles: sharedFiles.length,
      otherRefFiles: otherRefFiles.length,
    },
  };
}

export function formatPhotosDedupReport(plan: PhotosDedupPlan, extra?: { missing?: number }): string {
  const missing = extra?.missing ?? 0;
  const t = plan.totals;
  const reports = plan.groups.map((g) => {
    const lines = [
      `hash ${g.hash.slice(0, 12)}…  ${g.extras.length + 1} uncropped files  capture ${g.captureId ?? "—"}`,
      `  keep photo #${g.keep.id}${g.keep.itemId == null ? " (location)" : ` (item #${g.keep.itemId})`}  ${g.keep.title ?? ""}`.trimEnd(),
    ];
    for (const pin of g.createPins) {
      const why = pin.onlyPhotoRemoved
        ? `only photo #${pin.extraPhotoId} would be removed`
        : `link item #${pin.itemId} to the kept scene`;
      lines.push(`  pin item #${pin.itemId} on #${pin.photoId} (WHOLE_SCENE_BOX)  ${why}`);
    }
    for (const extra of g.extras) {
      const n = g.rePointPins.filter((pin) => pin.fromPhotoId === extra.id).length;
      const shared = plan.sharedFiles.some((f) => f.storageKey === extra.storageKey);
      const other = plan.otherRefFiles.includes(extra.storageKey);
      const fileNote = shared
        ? "same file as a remaining photo — will not delete file"
        : other
          ? "file still referenced by a capture or link — will not delete file"
          : extra.storageKey === g.keep.storageKey
            ? "same file as keep — will not delete file"
            : "would delete file if unused";
      lines.push(
        `  remove photo #${extra.id}${extra.itemId != null ? ` (item #${extra.itemId})` : ""}  re-point ${n} pin(s) to #${g.keep.id}  ${fileNote}`,
      );
    }
    return lines.join("\n");
  });

  return [
    "photos-dedup dry-run (no writes)",
    `${t.photos} photos, ${t.hashGroups} sha256 groups with 2+ files, ${missing} missing on disk`,
    `${t.uncroppedGroups} uncropped duplicate groups, ${t.extras} extra copies`,
    `would create ${t.createPins} whole-scene pin(s) on kept photos (${t.orphanPins} Thing(s) would otherwise have no photo and no pin)`,
    `would re-point ${t.rePointPins} pin(s) and remove ${t.removePhotos} uncropped copy row(s)`,
    `would delete ${t.deleteFiles} file(s); keep ${t.sharedFiles} shared file(s) still referenced by a remaining photo` +
      (t.otherRefFiles ? `; keep ${t.otherRefFiles} file(s) referenced by a capture or link` : ""),
    "",
    ...reports,
  ]
    .filter((line, i, a) => !(line === "" && i === a.length - 1))
    .join("\n");
}
