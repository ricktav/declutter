import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { isAuthorized } from "./lib/auth";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

const requireAuth = t.middleware(({ ctx, next }) => {
  if (!isAuthorized(ctx.req)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "App token required" });
  }
  return next();
});

export const createRouter = t.router;
/** Every procedure requires the app token when APP_TOKEN is configured. */
export const procedure = t.procedure.use(requireAuth);
