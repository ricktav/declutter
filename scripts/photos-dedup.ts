#!/usr/bin/env -S node --experimental-strip-types
// Report duplicate uncropped photo files (same sha256) and what a cleanup
// would do. Dry-run by default.
//
//   node --experimental-strip-types scripts/photos-dedup.ts
//   node --experimental-strip-types scripts/photos-dedup.ts --url <mysql url>
//
// Apply: DEDUP_APPLY_ENABLED=true --apply --i-have-a-snapshot after a MySQL
// dump of declutter and a copy of uploads/.
import "dotenv/config";
import path from "path";
import mysql from "mysql2/promise";
import {
  applyGuard,
  applyPhotosDedupPlan,
  buildPhotosDedupPlan,
  formatPhotosDedupReport,
} from "../api/lib/photosDedup.ts";
import { loadPhotosDedupInput, makePhotosDedupApplyIo, photosDedupPathOf } from "../api/lib/photosDedupApply.ts";

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
  return photosDedupPathOf(UPLOAD_DIR, key);
}

const c = await mysql.createConnection({ uri: url });
try {
  const loaded = await loadPhotosDedupInput(c, pathOf);
  const plan = buildPhotosDedupPlan(loaded);
  console.log(formatPhotosDedupReport(plan, { missing: loaded.missing }));

  if (guard.mode === "apply") {
    await applyPhotosDedupPlan(plan, makePhotosDedupApplyIo(c, { pathOf }));
  }
} finally {
  await c.end();
}
