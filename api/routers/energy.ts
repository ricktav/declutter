import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { EnergyReportError, applyEnergyReport } from "../lib/energy";

const n = z.number().nonnegative().finite();
const reportMonth = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  kwhNormal: n.optional(),
  kwhOffpeak: n.optional(),
  kwhReturnedNormal: n.optional(),
  kwhReturnedOffpeak: n.optional(),
  kwhProduced: n.optional(),
  avgW: n.optional(),
  baseW: n.optional(),
  peakW: n.optional(),
  hours: n.optional(),
});

/**
 * Energy per meter and month (spec: docs/superpowers/specs/2026-10-04-energy-lens-design.md).
 * Reports come from collectors on dockermac-1; they are measurements, so a
 * report writes no item event (AGENTS.md: live meter data is read-only).
 */
export const energyRouter = createRouter({
  report: procedure
    .input(z.object({ itemId: z.number().int(), source: z.string().min(1).max(32), months: z.array(reportMonth).min(1).max(200) }))
    .mutation(async ({ input }) => {
      try {
        return await applyEnergyReport(getDb(), input);
      } catch (e) {
        if (e instanceof EnergyReportError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        throw e;
      }
    }),
});
