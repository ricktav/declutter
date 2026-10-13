// mysql2 + disk I/O for scripts/photos-dedup.ts apply. No drizzle / @db
// aliases — the script imports this under Node type stripping.
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import type { Connection, RowDataPacket } from "mysql2/promise";
import type { DedupApplyIo, DedupPhoto, DedupPin, PlannedPin, RePointPin } from "./photosDedup.ts";

type Row = RowDataPacket & Record<string, unknown>;

async function rows(c: Connection, sql: string, params: unknown[] = []): Promise<Row[]> {
  const [result] = await c.query<Row[]>(sql, params);
  return result;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Absolute path under uploadDir for a stored key (`local/…` or `uploads/…`). */
export function photosDedupPathOf(uploadDir: string, key: string): string {
  const root = path.resolve(uploadDir);
  const rel = key.startsWith("local/") ? key.slice("local/".length) : key.replace(/^uploads\//, "");
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("Invalid storage key");
  }
  return abs;
}

export async function loadPhotosDedupInput(
  c: Connection,
  pathOf: (key: string) => string,
): Promise<{ photos: DedupPhoto[]; pins: DedupPin[]; otherFileRefs: string[]; missing: number }> {
  const photoRows = await rows(c, "select id, itemId, sourceCaptureId, storageKey, cropBox, title from photos order by id");
  const pinRows = await rows(c, "select id, photoId, itemId from photo_pins");
  const linkRows = await rows(c, "select storageKey from item_links where storageKey is not null");
  const capRows = await rows(c, "select storageKey from captures where storageKey is not null");

  let missing = 0;
  const photos: DedupPhoto[] = [];
  for (const p of photoRows) {
    const id = num(p.id);
    if (id == null) continue;
    const storageKey = String(p.storageKey ?? "");
    const abs = pathOf(storageKey);
    let hash = "";
    if (!fs.existsSync(abs)) {
      missing++;
    } else {
      hash = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    }
    photos.push({
      id,
      itemId: num(p.itemId),
      sourceCaptureId: num(p.sourceCaptureId),
      storageKey,
      cropBox: p.cropBox ?? null,
      title: p.title == null ? null : String(p.title),
      hash,
    });
  }

  const pins: DedupPin[] = pinRows.flatMap((p) => {
    const id = num(p.id);
    const photoId = num(p.photoId);
    if (id == null || photoId == null) return [];
    return [{ id, photoId, itemId: num(p.itemId) }];
  });

  const otherFileRefs = [
    ...linkRows.map((r) => String(r.storageKey ?? "")),
    ...capRows.map((r) => String(r.storageKey ?? "")),
  ].filter(Boolean);

  return { photos, pins, otherFileRefs, missing };
}

export function makePhotosDedupApplyIo(c: Connection, opts: { pathOf: (key: string) => string }): DedupApplyIo {
  return {
    async withTransaction(work) {
      await c.beginTransaction();
      try {
        const result = await work();
        await c.commit();
        return result;
      } catch (err) {
        await c.rollback();
        throw err;
      }
    },
    createPin: (pin) => createPin(c, pin),
    rePointPin: (move) => rePointPin(c, move),
    removePhotoRow: (photoId) => removePhotoRow(c, photoId),
    deleteFileIfUnused: (storageKey) => deleteFileIfUnused(c, storageKey, opts.pathOf),
  };
}

async function createPin(c: Connection, pin: PlannedPin): Promise<void> {
  const existing = await rows(
    c,
    "select id from photo_pins where photoId = ? and itemId = ? limit 1",
    [pin.photoId, pin.itemId],
  );
  if (existing.length) return;
  const item = await rows(c, "select name from items where id = ?", [pin.itemId]);
  const label = String(item[0]?.name ?? "").slice(0, 255);
  await c.query(
    "insert into photo_pins (photoId, itemId, xPct, yPct, wPct, hPct, label, origin, status) values (?,?,?,?,?,?,?,'user','confirmed')",
    [pin.photoId, pin.itemId, pin.box.xPct, pin.box.yPct, pin.box.wPct, pin.box.hPct, label],
  );
}

async function rePointPin(c: Connection, move: RePointPin): Promise<void> {
  await c.query("update photo_pins set photoId = ? where id = ?", [move.toPhotoId, move.pinId]);
}

async function removePhotoRow(c: Connection, photoId: number): Promise<void> {
  await c.query("delete from photo_pins where photoId = ?", [photoId]);
  await c.query("delete from photos where id = ?", [photoId]);
}

async function deleteFileIfUnused(
  c: Connection,
  storageKey: string,
  pathOf: (key: string) => string,
): Promise<void> {
  const used = await rows(
    c,
    "select 1 as n from photos where storageKey = ? union all select 1 from item_links where storageKey = ? union all select 1 from captures where storageKey = ? limit 1",
    [storageKey, storageKey, storageKey],
  );
  if (used.length) return;
  fs.rmSync(pathOf(storageKey), { force: true });
}

