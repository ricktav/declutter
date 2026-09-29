// One-shot: remove the 3 demo items that earlier seed versions created.
// Safe to re-run; deletes nothing else. Usage: node db/remove-samples.mjs
import "dotenv/config";
import mysql from "mysql2/promise";

const SAMPLE_NAMES = ["ThinkPad X1 Carbon", "Synology DS923+", "Old Desktop (i5-8400)"];

const url = new URL(process.env.DATABASE_URL);
const conn = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
  ...(url.searchParams.get("ssl") ? { ssl: JSON.parse(url.searchParams.get("ssl")) } : {}),
});

const [rows] = await conn.query(
  `SELECT id, name FROM items WHERE name IN (?)`,
  [SAMPLE_NAMES],
);

if (rows.length === 0) {
  console.log("No sample items found — nothing to remove.");
  await conn.end();
  process.exit(0);
}

const ids = rows.map((r) => r.id);
await conn.query(`DELETE FROM time_logs WHERE taskId IN (SELECT id FROM tasks WHERE itemId IN (?))`, [ids]);
await conn.query(`DELETE FROM tasks WHERE itemId IN (?)`, [ids]);
await conn.query(`DELETE FROM attachments WHERE itemId IN (?)`, [ids]);
await conn.query(`DELETE FROM idea_items WHERE itemId IN (?)`, [ids]);
await conn.query(`DELETE FROM photo_annotations WHERE itemId IN (?)`, [ids]);
await conn.query(`DELETE FROM relations WHERE fromItemId IN (?) OR toItemId IN (?)`, [ids, ids]);
await conn.query(`DELETE FROM items WHERE id IN (?)`, [ids]);

console.log(`Removed ${rows.length} sample item(s): ${rows.map((r) => r.name).join(", ")}`);
await conn.end();
