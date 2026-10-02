// api/routers/itemLinks.ts
// Links, notes and non-image files on an item.
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { itemLinks } from "@db/schema";
import { addItemLink, removeItemLink } from "../lib/photos";

export const itemLinksRouter = createRouter({
  add: procedure
    .input(
      z.object({
        itemId: z.number(),
        areaId: z.number().optional(),
        kind: z.enum(["link", "note", "file"]),
        title: z.string().optional(),
        content: z.string().optional(),
        url: z.string().optional(),
        fileName: z.string().optional(),
        /** key returned by POST /api/upload, for kind "file" */
        storageKey: z.string().startsWith("local/").optional(),
        mimeType: z.string().optional(),
      }),
    )
    .mutation(({ input }) => addItemLink(getDb(), input)),

  remove: procedure.input(z.object({ id: z.number() })).mutation(({ input }) => removeItemLink(getDb(), input.id)),

  listForItem: procedure.input(z.object({ itemId: z.number() })).query(({ input }) =>
    getDb().select().from(itemLinks).where(eq(itemLinks.itemId, input.itemId)).orderBy(desc(itemLinks.createdAt)),
  ),
});
