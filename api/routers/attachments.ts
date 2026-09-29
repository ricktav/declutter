import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { attachments, photoAnnotations } from "@db/schema";
import { putFile, deleteStoredFile, urlForKey } from "../lib/filestore";
import { logEvent } from "../lib/events";

export const attachmentsRouter = createRouter({
  add: publicQuery
    .input(
      z.object({
        itemId: z.number().optional(),
        areaId: z.number().optional(),
        kind: z.enum(["image", "link", "note", "file"]),
        title: z.string().optional(),
        content: z.string().optional(),
        url: z.string().optional(),
        fileName: z.string().optional(),
        contentBase64: z.string().max(14_000_000).optional(), // ~10MB file
        mimeType: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      let storageKey: string | null = null;
      let size: number | null = null;

      if ((input.kind === "image" || input.kind === "file") && input.contentBase64) {
        const bytes = Uint8Array.from(Buffer.from(input.contentBase64, "base64"));
        const saved = await putFile({
          bytes,
          fileName: `attachments/${input.fileName ?? "file"}`,
          contentType: input.mimeType,
        });
        storageKey = saved.key;
        size = saved.size;
      }

      const [{ id }] = await db
        .insert(attachments)
        .values({
          itemId: input.itemId ?? null,
          areaId: input.areaId ?? null,
          kind: input.kind,
          title: input.title ?? null,
          content: input.content ?? null,
          url: input.url ?? null,
          storageKey,
          mimeType: input.mimeType ?? null,
          size,
        })
        .$returningId();
      await logEvent({
        entityType: "attachment",
        entityId: id,
        action: "created",
        summary: `${input.kind} attachment "${input.title ?? input.fileName ?? input.url ?? "note"}" added${input.itemId ? ` to item #${input.itemId}` : ""}`,
        payload: { itemId: input.itemId, areaId: input.areaId, kind: input.kind },
      });
      return { id, storageKey };
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const row = await db.query.attachments.findFirst({ where: eq(attachments.id, input.id) });
    if (row?.storageKey) {
      await deleteStoredFile(row.storageKey);
    }
    await db.delete(photoAnnotations).where(eq(photoAnnotations.attachmentId, input.id));
    await db.delete(attachments).where(eq(attachments.id, input.id));
    await logEvent({
      entityType: "attachment",
      entityId: input.id,
      action: "deleted",
      summary: `Attachment "${row?.title ?? input.id}" removed`,
    });
    return { ok: true };
  }),

  url: publicQuery.input(z.object({ key: z.string() })).query(async ({ input }) => {
    return { url: await urlForKey(input.key) };
  }),

  urlForAttachment: publicQuery
    .input(z.object({ attachmentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const att = await db.query.attachments.findFirst({
        where: eq(attachments.id, input.attachmentId),
      });
      if (!att) return { attachment: null, url: null };
      if (!att.storageKey) return { attachment: att, url: null };
      return { attachment: att, url: await urlForKey(att.storageKey) };
    }),

  listForItem: publicQuery.input(z.object({ itemId: z.number() })).query(({ input }) =>
    getDb()
      .select()
      .from(attachments)
      .where(eq(attachments.itemId, input.itemId))
      .orderBy(desc(attachments.createdAt)),
  ),
});
