import { describe, expect, it } from "vitest";
import { productionAuthProblem } from "../lib/auth";
import app from "../boot";
import type { Health } from "../lib/health";

describe("productionAuthProblem", () => {
  it("lets development start without a token", () => {
    expect(productionAuthProblem({ NODE_ENV: "development" })).toBeNull();
    expect(productionAuthProblem({})).toBeNull();
  });

  it("stops a production boot without a token and names both fixes", () => {
    const problem = productionAuthProblem({ NODE_ENV: "production", APP_TOKEN: "  " });
    expect(problem).toMatch(/APP_TOKEN/);
    expect(problem).toMatch(/ALLOW_OPEN_ACCESS=1/);
  });

  it("lets production start with a token, or open on purpose", () => {
    expect(productionAuthProblem({ NODE_ENV: "production", APP_TOKEN: "secret" })).toBeNull();
    expect(productionAuthProblem({ NODE_ENV: "production", ALLOW_OPEN_ACCESS: "1" })).toBeNull();
    expect(productionAuthProblem({ NODE_ENV: "production", ALLOW_OPEN_ACCESS: "true" })).not.toBeNull();
  });
});

describe("GET /api/health", () => {
  it("answers without the app token and reports the database and uploads", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Health;
    expect(body).toMatchObject({ ok: true, db: true, uploadsWritable: true });
    expect(typeof body.uptimeS).toBe("number");
  });
});
