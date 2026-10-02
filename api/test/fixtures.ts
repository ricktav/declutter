// api/test/fixtures.ts
import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import { captures, itemLinks, photos } from "@db/schema";
import { getTestDb } from "./db";

/**
 * Real image bytes for tests (sharp rejects a 4-byte JPEG stub). uploads/ is
 * shared with the live database when tests run in the serving tree
 * (AGENTS.md section 3), so every file gets a fresh random name, and
 * removeTestUploads() only deletes names this suite can have produced:
 * fixture files (test-<12 hex>.jpg) and putFile() outputs (<12 hex>-...),
 * read from rows that this test itself created after resetTestDb().
 */
const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
const OURS = /^local\/(test-[0-9a-f]{12}\.jpg|[0-9a-f]{12}-.+)$/;
const written: string[] = [];

export function keyPath(key: string): string {
  return path.join(UPLOAD_DIR, key.replace(/^local\//, ""));
}

/** A real 64x48 JPEG under uploads/ with a unique name; returns its storage key. */
export async function writeTestJpeg(): Promise<string> {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const key = `local/test-${crypto.randomBytes(6).toString("hex")}.jpg`;
  const bytes = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } },
  })
    .jpeg()
    .toBuffer();
  fs.writeFileSync(keyPath(key), bytes);
  written.push(key);
  return key;
}

/** afterEach: delete every file this test wrote or made the app write. */
export async function removeTestUploads(): Promise<void> {
  const db = getTestDb();
  const keys = [
    ...written.splice(0),
    ...(await db.select({ k: photos.storageKey }).from(photos)).map((r) => r.k),
    ...(await db.select({ k: itemLinks.storageKey }).from(itemLinks)).map((r) => r.k),
    ...(await db.select({ k: captures.storageKey }).from(captures)).map((r) => r.k),
  ];
  for (const k of keys) if (k && OURS.test(k)) fs.rmSync(keyPath(k), { force: true });
}
