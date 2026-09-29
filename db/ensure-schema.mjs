// Idempotent schema patches — safe to re-run.
// Usage: node db/ensure-schema.mjs   (reads DATABASE_URL from .env)
import "dotenv/config";
import mysql from "mysql2/promise";

const url = new URL(process.env.DATABASE_URL);

const conn = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
  ...(url.searchParams.get("ssl")
    ? { ssl: JSON.parse(url.searchParams.get("ssl")) }
    : {}),
});

async function ensureColumn(table, column, ddl) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  if (Number(rows[0].n) === 0) {
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
    console.log(`added ${table}.${column}`);
  } else {
    console.log(`ok    ${table}.${column}`);
  }
}

await ensureColumn("photo_annotations", "wPct", "`wPct` double NULL");
await ensureColumn("photo_annotations", "hPct", "`hPct` double NULL");

await conn.end();
console.log("schema up to date");
