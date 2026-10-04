import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { isAuthorized } from "./lib/auth";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  // a CONFLICT about an owned photo carries the owner's id (cause.ownerId)
  // so the client can say which owner it agrees to move the photo from
  errorFormatter({ shape, error }) {
    const ownerId = (error.cause as { ownerId?: unknown } | undefined)?.ownerId;
    return typeof ownerId === "number" ? { ...shape, data: { ...shape.data, ownerId } } : shape;
  },
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
