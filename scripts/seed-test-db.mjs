#!/usr/bin/env node
// Fill the TEST database with a small two-house inventory for click-throughs
// (Workbench, Flow, the iOS app against a dev server):
//   node scripts/seed-test-db.mjs
// Reads TEST_DATABASE_URL from .env. Refuses a database whose name does not
// end in _test or that equals DATABASE_URL. Empties every table first (the
// test database is disposable, AGENTS.md section 3), then writes sample rows
// and real JPEGs under ./uploads named test-<hex>.jpg.
import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import mysql from "mysql2/promise";
import sharp from "sharp";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set.");
const test = new URL(url);
if (!test.pathname.endsWith("_test")) throw new Error(`Refusing ${test.pathname.slice(1)}: not a _test database.`);
if (process.env.DATABASE_URL) {
  const prod = new URL(process.env.DATABASE_URL);
  if (prod.hostname === test.hostname && prod.pathname === test.pathname) throw new Error("TEST_DATABASE_URL equals DATABASE_URL.");
}

const c = await mysql.createConnection({ uri: url, multipleStatements: true });
const [tables] = await c.query("select table_name as t from information_schema.tables where table_schema = database() and table_name <> '__drizzle_migrations'");
await c.query(`SET FOREIGN_KEY_CHECKS = 0; ${tables.map(({ t }) => `TRUNCATE TABLE \`${t}\`;`).join(" ")} SET FOREIGN_KEY_CHECKS = 1;`);

const uploads = path.resolve("uploads");
fs.mkdirSync(uploads, { recursive: true });
async function jpeg(r, g, b) {
  const key = `local/test-${crypto.randomBytes(6).toString("hex")}.jpg`;
  const bytes = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
  fs.writeFileSync(path.join(uploads, key.slice("local/".length)), bytes);
  return { key, size: bytes.length };
}
const ins = async (text, values = []) => (await c.query(text, values))[0].insertId;

const thuis = await ins("insert into houses (name) values (?)", ["Thuis"]);
const zomer = await ins("insert into houses (name) values (?)", ["Zomerhuis"]);
const computers = await ins("insert into areas (slug, name, icon, sortOrder) values ('computers', 'Computers', 'laptop', 0)");
const house = await ins("insert into areas (slug, name, icon, sortOrder) values ('house', 'House', 'home', 1)");
const room = (houseId, name, floor, w = null, d = null) =>
  ins("insert into rooms (houseId, name, floor, source, widthM, depthM) values (?, ?, ?, 'manual', ?, ?)", [houseId, name, floor, w, d]);
const keuken = await room(thuis, "Keuken", "ground", 3.2, 4.1);
const wall = (a, b) => ({ kind: "wall", points: [a, b] });
await c.query("update rooms set walls = ? where id = ?", [
  JSON.stringify([wall([0, 0], [3.2, 0]), wall([3.2, 0], [3.2, 4.1]), wall([3.2, 4.1], [0, 4.1]), wall([0, 4.1], [0, 0])]),
  keuken,
]);
const zolder = await room(thuis, "Zolder", "attic");
const kelder = await room(thuis, "Kelder", "basement");
const zKeuken = await room(zomer, "Keuken", "ground");

const item = (o) =>
  ins(
    "insert into items (areaId, name, houseId, roomId, parentId, verificationStatus, decision, decidedAt, attributes) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [o.areaId, o.name, o.houseId, o.roomId ?? null, o.parentId ?? null, o.verification ?? "confirmed", o.decision ?? null, o.decision ? new Date() : null, o.attributes ? JSON.stringify(o.attributes) : null],
  );
const kettle = await item({ areaId: house, name: "Waterkoker", houseId: thuis, roomId: keuken });
const toaster = await item({ areaId: house, name: "Broodrooster", houseId: thuis, roomId: keuken, decision: "keep" });
const chair = await item({ areaId: house, name: "Stoel", houseId: thuis, roomId: zolder });
await item({ areaId: house, name: "Lamp (detected)", houseId: thuis, roomId: keuken, verification: "detected" });
await item({ areaId: house, name: "Doos zonder plek", houseId: thuis });
const laptop = await item({ areaId: computers, name: "ThinkPad X220", houseId: thuis, roomId: zolder, attributes: { role: "laptop", model: "X220" } });
await item({ areaId: computers, name: "ThinkPad SSD", houseId: thuis, roomId: zolder, parentId: laptop, attributes: { role: "storage", drive_type: "ssd" } });
const pan = await item({ areaId: house, name: "Pan", houseId: zomer, roomId: zKeuken });

for (const [itemId, rgb] of [[kettle, [200, 120, 40]], [toaster, [40, 120, 200]], [pan, [120, 200, 40]], [chair, [90, 90, 90]], [laptop, [30, 30, 30]]]) {
  const f = await jpeg(...rgb);
  await c.query("insert into photos (itemId, storageKey, mimeType, size, title) values (?, ?, 'image/jpeg', ?, 'seed photo')", [itemId, f.key, f.size]);
}
await c.query("update items set pos = ? where id = ?", [JSON.stringify({ xM: 0.4, yM: 0.5, wM: 0.3, dM: 0.3, rotDeg: 0 }), kettle]);
await c.query("update items set pos = ? where id = ?", [JSON.stringify({ xM: 1.0, yM: 0.5, wM: 0.3, dM: 0.3, rotDeg: 0 }), toaster]);
const overview = await jpeg(160, 140, 110);
const keukenOverview = await ins("insert into photos (itemId, roomId, storageKey, mimeType, size, title) values (null, ?, ?, 'image/jpeg', ?, 'Keuken overview')", [keuken, overview.key, overview.size]);
// it was taken near the bottom wall, looking up the room (+y) at the kettle wall
await c.query("update photos set camera = ? where id = ?", [
  JSON.stringify({ xM: 1.6, yM: 3.8, headingDeg: 90, fovDeg: 60, heightM: 1.5 }),
  keukenOverview,
]);
const kettlePin = await ins(
  "insert into photo_pins (photoId, xPct, yPct, wPct, hPct, label, itemId, origin, status) values (?, 20, 30, 15, 15, 'Waterkoker', ?, 'user', 'confirmed')",
  [keukenOverview, kettle],
);
const capture = await jpeg(230, 230, 200);
await c.query("insert into captures (kind, storageKey, status) values ('image', ?, 'pending')", [capture.key]);

console.log(JSON.stringify({ houses: { thuis, zomer }, rooms: { keuken, zolder, kelder, zKeuken }, items: { kettle, laptop }, photos: { keukenOverview }, pins: { waterkoker: kettlePin } }));
await c.end();
