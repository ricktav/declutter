import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { logEvent } from "../lib/events";
import { ServicesReportError, applyServicesReport } from "../lib/services";

const rec = z.object({
  name: z.string().min(1).max(64),
  status: z.string().max(32).optional(),
  image: z.string().max(128).optional(),
  port: z.number().int().positive().max(65535).optional(),
  url: z.string().max(255).optional(),
});
const webRec = z.object({
  label: z.string().min(1).max(64),
  url: z.string().max(255).optional(),
  port: z.number().int().positive().max(65535).optional(),
});

/**
 * Snapshot of containers / node processes / web endpoints on a machine.
 * Collectors (scripts/services-report-local.mjs, scripts/services-report-fleet.mjs)
 * write the Systems `containers` / `node` / `web` attributes. The view does
 * not fetch claudemux HTML itself.
 */
export const servicesRouter = createRouter({
  report: procedure
    .input(
      z
        .object({
          itemId: z.number().int(),
          source: z.string().min(1).max(32),
          containers: z.array(rec).max(200).optional(),
          node: z.array(rec).max(100).optional(),
          web: z.array(webRec).max(100).optional(),
        })
        .refine((v) => v.containers !== undefined || v.node !== undefined || v.web !== undefined, {
          message: "Report a containers, node or web list.",
        }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      try {
        const result = await applyServicesReport(db, input);
        await logEvent({
          entityType: "item",
          entityId: input.itemId,
          action: "services.report",
          summary: `${input.source} reported ${result.containers} container(s)`,
          payload: { source: input.source, containers: result.containers, node: result.node, web: result.web },
        });
        return result;
      } catch (e) {
        if (e instanceof ServicesReportError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        throw e;
      }
    }),
});
