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
  urls: z.array(z.string().max(255)).max(32).optional(),
  ports: z.array(z.number().int().positive().max(65535)).max(32).optional(),
  status: z.string().max(32).optional(),
});
const guestRec = z.object({
  vmid: z.number().int().nonnegative().max(999_999),
  name: z.string().min(1).max(64),
  status: z.string().max(32).optional(),
  memMb: z.number().nonnegative().max(1_000_000).optional(),
  diskGb: z.number().nonnegative().max(100_000).optional(),
  template: z.boolean().optional(),
});

/**
 * Snapshot of containers / node processes / web endpoints / Proxmox guests
 * on a machine. Collectors write Systems attributes; the view does not
 * fetch claudemux HTML or SSH to Proxmox itself.
 */
export const servicesRouter = createRouter({
  report: procedure
    .input(
      z
        .object({
          itemId: z.number().int(),
          source: z.string().min(1).max(32),
          merge: z.boolean().optional(),
          containers: z.array(rec).max(200).optional(),
          node: z.array(rec).max(100).optional(),
          web: z.array(webRec).max(100).optional(),
          vms: z.array(guestRec).max(100).optional(),
          lxc: z.array(guestRec).max(100).optional(),
        })
        .refine(
          (v) =>
            v.containers !== undefined ||
            v.node !== undefined ||
            v.web !== undefined ||
            v.vms !== undefined ||
            v.lxc !== undefined,
          { message: "Report a containers, node, web, vms or lxc list." },
        ),
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
          payload: {
            source: input.source,
            merge: input.merge === true,
            containers: result.containers,
            node: result.node,
            web: result.web,
            vms: result.vms,
            lxc: result.lxc,
          },
        });
        return result;
      } catch (e) {
        if (e instanceof ServicesReportError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        throw e;
      }
    }),
});
