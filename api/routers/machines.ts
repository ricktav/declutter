import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { applyRegisterImport, RegisterImportError } from "../lib/registerMachines";

/** Computer Things as machines: identity from the machine register. */
export const machinesRouter = createRouter({
  /**
   * Plan (dry, the default) or apply (`dry: false`) the machine register
   * (`GET /api/machines` of the Data Tracker) onto computer Things: match by
   * serial, then machine.id, then a card's MAC (all strong), then hostname / IP
   * (weak, written only with `acceptWeak`); fill serial, uuid, model,
   * machine.id, hostname, aliases, ip, mac and macs. Never creates, archives or renames a Thing. `scripts/machines-import-register.mjs`
   * is the client.
   */
  importRegister: procedure
    .input(z.object({ machines: z.unknown(), dry: z.boolean().optional(), acceptWeak: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      try {
        return await applyRegisterImport(getDb(), input);
      } catch (e) {
        if (e instanceof RegisterImportError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        throw e;
      }
    }),
});
