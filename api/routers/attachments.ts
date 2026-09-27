import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, desc } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { attachments } from "@db/schema";
import { storage } from "../lib/storage";
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
        try {
          const saved = await storage.uploadFile({
            fileContent: bytes,
            fileName: `attachments/${input.fileName ?? "file"}`,
            contentType: input.mimeType,
          });
          storageKey = saved.key;
          size = saved.size;
        } catch (err) {
          const code = (err as { code?: string })?.code ?? "STORAGE_ERROR";
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              code === "STORAGE_NOT_PROVISIONED"
                ? "File storage is not provisioned yet. Publish (or reopen) the site once, then retry. Notes and links still work."
                : `Upload failed (${code})`,
          });
        }
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
      try {
        await storage.deleteFile({ fileKey: row.storageKey });
      } catch {
        // storage may be unprovisioned; still drop the row
      }
    }
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
    try {
      const { url } = await storage.getPresignedUrl({ key: input.key });
      return { url };
    } catch {
      return { url: null };
    }
  }),

  listForItem: publicQuery.input(z.object({ itemId: z.number() })).query(({ input }) =>
    getDb()
      .select()
      .from(attachments)
      .where(eq(attachments.itemId, input.itemId))
      .orderBy(desc(attachments.createdAt)),
  ),
});
