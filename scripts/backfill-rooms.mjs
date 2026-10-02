// HISTORICAL — ran once on production on 2026-10-02 before migration 0004; needs the pre-0004 columns and cannot run against the current schema
// scripts/backfill-rooms.mjs — plain SQL version of the former api/lib/backfillRooms.ts
// Usage: node scripts/backfill-rooms.mjs   (reads DATABASE_URL from .env)
// Runs between migrations 0003 and 0004, while items/attachments still have floor/room.
import "dotenv/config";
import mysql from "mysql2/promise";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const c = await mysql.createConnection({ uri: process.env.DATABASE_URL });
try {
  const r = { roomsCreated: 0, itemsLinked: 0, attachmentsLinked: 0, floorsSet: 0 };
  const norm = (s) => (s ?? "").trim().toLowerCase();
  const [existing] = await c.query("select id, houseId, name, floor from rooms");
  const byKey = new Map(existing.map((x) => [`${x.houseId}|${norm(x.name)}`, x]));

  async function roomFor(houseId, name, floor) {
    const key = `${houseId}|${norm(name)}`;
    const hit = byKey.get(key);
    if (hit) {
      if (!hit.floor && floor) {
        const [res] = await c.query("update rooms set floor=? where id=? and (floor is null or floor='')", [floor, hit.id]);
        hit.floor = floor;
        if (res.affectedRows > 0) r.floorsSet++;
      }
      return hit.id;
    }
    const [res] = await c.query("insert into rooms (houseId, name, floor, source) values (?,?,?,'manual')", [houseId, name.trim(), floor || null]);
    byKey.set(key, { id: res.insertId, houseId, name: name.trim(), floor: floor || null });
    r.roomsCreated++;
    return res.insertId;
  }

  const [placed] = await c.query("select i.floor, r.id, r.houseId, r.name, r.floor as roomFloor from items i join rooms r on r.id=i.roomId where nullif(i.floor,'') is not null and nullif(r.floor,'') is null");
  for (const p of placed) {
    const e = byKey.get(`${p.houseId}|${norm(p.name)}`);
    if (!e || e.floor) continue;
    const [res] = await c.query("update rooms set floor=? where id=? and (floor is null or floor='')", [p.floor, p.id]);
    e.floor = p.floor;
    if (res.affectedRows > 0) r.floorsSet++;
  }

  const [unplaced] = await c.query("select id, houseId, floor, room from items where roomId is null and houseId is not null and room is not null and trim(room) <> ''");
  for (const it of unplaced) {
    if (!it.room?.trim()) continue;
    const roomId = await roomFor(it.houseId, it.room, it.floor);
    await c.query("update items set roomId=? where id=?", [roomId, it.id]);
    r.itemsLinked++;
  }

  const [photos] = await c.query("select id, houseId, floor, room from attachments where roomId is null and houseId is not null and room is not null and trim(room) <> ''");
  for (const a of photos) {
    if (!a.room?.trim()) continue;
    const roomId = await roomFor(a.houseId, a.room, a.floor);
    await c.query("update attachments set roomId=? where id=?", [roomId, a.id]);
    r.attachmentsLinked++;
  }

  await c.query("update items i join rooms r on r.id=i.roomId set i.houseId=r.houseId where i.houseId <> r.houseId or i.houseId is null");
  console.log(r);
} finally {
  await c.end();
}
