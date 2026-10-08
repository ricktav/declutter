// api/routers/photos.ts
// Images: an item's photos, location photos, cutouts and the catalog.
// Took over the image half of the old attachments router and the two photo
// procedures of api/routers/map.ts.
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { captures, items, photos, type PhotoCamera } from "@db/schema";
import { readFileBytes, urlForKey, withNewFile } from "../lib/filestore";
import { releaseStoredFiles } from "../lib/entities";
import { cropPercent } from "../lib/crop";
import { logEvent } from "../lib/events";
import {
  addPhoto,
  attachPhotoToItem,
  CAMERA_FOV_DEFAULT,
  CAMERA_HEIGHT_DEFAULT,
  ensureLocationPhotoForCapture,
  ensurePinForCutout,
  listPhotoCatalog,
  removePhoto,
  setPhotoCamera,
  setPhotoRoom,
  suggestPhotoCamera,
  unlinkPhoto,
} from "../lib/photos";
import { roomPhotosFor } from "../lib/placement";

const cropBoxInput = z.object({
  xPct: z.number().min(0).max(100),
  yPct: z.number().min(0).max(100),
  wPct: z.number().min(1).max(100),
  hPct: z.number().min(1).max(100),
});

/** A camera in its room's frame (same frame as items.pos): heading 0 = +x,
 * counter-clockwise seen from above; the room bounds are checked server-side. */
const cameraInput = z.object({
  xM: z.number().finite().min(0),
  yM: z.number().finite().min(0),
  headingDeg: z.number().finite(),
  fovDeg: z.number().min(20).max(120).default(CAMERA_FOV_DEFAULT),
  heightM: z.number().min(0).max(5).default(CAMERA_HEIGHT_DEFAULT),
});

/** Room photos returned by photos.roomPhotos. */
const ROOM_PHOTOS_LIST_MAX = 60;

/** Bytes of a source file, or a readable error when it is gone from disk. */
async function readSourceBytes(key: string): Promise<Uint8Array> {
  try {
    return await readFileBytes(key);
  } catch {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Source photo is no longer available." });
  }
}

