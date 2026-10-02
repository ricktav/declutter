// Usage: node db/adopt-migrations.mjs <tag>
//   Marks every migration up to and including <tag> as applied, for a
//   database whose schema was created with `drizzle-kit push`. Run once,
//   then use `npm run db:migrate` from then on.
import "dotenv/config";
import fs from "fs";
import crypto from "crypto";
import mysql from "mysql2/promise";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: node db/adopt-migrations.mjs <migration tag, e.g. 0002_item_decision>");
  process.exit(1);
}
const journal = JSON.parse(fs.readFileSync("db/migrations/meta/_journal.json", "utf8"));
const entry = journal.entries.find((e) => e.tag === tag);
if (!entry) {
  console.error(`tag ${tag} not found in db/migrations/meta/_journal.json`);
  process.exit(1);
}
const sqlText = fs.readFileSync(`db/migrations/${tag}.sql`, "utf8");
const hash = crypto.createHash("sha256").update(sqlText).digest("hex");

const conn = await mysql.createConnection({ uri: process.env.DATABASE_URL });
await conn.query(
  "create table if not exists `__drizzle_migrations` (id serial primary key, hash text not null, created_at bigint)",
);
const [rows] = await conn.query("select created_at from `__drizzle_migrations` order by created_at desc limit 1");
if (rows.length && Number(rows[0].created_at) >= entry.when) {
  console.log(`already at or past ${tag}; nothing to do`);
} else {
  await conn.query("insert into `__drizzle_migrations` (hash, created_at) values (?, ?)", [hash, entry.when]);
  console.log(`marked ${tag} (${entry.when}) as applied`);
}
await conn.end();
