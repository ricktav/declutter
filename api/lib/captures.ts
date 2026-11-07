import { createHash } from "crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import { captures, houses, photos, rooms, type Capture } from "@db/schema";
import { logEvent } from "./events";
import { putFile, readFileBytes, deleteStoredFile } from "./filestore";
import { sniffMime } from "./sniff";
import { ensureLocationPhotoForCapture, setPhotoRoom } from "./photos";

type Db = ReturnType<typeof getDb>;

export type CaptureKind = "note" | "link" | "image" | "file" | "scan" | "voice";

export interface CreateCaptureInput {
  kind: CaptureKind;
  rawText?: string | null;
  url?: string | null;
  /** raw bytes (unattended channels such as the Telegram bot) */
  bytes?: Uint8Array;
  /** a key returned by POST /api/upload (the web UI) */
  storageKey?: string;
  fileName?: string;
  contentType?: string;
  exifGps?: { lat: number; lng: number } | null;
  /** who/what produced this capture, for the event log */
  source?: "user" | "telegram" | "system";
  /** session house when it landed; null = unknown until someone assigns one */
  houseId?: number | null;
}

/**
 * Single entry point for landing something in the inbox, used by the web
 * UI's inbox.create *and* any unattended ingestion channel (Telegram bot,
 * a future email/webhook intake). Keeping one path means every capture —
 * regardless of where it came from — gets the same storage/event handling,
 * and the "sacred raw input" file is written exactly once.
 */
export async function createCapture(input: CreateCaptureInput): Promise<Capture> {
  const db = getDb();
  let storageKey: string | null = null;
  let contentHash: string | null = null;

  let bytes = input.bytes;
  if (!bytes && input.storageKey) bytes = await readFileBytes(input.storageKey);

  if (bytes) {
    // content type comes from the bytes, never from the sender
    await sniffMime(bytes, input.fileName);
    contentHash = createHash("sha256").update(bytes).digest("hex");
    // same bytes already in the inbox (a re-sent Telegram photo, the same
    // file uploaded twice) - return that one instead of storing a duplicate
    const dup = await db.query.captures.findFirst({ where: eq(captures.contentHash, contentHash) });
    if (dup) {
      if (input.storageKey) await deleteStoredFile(input.storageKey).catch(() => {});
      return dup;
    }

    if (input.storageKey) {
      storageKey = input.storageKey;
    } else {
      const saved = await putFile({
        bytes,
        fileName: `inbox/${input.fileName ?? input.kind}`,
        contentType: input.contentType,
      });
      storageKey = saved.key;
    }
  }

  const [{ id }] = await db
    .insert(captures)
    .values({
      kind: input.kind,
      rawText: input.rawText ?? null,
      url: input.url ?? null,
      storageKey,
      contentHash,
      exifGps: input.exifGps ?? null,
      houseId: input.houseId ?? null,
    })
    .$returningId();

  await logEvent({
    entityType: "capture",
    entityId: id,
    action: "created",
    summary: `Inbox capture (${input.kind}) added${input.source && input.source !== "user" ? ` via ${input.source}` : ""}`,
    actor: input.source === "user" || !input.source ? "user" : "system",
  });

  const row = await db.query.captures.findFirst({ where: (c, { eq }) => eq(c.id, id) });
  if (!row) throw new Error("capture insert did not round-trip");
  return row;
}

/**
 * Stamp a house and/or Place on captures (inbox.assignPlace, and inbox.create
 * when a snap arrives with a roomId). Room wins (and sets the house). House
 * alone leaves the room for later, but drops a location photo's room when that
 * room lies in another house. Image captures get a location photo in the room
 * when a room is given. Never reads the session house.
 */
export async function assignCapturePlace(
  db: Db,
  ids: number[],
  sel: { houseId?: number | null; roomId?: number | null },
): Promise<{ count: number; houseId: number; roomId: number | null }> {
  const room = sel.roomId != null ? await db.query.rooms.findFirst({ where: eq(rooms.id, sel.roomId) }) : undefined;
  if (sel.roomId != null && !room) throw new TRPCError({ code: "BAD_REQUEST", message: "Place not found." });
  const houseId = room?.houseId ?? sel.houseId ?? null;
  if (houseId == null) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a house or a Place." });
  const [house] = await db.select({ id: houses.id, name: houses.name }).from(houses).where(eq(houses.id, houseId));
  if (!house) throw new TRPCError({ code: "BAD_REQUEST", message: "House not found." });

  const caps = await db.select().from(captures).where(inArray(captures.id, ids));
  let count = 0;
  for (const cap of caps) {
    if (sel.roomId != null && cap.kind === "image" && cap.storageKey) {
      const { photoId } = await ensureLocationPhotoForCapture(db, cap.id, sel.roomId);
      const [photo] = await db.select().from(photos).where(eq(photos.id, photoId));
      if (photo && photo.roomId !== sel.roomId) await setPhotoRoom(db, { id: photoId, roomId: sel.roomId });
    } else if (sel.roomId == null) {
      const [loc] = await db
        .select({ id: photos.id, roomId: photos.roomId })
        .from(photos)
        .where(and(eq(photos.sourceCaptureId, cap.id), isNull(photos.itemId)))
        .orderBy(asc(photos.id))
        .limit(1);
      if (loc?.roomId != null) {
        const [locRoom] = await db.select({ houseId: rooms.houseId }).from(rooms).where(eq(rooms.id, loc.roomId));
        if (locRoom && locRoom.houseId !== houseId) await setPhotoRoom(db, { id: loc.id, roomId: null });
      }
    }
    await db.update(captures).set({ houseId }).where(eq(captures.id, cap.id));
    await logEvent({
      entityType: "capture",
      entityId: cap.id,
      action: "placed",
      summary: room ? `Capture #${cap.id} Place set to ${room.name}` : `Capture #${cap.id} house set to ${house.name}`,
      payload: { houseId, roomId: sel.roomId ?? null },
    });
    count += 1;
  }
  return { count, houseId, roomId: sel.roomId ?? null };
}
