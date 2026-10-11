#!/usr/bin/env -S node --experimental-strip-types
// Dry-run: report duplicate uncropped photo files (same sha256) and what a
// cleanup would do. Does not write. Does not delete.
//
//   node --experimental-strip-types scripts/photos-dedup.ts
//   node --experimental-strip-types scripts/photos-dedup.ts --url <mysql url>
import "dotenv/config";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";

const args = process.argv.slice(2);
if (args.includes("--apply") || args.includes("--write")) {
  console.error("This script is dry-run only. It will not clean up data.");
  process.exit(2);
}
const urlAt = args.indexOf("--url");
const url = urlAt >= 0 ? args[urlAt + 1] : process.env.DATABASE_URL;
if (!url) {
  console.error(urlAt >= 0 ? "--url needs a mysql URL" : "DATABASE_URL is not set (or pass --url <mysql url>)");
  process.exit(1);
}

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
function pathOf(key: string): string {
  const rel = key.startsWith("local/") ? key.slice("local/".length) : key.replace(/^uploads\//, "");
  return path.resolve(UPLOAD_DIR, rel);
}

type PhotoRow = {
  id: number;
  itemId: number | null;
  sourceCaptureId: number | null;
  storageKey: string;
  cropBox: unknown;
  title: string | null;
};
type PinRow = { id: number; photoId: number; itemId: number | null };

const c = await mysql.createConnection({ uri: url });
try {
  const [photos] = await c.query<mysql.RowDataPacket[]>(
    "select id, itemId, sourceCaptureId, storageKey, cropBox, title from photos order by id",
  );
  const [pins] = await c.query<mysql.RowDataPacket[]>("select id, photoId, itemId from photo_pins");
  const rows = photos as PhotoRow[];
  const pinRows = pins as PinRow[];

  const byHash = new Map<string, PhotoRow[]>();
  let missing = 0;
  for (const p of rows) {
    const abs = pathOf(p.storageKey);
    if (!fs.existsSync(abs)) {
      missing++;
      continue;
    }
    const hash = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    const g = byHash.get(hash) ?? [];
    g.push(p);
    byHash.set(hash, g);
  }

  const groups = [...byHash.entries()]
    .map(([hash, members]) => ({ hash, members }))
    .filter((g) => g.members.length > 1);

  let extraCopies = 0;
  let wouldRepointPins = 0;
  let wouldRemove = 0;
  const reports: string[] = [];

  for (const g of groups) {
    const uncropped = g.members.filter((p) => p.cropBox == null);
    if (uncropped.length < 2) continue;
    const keep =
      uncropped.find((p) => p.itemId == null) ??
      [...uncropped].sort((a, b) => a.id - b.id)[0];
    const extras = uncropped.filter((p) => p.id !== keep.id);
    extraCopies += extras.length;
    const extraIds = new Set(extras.map((p) => p.id));
    const movePins = pinRows.filter((pin) => extraIds.has(pin.photoId));
    wouldRepointPins += movePins.length;
    wouldRemove += extras.length;
    const capture = keep.sourceCaptureId ?? extras.find((p) => p.sourceCaptureId != null)?.sourceCaptureId ?? null;
    reports.push(
      [
        `hash ${g.hash.slice(0, 12)}…  ${uncropped.length} uncropped files  capture ${capture ?? "—"}`,
        `  keep photo #${keep.id}${keep.itemId == null ? " (location)" : ` (item #${keep.itemId})`}  ${keep.title ?? ""}`,
        ...extras.map((p) => {
          const n = movePins.filter((pin) => pin.photoId === p.id).length;
          return `  remove photo #${p.id}${p.itemId != null ? ` (item #${p.itemId})` : ""}  re-point ${n} pin(s) to #${keep.id}`;
        }),
      ].join("\n"),
    );
  }

  console.log(
    [
      "photos-dedup dry-run (no writes)",
      `${rows.length} photos, ${groups.length} sha256 groups with 2+ files, ${missing} missing on disk`,
      `${reports.length} uncropped duplicate groups, ${extraCopies} extra copies`,
      `cleanup would re-point ${wouldRepointPins} pin(s) and remove ${wouldRemove} uncropped copy row(s)`,
      "",
      ...reports,
    ]
      .filter((line, i, a) => !(line === "" && i === a.length - 1))
      .join("\n"),
  );
} finally {
  await c.end();
}
