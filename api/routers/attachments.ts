// api/routers/attachments.ts
// DEPRECATED aliases, kept for one release (AGENTS.md section 2). Flow
// (src/flow/ui.tsx) and the Computer Lab adapter call attachments.url/add/
// remove/unlink/listAllImages/listForItem; their inputs and outputs are unchanged.
// Storage moved to photos (images) and item_links (link/note/file). Rows from
// item_links carry a NEGATED id so a number never means both a photo and a
// link; pass ids back to attachments.remove exactly as received.
// New code calls photos.*, itemLinks.* and pins.*.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { urlForKey } from "../lib/filestore";
import { addItemLink, addPhoto, legacyAttachmentsForItem, listPhotoCatalog, removeItemLink, removePhoto, unlinkPhoto } from "../lib/photos";

export const attachmentsRouter = createRouter({
  add: procedure
    .input(
      z.object({
        itemId: z.number().optional(),
        areaId: z.number().optional(),
        kind: z.enum(["image", "link", "note", "file"]),
        title: z.string().optional(),
        content: z.string().optional(),
        url: z.string().optional(),
        fileName: z.string().optional(),
        /** key returned by POST /api/upload */
        storageKey: z.string().startsWith("local/").optional(),
        mimeType: z.string().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<{ id: number; storageKey: string | null }> => {
      const db = getDb();
      if (input.kind === "image") {
        if (!input.storageKey) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "An image needs a storageKey from POST /api/upload." });
        }
        return addPhoto(db, {
          itemId: input.itemId,
          areaId: input.areaId,
          title: input.title,
          storageKey: input.storageKey,
          fileName: input.fileName,
        });
      }
      const link = await addItemLink(db, { ...input, kind: input.kind });
      return { id: -link.id, storageKey: link.storageKey };
    }),

  remove: procedure.input(z.object({ id: z.number() })).mutation(({ input }) => {
    const db = getDb();
    return input.id < 0 ? removeItemLink(db, -input.id) : removePhoto(db, input.id);
  }),

  unlink: procedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    if (input.id < 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Only a photo can be unlinked; remove a link or note with attachments.remove." });
    return unlinkPhoto(getDb(), input.id);
  }),

  url: procedure.input(z.object({ key: z.string() })).query(async ({ input }) => ({ url: await urlForKey(input.key) })),

  listForItem: procedure.input(z.object({ itemId: z.number() })).query(({ input }) => legacyAttachmentsForItem(getDb(), input.itemId)),

  listAllImages: procedure.query(async () =>
    (await listPhotoCatalog(getDb())).map((r) => ({ ...r, source: r.source === "photo" ? ("attachment" as const) : ("capture" as const) })),
  ),
});
