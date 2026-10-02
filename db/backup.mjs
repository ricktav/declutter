// Logical backup of the whole database to a single SQL file, without needing
// the mysql client tools. Usage: node db/backup.mjs [outfile]
// Reads DATABASE_URL from .env. Restore with any MySQL client:
//   mysql declutter < backup.sql   (or feed it to db/restore.mjs if added later)
import "dotenv/config";
import fs from "fs";
import mysql from "mysql2/promise";

const out = process.argv[2] ?? `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`;
const c = await mysql.createConnection({ uri: process.env.DATABASE_URL });
const [tables] = await c.query("select table_name t from information_schema.tables where table_schema = database() and table_type = 'BASE TABLE' order by 1");

const lines = ["SET FOREIGN_KEY_CHECKS=0;", "SET NAMES utf8mb4;"];
let rowsTotal = 0;
for (const { t } of tables) {
  const [[create]] = await c.query(`show create table \`${t}\``);
  lines.push(`DROP TABLE IF EXISTS \`${t}\`;`, create["Create Table"] + ";");
  const [rows] = await c.query(`select * from \`${t}\``);
  if (rows.length === 0) continue;
  const cols = Object.keys(rows[0]);
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const values = chunk
      .map((r) => "(" + cols.map((k) => c.escape(r[k] instanceof Date ? r[k] : typeof r[k] === "object" && r[k] !== null ? JSON.stringify(r[k]) : r[k])).join(",") + ")")
      .join(",\n");
    lines.push(`INSERT INTO \`${t}\` (${cols.map((k) => `\`${k}\``).join(",")}) VALUES\n${values};`);
  }
  rowsTotal += rows.length;
}
lines.push("SET FOREIGN_KEY_CHECKS=1;");
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log(`wrote ${out}: ${tables.length} tables, ${rowsTotal} rows, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
await c.end();
