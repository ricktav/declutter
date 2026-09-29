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
await ensureColumn("items", "houseId", "`houseId` bigint unsigned NULL");
await ensureColumn("items", "floor", "`floor` varchar(32) NULL");
await ensureColumn("items", "room", "`room` varchar(128) NULL");
await ensureColumn("items", "parentId", "`parentId` bigint unsigned NULL");

// PR #1 — rooms/geometry + verification gate (additive; nothing queries these yet)
await ensureColumn("items", "roomId", "`roomId` bigint unsigned NULL");
await ensureColumn("items", "verificationStatus", "`verificationStatus` varchar(32) NOT NULL DEFAULT 'confirmed'");
await ensureColumn("items", "pos", "`pos` json NULL");
await ensureColumn("attachments", "houseId", "`houseId` bigint unsigned NULL");
await ensureColumn("attachments", "roomId", "`roomId` bigint unsigned NULL");
await ensureColumn("captures", "exifGps", "`exifGps` json NULL");

// houses table (idempotent create)
await conn.query(`CREATE TABLE IF NOT EXISTS houses (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  name varchar(128) NOT NULL,
  address text NULL,
  lat double NULL,
  lng double NULL,
  notes text NULL,
  createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

// rooms — canonical geometry per house (PR #1)
await conn.query(`CREATE TABLE IF NOT EXISTS rooms (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  houseId bigint unsigned NOT NULL,
  name varchar(128) NOT NULL,
  source varchar(64) NOT NULL,
  scanDate timestamp NULL,
  widthM double NULL,
  depthM double NULL,
  wallHeightM double NULL,
  walls json NULL,
  openings json NULL,
  lat double NULL,
  lng double NULL,
  createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY rooms_house_idx (houseId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

// measurements — human-validated dimensions against a room or item (PR #1)
await conn.query(`CREATE TABLE IF NOT EXISTS measurements (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  targetType varchar(16) NOT NULL,
  targetId bigint unsigned NOT NULL,
  field varchar(64) NULL,
  valueM double NOT NULL,
  method varchar(32) NOT NULL,
  note text NULL,
  createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY meas_target_idx (targetType, targetId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

await conn.end();
console.log("schema up to date");
