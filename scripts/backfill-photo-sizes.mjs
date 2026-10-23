#!/usr/bin/env node
// Probe stored photos that have no pixel size yet and write width/height.
// Header-only (sharp metadata + EXIF orientation swap), never deletes.
// Dry run by default; --apply writes.
//
// Usage:
//   node scripts/backfill-photo-sizes.mjs                 dry run on DATABASE_URL (reads only)
//   node scripts/backfill-photo-sizes.mjs --apply         write the sizes
//   node scripts/backfill-photo-sizes.mjs --url <mysql url> [--apply]   another database
import "dotenv/config";
import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";
import sharp from "sharp";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const urlAt = args.indexOf("--url");
const url = urlAt >= 0 ? args[urlAt + 1] : process.env.DATABASE_URL;
if (!url) {
  console.error(urlAt >= 0 ? "--url needs a mysql URL" : "DATABASE_URL is not set (or pass --url <mysql url>)");
  process.exit(1);
}

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

function pathOf(key) {
  const rel = key.startsWith("local/") ? key.slice("local/".length) : key.replace(/^uploads\//, "");
  const abs = path.resolve(UPLOAD_DIR, rel);
  if (!abs.startsWith(UPLOAD_DIR + path.sep)) throw new Error("Invalid storage key");
  return abs;
}

/** Display size: EXIF orientations 5–8 swap width and height. */
async function imageSize(filePath) {
  const meta = await sharp(filePath).metadata();
  if (!meta.width || !meta.height) return null;
  const o = meta.orientation ?? 1;
  return o >= 5 ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
}

const c = await mysql.createConnection({ uri: url });
try {
  const [rows] = await c.query(
    "select id, storageKey, width, height from photos where width is null or height is null order by id",
  );
  let updated = 0;
  let missing = 0;
  let unreadable = 0;
  for (const row of rows) {
    let abs;
    try {
      abs = pathOf(row.storageKey);
    } catch {
      unreadable++;
      continue;
    }
    if (!fs.existsSync(abs)) {
      missing++;
      continue;
    }
    let size;
    try {
      size = await imageSize(abs);
    } catch {
      unreadable++;
      continue;
    }
    if (!size) {
      unreadable++;
      continue;
    }
    updated++;
    if (apply) await c.query("update photos set width = ?, height = ? where id = ?", [size.width, size.height, row.id]);
  }
  const db = new URL(url).pathname.slice(1);
  console.log(
    `${apply ? "Applied" : "Dry run"} on ${db}: ${rows.length} photos without a size, ` +
      `${updated} ${apply ? "updated" : "to update"}, ${missing} missing file, ${unreadable} unreadable`,
  );
} finally {
  await c.end();
}