export const photosRouter = createRouter({
  /** Same-origin URL for any stored key (photo, capture, file). */
  url: procedure.input(z.object({ key: z.string() })).query(async ({ input }) => ({ url: await urlForKey(input.key) })),

  get: procedure.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const photo = await getDb().query.photos.findFirst({ where: eq(photos.id, input.id) });
    if (!photo) return { photo: null, url: null };
    return { photo, url: await urlForKey(photo.storageKey) };
  }),

  add: procedure
    .input(
      z.object({
        itemId: z.number().optional(),
        areaId: z.number().optional(),
        title: z.string().optional(),
        fileName: z.string().optional(),
        /** key returned by POST /api/upload */
        storageKey: z.string().startsWith("local/"),
      }),
    )
    .mutation(({ input }) => addPhoto(getDb(), input)),

  remove: procedure.input(z.object({ id: z.number() })).mutation(({ input }) => removePhoto(getDb(), input.id)),

  /** Un-pin a photo from its item without deleting it: it goes back to the
   * Photos pool, keeping the item's room so it does not lose its place. */
  unlink: procedure.input(z.object({ id: z.number() })).mutation(({ input }) => unlinkPhoto(getDb(), input.id)),

  /** Attach a bucket photo to an existing Thing (photo ids only; a capture
   * goes through ensureForCapture first). CONFLICT when the photo belongs to
   * another Thing (data.ownerId names it), unless force moves it; fromItemId
   * with force moves it only from that owner. PRECONDITION_FAILED when the
   * photo has pins on other Things. */
  attachToItem: procedure
    .input(z.object({ photoId: z.number(), itemId: z.number(), force: z.boolean().optional(), fromItemId: z.number().optional() }))
    .mutation(({ input }) => attachPhotoToItem(getDb(), input)),

  listForItem: procedure.input(z.object({ itemId: z.number() })).query(({ input }) =>
    getDb().select().from(photos).where(eq(photos.itemId, input.itemId)).orderBy(desc(photos.createdAt)),
  ),

  /** The original photo a cutout was cropped from, plus its current box, for the re-crop UI. */
  sourcePhoto: procedure.input(z.object({ photoId: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const photo = await db.query.photos.findFirst({ where: eq(photos.id, input.photoId) });
    if (!photo?.sourceCaptureId) return { available: false as const };
    const cap = await db.query.captures.findFirst({ where: eq(captures.id, photo.sourceCaptureId) });
    if (!cap?.storageKey) return { available: false as const };
    return { available: true as const, url: await urlForKey(cap.storageKey), cropBox: photo.cropBox ?? null };
  }),

  /** Re-crop a cutout from its source photo with a new box; replaces the file in place. */
  recrop: procedure.input(z.object({ photoId: z.number(), box: cropBoxInput })).mutation(async ({ input }) => {
    const db = getDb();
    const photo = await db.query.photos.findFirst({ where: eq(photos.id, input.photoId) });
    if (!photo?.sourceCaptureId) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This cutout has no source photo to re-crop from." });
    }
    const cap = await db.query.captures.findFirst({ where: eq(captures.id, photo.sourceCaptureId) });
    if (!cap?.storageKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Source photo is no longer available." });
    const cropped = await cropPercent(await readSourceBytes(cap.storageKey), input.box);
    const saved = await withNewFile(
      { bytes: new Uint8Array(cropped), fileName: `items/${photo.itemId ?? "photo"}/cutout-${Date.now()}.jpg`, contentType: "image/jpeg" },
      async (file) => {
        await db.transaction(async (tx) => {
          await tx.update(photos).set({ storageKey: file.key, size: file.size, cropBox: input.box, camera: null }).where(eq(photos.id, input.photoId));
          await logEvent(
            {
              entityType: "photo",
              entityId: input.photoId,
              action: "recropped",
              summary: `Cutout "${photo.title ?? input.photoId}" re-cropped from its source photo`,
            },
            tx,
          );
        });
        return file;
      },
    );
    await releaseStoredFiles(db, [photo.storageKey]);
    return { ok: true, storageKey: saved.key };
  }),

  /** Give an item a photo cropped out of another photo (its source capture
   * when it has one, else the photo itself), e.g. when pinning a new object. */
  createCutout: procedure
    .input(
      z.object({
        itemId: z.number(),
        sourcePhotoId: z.number(),
        box: cropBoxInput,
        photoSize: z.enum(["small", "medium", "big"]).default("big"),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const source = await db.query.photos.findFirst({ where: eq(photos.id, input.sourcePhotoId) });
      if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Source photo not found." });

      let bytes: Uint8Array;
      let sourceCaptureId: number | null = null;
      if (source.sourceCaptureId) {
        const cap = await db.query.captures.findFirst({ where: eq(captures.id, source.sourceCaptureId) });
        if (!cap?.storageKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Source photo is no longer available." });
        bytes = await readSourceBytes(cap.storageKey);
        sourceCaptureId = cap.id;
      } else {
        bytes = await readSourceBytes(source.storageKey);
      }

      // the cutout's item is in the source photo: pin it there too, so the
      // item's "Seen in photos" shows that photo
      const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found." });
      const pinFor = { sourcePhotoId: source.id, itemId: input.itemId, box: input.box, label: item.name };

      // one cutout per item and original photo (a whole Photo of the same capture is not a cutout): pinning again or re-saving does not pile up copies
      if (sourceCaptureId) {
        const dup = await db.query.photos.findFirst({
          where: and(eq(photos.itemId, input.itemId), eq(photos.sourceCaptureId, sourceCaptureId), isNotNull(photos.cropBox)),
        });
        if (dup) {
          await db.transaction((tx) => ensurePinForCutout(tx, pinFor));
          return { id: dup.id, storageKey: dup.storageKey, created: false as const };
        }
      }

      const maxDim = { small: 480, medium: 900, big: undefined }[input.photoSize];
      const cropped = await cropPercent(bytes, input.box, maxDim);
      return withNewFile(
        { bytes: new Uint8Array(cropped), fileName: `items/${input.itemId}/cutout-${Date.now()}.jpg`, contentType: "image/jpeg" },
        (saved) =>
          db.transaction(async (tx) => {
            const [{ id }] = await tx
              .insert(photos)
              .values({
                itemId: input.itemId,
                storageKey: saved.key,
                mimeType: "image/jpeg",
                size: saved.size,
                sourceCaptureId,
                cropBox: input.box,
                title: "Photo",
              })
              .$returningId();
            await logEvent(
              {
                entityType: "photo",
                entityId: id,
                action: "created",
                summary: `Photo cropped from pin location and added to item #${input.itemId}`,
              },
              tx,
            );
            await ensurePinForCutout(tx, pinFor);
            return { id, storageKey: saved.key, created: true as const };
          }),
      );
    }),

  listAll: procedure.query(() => listPhotoCatalog(getDb())),

  /** The photo pool for a room: every source capture behind the cutouts of the room's active items.
   * `camera` is the camera of the capture's location photo when that photo
   * stands in this room (null otherwise, or when it has no location photo yet).
   * `photoId` / `photoRoomId` are that location photo (null when none exists yet). */
  forRoom: procedure.input(z.object({ roomId: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const roomItems = await db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.status, "active"), eq(items.roomId, input.roomId)));
    if (!roomItems.length) return [];
    const cutouts = await db
      .select({ sourceCaptureId: photos.sourceCaptureId })
      .from(photos)
      .where(and(inArray(photos.itemId, roomItems.map((i) => i.id)), isNotNull(photos.sourceCaptureId)));
    const captureIds = [...new Set(cutouts.map((c) => c.sourceCaptureId).filter((x): x is number => x != null))];
    if (!captureIds.length) return [];
    const caps = await db
      .select({ id: captures.id, storageKey: captures.storageKey })
      .from(captures)
      .where(inArray(captures.id, captureIds))
      .orderBy(asc(captures.id));
    const locations = await db
      .select({ id: photos.id, sourceCaptureId: photos.sourceCaptureId, roomId: photos.roomId, camera: photos.camera })
      .from(photos)
      .where(and(inArray(photos.sourceCaptureId, captureIds), isNull(photos.itemId), isNull(photos.cropBox)))
      .orderBy(asc(photos.id));
    const locBy = new Map<number, { photoId: number; photoRoomId: number | null }>();
    const cameraBy = new Map<number, PhotoCamera>();
    for (const l of locations) {
      if (l.sourceCaptureId == null) continue;
      if (!locBy.has(l.sourceCaptureId)) locBy.set(l.sourceCaptureId, { photoId: l.id, photoRoomId: l.roomId });
      if (l.roomId !== input.roomId || !l.camera || cameraBy.has(l.sourceCaptureId)) continue;
      cameraBy.set(l.sourceCaptureId, l.camera);
    }
    return caps
      .filter((c): c is { id: number; storageKey: string } => !!c.storageKey)
      .map((c) => {
        const loc = locBy.get(c.id);
        return {
          ...c,
          camera: cameraBy.get(c.id) ?? null,
          photoId: loc?.photoId ?? null,
          photoRoomId: loc?.photoRoomId ?? null,
        };
      });
  }),

  /** Change a Photo's Place (null clears it). A new room clears its camera
   * (cameraCleared says so). BAD_REQUEST for a room in another house than
   * the photo's Thing. Pins and the Thing's room stay as they are. */
  setRoom: procedure
    .input(z.object({ id: z.number(), roomId: z.number().nullable() }))
    .mutation(({ input }) => setPhotoRoom(getDb(), input)),

  /** Stand a photo somewhere in its room, looking one way (null takes it
   * off the plan). Full photos with a room only; inside the room when it has
   * a size. Logs photo.camera on the photo's Thing, else on its room. */
  setCamera: procedure
    .input(z.object({ id: z.number(), camera: cameraInput.nullable() }))
    .mutation(({ input }) => setPhotoCamera(getDb(), input)),

  /** A room's photos with their cameras: full photos first, newest first, max 60.
   * Also a Thing's uncropped photos that stand in the room (camera set). */
  roomPhotos: procedure
    .input(z.object({ roomId: z.number() }))
    .query(({ input }) => roomPhotosFor(getDb(), input.roomId, { limit: ROOM_PHOTOS_LIST_MAX, withCameras: true })),

  /** A starting camera from the photo's pinned, placed Things (basis "pins"),
   * or the room's centre facing +x (basis "center"). Writes nothing. */
  suggestCamera: procedure.input(z.object({ id: z.number() })).query(({ input }) => suggestPhotoCamera(getDb(), input.id)),

  /** The pin canvas (/annotate/:photoId) works on a photo; a pool or inbox
   * image is only a capture until now. Find-or-create one bare, item-less
   * photo per capture (reused on repeat visits) so it becomes pinnable. */
  ensureForCapture: procedure
    .input(z.object({ captureId: z.number(), roomId: z.number().nullable().optional() }))
    .mutation(async ({ input }) => {
      const { photoId } = await ensureLocationPhotoForCapture(getDb(), input.captureId, input.roomId);
      return { photoId };
    }),
});
