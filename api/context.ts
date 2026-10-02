import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { parseHouseId } from "./lib/houseContext";

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  /** current building, from the x-house-id header; null = no context */
  houseId: number | null;
};

export async function createContext(opts: FetchCreateContextFnOptions): Promise<TrpcContext> {
  return { req: opts.req, resHeaders: opts.resHeaders, houseId: parseHouseId(opts.req.headers) };
}
