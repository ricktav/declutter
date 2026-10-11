#!/usr/bin/env -S node --experimental-strip-types
// Dry-run: report duplicate uncropped photo files (same sha256) and what a
// cleanup would do. Does not write. Does not delete.
//
//   node --experimental-strip-types scripts/photos-dedup.ts
//   node --experimental-strip-types scripts/photos-dedup.ts --url <mysql url>
//
// --apply is structured but disabled (DEDUP_APPLY_ENABLED). When it is
// flipped on, pass --apply --i-have-a-snapshot after a MySQL dump of
// declutter and a copy of uploads/.
import "dotenv/config";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";
import {
  applyGuard,
  applyPhotosDedupPlan,
  buildPhotosDedupPlan,
  formatPhotosDedupReport,
  type DedupPhoto,
  type DedupPin,
} from "../api/lib/photosDedup.ts";

const args = process.argv.slice(2);
const guard = applyGuard(args);
if (guard.mode === "blocked") {
  console.error(guard.message);
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

const c = await mysql.createConnection({ uri: url });
try {
  const [photos] = await c.query<mysql.RowDataPacket[]>(
    "select id, itemId, sourceCaptureId, storageKey, cropBox, title from photos order by id",
  );
  const [pins] = await c.query<mysql.RowDataPacket[]>("select id, photoId, itemId from photo_pins");
  const [links] = await c.query<mysql.RowDataPacket[]>("select storageKey from item_links where storageKey is not null");
  const [caps] = await c.query<mysql.RowDataPacket[]>("select storageKey from captures where storageKey is not null");
  const rows = photos as PhotoRow[];
  const pinRows = pins as DedupPin[];
  const otherFileRefs = [
    ...(links as { storageKey: string }[]).map((r) => r.storageKey),
    ...(caps as { storageKey: string }[]).map((r) => r.storageKey),
  ];

  const hashed: DedupPhoto[] = [];
  let missing = 0;
  for (const p of rows) {
    const abs = pathOf(p.storageKey);
    if (!fs.existsSync(abs)) {
      missing++;
      hashed.push({ ...p, hash: "" });
      continue;
    }
    const hash = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    hashed.push({ ...p, hash });
  }

  const plan = buildPhotosDedupPlan({ photos: hashed, pins: pinRows, otherFileRefs });
  console.log(formatPhotosDedupReport(plan, { missing }));

  if (guard.mode === "apply") {
    await applyPhotosDedupPlan(plan, {
      createPin: async () => {
        throw new Error("photos-dedup apply I/O is not wired yet");
      },
      rePointPin: async () => {
        throw new Error("photos-dedup apply I/O is not wired yet");
      },
      removePhotoRow: async () => {
        throw new Error("photos-dedup apply I/O is not wired yet");
      },
      deleteFileIfUnused: async () => {
        throw new Error("photos-dedup apply I/O is not wired yet");
      },
    });
  }
} finally {
  await c.end();
}
