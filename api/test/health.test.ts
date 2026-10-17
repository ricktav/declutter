import { describe, expect, it } from "vitest";
import app from "../boot";
import type { Health } from "../lib/health";

describe("GET /api/health", () => {
  it("answers without the app token and reports the database and uploads", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Health;
    expect(body).toMatchObject({ ok: true, db: true, uploadsWritable: true });
    expect(typeof body.uptimeS).toBe("number");
  });
});
