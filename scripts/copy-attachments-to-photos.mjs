// scripts/copy-attachments-to-photos.mjs
// Photos consolidation data move: runs between migrations 0005 and 0006.
// Reads DATABASE_URL from .env. Logic and tests: api/lib/copyAttachmentsToPhotos.ts
//
//   node scripts/copy-attachments-to-photos.mjs --plan
//       read-only: what would be copied, and which rows cannot be (exit 2 if any)
//   node scripts/copy-attachments-to-photos.mjs --copy [--accept-losses]
//       copy (idempotent), then verify; refuses while --plan lists blocking ids,
//       unless Rick ruled on them and --accept-losses is given
//   node scripts/copy-attachments-to-photos.mjs --verify
//       read-only: every source row has its copy with the same key fields (exit 3 if not)
import "dotenv/config";
import mysql from "mysql2/promise";
import { blockingIds, copyAttachmentsToPhotos, planCopy, verifyCopy } from "../api/lib/copyAttachmentsToPhotos.ts";

const mode = process.argv[2];
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
if (!["--plan", "--copy", "--verify"].includes(mode)) {
  console.error("usage: node scripts/copy-attachments-to-photos.mjs --plan | --copy [--accept-losses] | --verify");
  process.exit(1);
}

// dateStrings: TIMESTAMP values round-trip as strings, so the copy cannot shift them across the DST gap
const c = await mysql.createConnection({ uri: process.env.DATABASE_URL, dateStrings: true });
try {
  const plan = await planCopy(c);
  console.log("plan", plan);
  const blocking = blockingIds(plan);
  if (mode === "--plan") {
    process.exitCode = blocking.length ? 2 : 0;
  } else if (mode === "--verify") {
    const v = await verifyCopy(c);
    console.log("verify", v);
    process.exitCode = v.ok ? 0 : 3;
  } else if (blocking.length && !process.argv.includes("--accept-losses")) {
    console.error(
      `refusing to copy: attachment ids ${blocking.join(", ")} cannot be carried over faithfully (see plan). ` +
        "Ask Rick, then re-run with --accept-losses if he agrees to lose them.",
    );
    process.exitCode = 2;
  } else {
    console.log("copied", await copyAttachmentsToPhotos(c));
    console.log("note: if this run did not print `verify`, re-run `--copy` (the AUTO_INCREMENT bump is idempotent)");
    const v = await verifyCopy(c);
    console.log("verify", v);
    process.exitCode = v.ok ? 0 : 3;
  }
} finally {
  await c.end();
}
