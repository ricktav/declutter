// scripts/backfill-rooms.mjs — plain SQL version of the former api/lib/backfillRooms.ts
// Usage: node scripts/backfill-rooms.mjs   (reads DATABASE_URL from .env)
// Runs between migrations 0003 and 0004, while items/attachments still have floor/room.
import "dotenv/config";
import mysql from "mysql2/promise";

const c = await mysql.createConnection({ uri: process.env.DATABASE_URL });
const r = { roomsCreated: 0, itemsLinked: 0, attachmentsLinked: 0, floorsSet: 0 };
const norm = (s) => (s ?? "").trim().toLowerCase();
const [existing] = await c.query("select id, houseId, name, floor from rooms");
const byKey = new Map(existing.map((x) => [`${x.houseId}|${norm(x.name)}`, x]));

async function roomFor(houseId, name, floor) {
  const key = `${houseId}|${norm(name)}`;
  const hit = byKey.get(key);
  if (hit) {
    if (!hit.floor && floor) { await c.query("update rooms set floor=? where id=?", [floor, hit.id]); hit.floor = floor; r.floorsSet++; }
    return hit.id;
  }
  const [res] = await c.query("insert into rooms (houseId, name, floor, source) values (?,?,?,'manual')", [houseId, name.trim(), floor || null]);
  byKey.set(key, { id: res.insertId, houseId, name: name.trim(), floor: floor || null });
  r.roomsCreated++;
  return res.insertId;
}

const [placed] = await c.query("select i.floor, r.id, r.houseId, r.name, r.floor as roomFloor from items i join rooms r on r.id=i.roomId where i.floor is not null and r.floor is null");
for (const p of placed) { await c.query("update rooms set floor=? where id=? and floor is null", [p.floor, p.id]); r.floorsSet++; byKey.get(`${p.houseId}|${norm(p.name)}`).floor = p.floor; }

const [unplaced] = await c.query("select id, houseId, floor, room from items where roomId is null and houseId is not null and room is not null and trim(room) <> ''");
for (const it of unplaced) { const roomId = await roomFor(it.houseId, it.room, it.floor); await c.query("update items set roomId=? where id=?", [roomId, it.id]); r.itemsLinked++; }

const [photos] = await c.query("select id, houseId, floor, room from attachments where roomId is null and houseId is not null and room is not null and trim(room) <> ''");
for (const a of photos) { const roomId = await roomFor(a.houseId, a.room, a.floor); await c.query("update attachments set roomId=? where id=?", [roomId, a.id]); r.attachmentsLinked++; }

await c.query("update items i join rooms r on r.id=i.roomId set i.houseId=r.houseId where i.houseId <> r.houseId or i.houseId is null");
console.log(r);
await c.end();
