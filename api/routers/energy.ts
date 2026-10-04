import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { energyTariffs } from "@db/schema";
import { getDb } from "../queries/connection";
import { logEvent } from "../lib/events";
import { EnergyReportError, applyEnergyReport, energyForItem, energyOverview } from "../lib/energy";

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

/** A real calendar date as YYYY-MM-DD (the regex alone lets 2027-02-30 through). */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Not a calendar date.");
/** The largest value each tariff column holds (db/schema.ts energyTariffs: decimal(7,5) and decimal(6,3)). */
const price = n.max(99.99999);

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
  /** Scoped like storage.overview: the houseId input, else the session house; null covers all houses. */
  overview: procedure
    .input(z.object({ houseId: z.number().nullable().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const houseId = input?.houseId !== undefined ? input.houseId : ctx.houseId;
      return energyOverview(getDb(), houseId);
    }),

  /** A plug, or an item a plug powers: the plug's figures. NOT_FOUND only for a missing item. */
  forItem: procedure.input(z.object({ itemId: z.number().int() })).query(async ({ input }) => {
    const e = await energyForItem(getDb(), input.itemId);
    if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found." });
    return e;
  }),

  /** Rick's edit of the price list: upsert by validFrom, with an event (like storage.setRole). */
  setTariff: procedure
    .input(
      z.object({
        validFrom: isoDate,
        normal: price,
        offpeak: price,
        feedIn: price,
        feedInCost: price,
        fixedPerDay: n.max(999.999),
        note: z.string().max(128).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // toFixed avoids exponent notation in the decimal string
      const set = {
        normalEurKwh: input.normal.toFixed(5),
        offpeakEurKwh: input.offpeak.toFixed(5),
        feedInEurKwh: input.feedIn.toFixed(5),
        feedInCostEurKwh: input.feedInCost.toFixed(5),
        fixedEurDay: input.fixedPerDay.toFixed(3),
        note: input.note ?? null,
      };
      await getDb().insert(energyTariffs).values({ validFrom: input.validFrom, ...set }).onDuplicateKeyUpdate({ set });
      await logEvent({
        entityType: "energy",
        action: "energy.tariff",
        summary: `Price from ${input.validFrom}: €${input.normal}/kWh normal, €${input.offpeak}/kWh off-peak`,
        payload: input,
      });
      return { validFrom: input.validFrom };
    }),
});
