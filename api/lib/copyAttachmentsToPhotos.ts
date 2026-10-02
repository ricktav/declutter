// HISTORICAL after migration 0006: reads attachments/photo_annotations, which 0006 drops. Run only between 0005 and 0006 (photos consolidation plan, Task 6).
// api/lib/copyAttachmentsToPhotos.ts
// One-off data move for the photos consolidation, run between migrations
// 0005 (add photos/item_links/photo_pins) and 0006 (drop attachments/
// photo_annotations). Plain SQL over a mysql2 connection and no imports from
// @db/schema, so this file still compiles after 0006, and
// scripts/copy-attachments-to-photos.mjs can import it under Node's type
// stripping (type-only imports, no enums).
//
// Ids are preserved: photos.id / item_links.id = the attachment's id,
// photo_pins.id = the annotation's id, photo_pins.photoId = its attachmentId.
// "Already copied" therefore means "a row with this id exists", which never
// collapses two notes or files that happen to look alike.
import type { Connection, RowDataPacket } from "mysql2/promise";

export interface CopyPlan {
  /** image attachments with a file: become photos */
  images: number;
  /** link/note/file attachments: become item_links */
  links: number;
  /** annotations on a copyable image: become photo_pins */
  pins: number;
  /** image attachments with no storageKey: NOT copied (photos.storageKey is NOT NULL) */
  imagesWithoutFile: number[];
  /** image attachments carrying content (e.g. a caption) or a url: copied as photos, but photos has no such columns, so the text is dropped */
  imagesWithText: number[];
  /** a kind outside image/link/note/file: NOT copied */
  unknownKind: number[];
  /** link/note/file rows that carry a roomId: copied, but item_links has no roomId */
  nonImageWithRoom: number[];
  /** annotations whose attachment is gone or not a copyable image: NOT copied (already unreachable in the UI) */
  orphanPins: number[];
}

export interface CopyResult {
  photosCreated: number;
  itemLinksCreated: number;
  pinsCreated: number;
}

export interface VerifyResult {
  missingPhotos: number;
  missingItemLinks: number;
  missingPins: number;
  /** copied rows whose key fields differ from their source; only meaningful before the new server writes */
  mismatched: number;
  ok: boolean;
}

type Row = RowDataPacket & Record<string, unknown>;

const LINK_KINDS = new Set(["link", "note", "file"]);

async function rows(c: Connection, sql: string, params: unknown[] = []): Promise<Row[]> {
  const [result] = await c.query<Row[]>(sql, params);
  return result;
}

function hasFile(key: unknown): boolean {
  return typeof key === "string" && key !== "";
}

