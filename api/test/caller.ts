import { appRouter } from "../router";

/** Build a caller the way a request with (or without) the house header would. */
export function callerFor(houseId: number | null) {
  const headers = new Headers({ authorization: "Bearer " + (process.env.APP_TOKEN ?? "") });
  if (houseId != null) headers.set("x-house-id", String(houseId));
  return appRouter.createCaller({
    req: new Request("http://test/api/trpc", { headers }),
    resHeaders: new Headers(),
    houseId,
  });
}
