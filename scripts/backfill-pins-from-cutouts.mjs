// scripts/backfill-pins-from-cutouts.mjs
// Cutouts made before inbox.fileObject and photos.createCutout pinned their
// item in the source photo left the item's "Seen in photos" empty. For every
// cutout (a photo with itemId, sourceCaptureId and cropBox) this adds a
// confirmed pin for the item on the capture's location photo (same
// sourceCaptureId, no itemId), with the cutout's box and the item's name.
// A (photo, item) pair that already has a pin is left alone, so a second run
// changes nothing. Cutouts whose capture has no location photo are only counted.
//
// Usage:
//   node scripts/backfill-pins-from-cutouts.mjs                 dry run on DATABASE_URL (reads only)
//   node scripts/backfill-pins-from-cutouts.mjs --apply         write the pins
//   node scripts/backfill-pins-from-cutouts.mjs --url <mysql url> [--apply]   another database
import "dotenv/config";
import mysql from "mysql2/promise";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const urlAt = args.indexOf("--url");
const url = urlAt >= 0 ? args[urlAt + 1] : process.env.DATABASE_URL;
if (!url) {
  console.error(urlAt >= 0 ? "--url needs a mysql URL" : "DATABASE_URL is not set (or pass --url <mysql url>)");
  process.exit(1);
}

const c = await mysql.createConnection({ uri: url });
try {
  const [cutouts] = await c.query(
    `select p.id, p.itemId, p.sourceCaptureId, p.cropBox, i.name as itemName
       from photos p left join items i on i.id = p.itemId
      where p.itemId is not null and p.sourceCaptureId is not null and p.cropBox is not null
      order by p.id`,
  );
  const [locations] = await c.query(
    "select id, sourceCaptureId from photos where itemId is null and sourceCaptureId is not null order by id",
  );
  // the oldest location photo of a capture is the one the pin canvas opens
  const locationByCapture = new Map();
  for (const l of locations) if (!locationByCapture.has(l.sourceCaptureId)) locationByCapture.set(l.sourceCaptureId, l.id);
  const [pins] = await c.query("select photoId, itemId from photo_pins where itemId is not null");
  const pinned = new Set(pins.map((p) => `${p.photoId}|${p.itemId}`));

  let created = 0;
  let withoutLocation = 0;
  let badBox = 0;
  for (const cut of cutouts) {
    const photoId = locationByCapture.get(cut.sourceCaptureId);
    if (photoId == null) {
      withoutLocation++;
      continue;
    }
    const key = `${photoId}|${cut.itemId}`;
    if (pinned.has(key)) continue;
    const box = typeof cut.cropBox === "string" ? JSON.parse(cut.cropBox) : cut.cropBox;
    if (![box?.xPct, box?.yPct, box?.wPct, box?.hPct].every((n) => typeof n === "number")) {
      badBox++;
      continue;
    }
    pinned.add(key);
    created++;
    if (apply) {
      await c.query(
        `insert into photo_pins (photoId, itemId, xPct, yPct, wPct, hPct, label, origin, status)
         values (?, ?, ?, ?, ?, ?, ?, 'user', 'confirmed')`,
        [photoId, cut.itemId, box.xPct, box.yPct, box.wPct, box.hPct, (cut.itemName ?? "").slice(0, 255)],
      );
    }
  }

  const db = new URL(url).pathname.slice(1);
  console.log(
    `${apply ? "Applied" : "Dry run"} on ${db}: ${cutouts.length} cutouts, ${created} pins ${apply ? "created" : "to create"}, ` +
      `${withoutLocation} without a location photo${badBox ? `, ${badBox} with an unreadable box` : ""}`,
  );
} finally {
  await c.end();
}
