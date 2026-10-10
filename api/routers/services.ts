import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { logEvent } from "../lib/events";
import { ServicesReportError, applyServicesReport } from "../lib/services";

const mountRec = z.object({
  source: z.string().max(255),
  dest: z.string().max(255),
  type: z.string().max(32).optional(),
  size: z.number().nonnegative().max(1e16).optional(),
});
const rec = z.object({
  name: z.string().min(1).max(64),
  status: z.string().max(32).optional(),
  image: z.string().max(128).optional(),
  port: z.number().int().positive().max(65535).optional(),
  ports: z.array(z.number().int().positive().max(65535)).max(32).optional(),
  url: z.string().max(255).optional(),
  size: z.number().nonnegative().max(1e16).optional(),
  imageSize: z.number().nonnegative().max(1e16).optional(),
  layers: z.number().int().nonnegative().max(10_000).optional(),
  created: z.string().max(32).optional(),
  mounts: z.array(mountRec).max(32).optional(),
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
  usedGb: z.number().nonnegative().max(100_000).optional(),
  template: z.boolean().optional(),
  disks: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        sizeGb: z.number().nonnegative().max(100_000).optional(),
        storage: z.string().max(64).optional(),
      }),
    )
    .max(16)
    .optional(),
  mounts: z.array(mountRec).max(32).optional(),
  ip: z.string().max(64).optional(),
  hostname: z.string().max(64).optional(),
  url: z.string().max(255).optional(),
  ports: z.array(z.number().int().positive().max(65535)).max(8).optional(),
});
const databaseRec = z.object({
  name: z.string().min(1).max(64),
  engine: z.string().max(32).optional(),
  status: z.string().max(32).optional(),
  port: z.number().int().positive().max(65535).optional(),
  size: z.number().nonnegative().max(1e16).optional(),
  url: z.string().max(255).optional(),
  target: z.string().max(255).optional(),
  detail: z.string().max(255).optional(),
  checked: z.string().max(40).optional(),
});
const projectRec = z.object({
  name: z.string().min(1).max(128),
  kind: z.string().max(32).optional(),
  status: z.string().max(32).optional(),
  tokens: z.number().nonnegative().max(1e15).optional(),
  size: z.number().nonnegative().max(1e16).optional(),
  updatedAt: z.string().max(40).optional(),
  minutes: z.number().nonnegative().max(1e7).optional(),
  url: z.string().max(255).optional(),
  path: z.string().max(255).optional(),
});

/**
 * Snapshot of containers / node processes / web endpoints / Proxmox guests /
 * databases / coding-agent projects on a machine. Collectors write Systems
 * attributes; the view does not fetch claudemux HTML, /projects/ or SSH to
 * Proxmox itself.
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
          databases: z.array(databaseRec).max(100).optional(),
          projects: z.array(projectRec).max(200).optional(),
        })
        .refine(
          (v) =>
            v.containers !== undefined ||
            v.node !== undefined ||
            v.web !== undefined ||
            v.vms !== undefined ||
            v.lxc !== undefined ||
            v.databases !== undefined ||
            v.projects !== undefined,
          { message: "Report a containers, node, web, vms, lxc, databases or projects list." },
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
            databases: result.databases,
            projects: result.projects,
          },
        });
        return result;
      } catch (e) {
        if (e instanceof ServicesReportError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        throw e;
      }
    }),
});