/** mysql2 hands a JSON column back parsed; writing it back through `?` needs a string. */
function jsonOrNull(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

export async function planCopy(c: Connection): Promise<CopyPlan> {
  const plan: CopyPlan = { images: 0, links: 0, pins: 0, imagesWithoutFile: [], imagesWithText: [], unknownKind: [], nonImageWithRoom: [], orphanPins: [] };
  const copyable = new Set<number>();
  for (const a of await rows(c, "select id, kind, storageKey, roomId, content, url from attachments order by id")) {
    const id = Number(a.id);
    if (a.kind === "image") {
      if (hasFile(a.storageKey)) {
        plan.images++;
        copyable.add(id);
        if ((typeof a.content === "string" && a.content !== "") || a.url != null) plan.imagesWithText.push(id);
      } else {
        plan.imagesWithoutFile.push(id);
      }
    } else if (LINK_KINDS.has(String(a.kind))) {
      plan.links++;
      if (a.roomId != null) plan.nonImageWithRoom.push(id);
    } else {
      plan.unknownKind.push(id);
    }
  }
  for (const p of await rows(c, "select id, attachmentId from photo_annotations order by id")) {
    if (copyable.has(Number(p.attachmentId))) plan.pins++;
    else plan.orphanPins.push(Number(p.id));
  }
  return plan;
}

export function blockingIds(plan: CopyPlan): number[] {
  return [...plan.imagesWithoutFile, ...plan.imagesWithText, ...plan.unknownKind, ...plan.nonImageWithRoom];
}

export async function copyAttachmentsToPhotos(c: Connection): Promise<CopyResult> {
  const result: CopyResult = { photosCreated: 0, itemLinksCreated: 0, pinsCreated: 0 };
  await c.beginTransaction();
  try {
    const havePhoto = new Set((await rows(c, "select id from photos")).map((r) => Number(r.id)));
    const haveLink = new Set((await rows(c, "select id from item_links")).map((r) => Number(r.id)));
    const havePin = new Set((await rows(c, "select id from photo_pins")).map((r) => Number(r.id)));
    const copiedImages = new Set<number>();

    for (const a of await rows(c, "select * from attachments order by id")) {
      const id = Number(a.id);
      if (a.kind === "image") {
        if (!hasFile(a.storageKey)) continue; // listed by planCopy().imagesWithoutFile, never invented
        copiedImages.add(id);
        if (havePhoto.has(id)) continue;
        await c.query(
          "insert into photos (id, itemId, areaId, roomId, title, storageKey, mimeType, size, sourceCaptureId, cropBox, createdAt) values (?,?,?,?,?,?,?,?,?,?,?)",
          [id, a.itemId, a.areaId, a.roomId, a.title, a.storageKey, a.mimeType, a.size, a.sourceCaptureId, jsonOrNull(a.cropBox), a.createdAt],
        );
        result.photosCreated++;
      } else if (LINK_KINDS.has(String(a.kind))) {
        if (haveLink.has(id)) continue;
        await c.query(
          "insert into item_links (id, itemId, areaId, kind, title, content, url, storageKey, mimeType, size, sourceCaptureId, createdAt) values (?,?,?,?,?,?,?,?,?,?,?,?)",
          [id, a.itemId, a.areaId, a.kind, a.title, a.content, a.url, a.storageKey, a.mimeType, a.size, a.sourceCaptureId, a.createdAt],
        );
        result.itemLinksCreated++;
      }
    }

    for (const p of await rows(c, "select * from photo_annotations order by id")) {
      const id = Number(p.id);
      if (!copiedImages.has(Number(p.attachmentId)) || havePin.has(id)) continue;
      await c.query(
        "insert into photo_pins (id, photoId, xPct, yPct, wPct, hPct, label, itemId, origin, status, flagged, createdAt) values (?,?,?,?,?,?,?,?,?,?,?,?)",
        [id, p.attachmentId, p.xPct, p.yPct, p.wPct, p.hPct, p.label, p.itemId, p.origin, p.status, p.flagged, p.createdAt],
      );
      result.pinsCreated++;
    }
    await c.commit();
  } catch (err) {
    await c.rollback();
    throw err;
  }
  // The copied rows carry their legacy ids, so each new table's counter must
  // start above the largest legacy id (an explicit-id insert does not always
  // move it far enough, and the old sequences were larger). ALTER TABLE commits
  // implicitly, so these run after the transaction, with the value computed first.
  for (const [table, source] of [
    ["photos", "attachments"],
    ["item_links", "attachments"],
    ["photo_pins", "photo_annotations"],
  ] as const) {
    const next = Number((await rows(c, `select coalesce(max(id), 0) + 1 as n from ${source}`))[0].n);
    await c.query(`ALTER TABLE ${table} AUTO_INCREMENT = ${next}`);
  }
  return result;
}

export async function verifyCopy(c: Connection): Promise<VerifyResult> {
  const count = async (sql: string) => Number((await rows(c, sql))[0].n);
  const missingPhotos = await count(
    "select count(*) n from attachments a left join photos p on p.id = a.id where a.kind = 'image' and a.storageKey is not null and a.storageKey <> '' and p.id is null",
  );
  const missingItemLinks = await count(
    "select count(*) n from attachments a left join item_links l on l.id = a.id where a.kind in ('link','note','file') and l.id is null",
  );
  const missingPins = await count(
    "select count(*) n from photo_annotations x join attachments a on a.id = x.attachmentId and a.kind = 'image' and a.storageKey is not null and a.storageKey <> '' left join photo_pins p on p.id = x.id where p.id is null",
  );
  const mismatched =
    (await count(
      "select count(*) n from attachments a join photos p on p.id = a.id where a.kind = 'image' and not (p.storageKey <=> a.storageKey and p.itemId <=> a.itemId and p.roomId <=> a.roomId and p.sourceCaptureId <=> a.sourceCaptureId)",
    )) +
    (await count(
      "select count(*) n from attachments a join item_links l on l.id = a.id where a.kind in ('link','note','file') and not (l.kind <=> a.kind and l.itemId <=> a.itemId and l.content <=> a.content and l.url <=> a.url and l.storageKey <=> a.storageKey)",
    )) +
    (await count("select count(*) n from photo_annotations x join photo_pins p on p.id = x.id where not (p.photoId <=> x.attachmentId and p.itemId <=> x.itemId)"));
  return {
    missingPhotos,
    missingItemLinks,
    missingPins,
    mismatched,
    ok: missingPhotos + missingItemLinks + missingPins + mismatched === 0,
  };
}
