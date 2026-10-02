import { afterAll } from "vitest";
import { setDbForTests } from "../queries/connection";
import { getTestDb, closeTestDb } from "./db";

// Runs in every test worker before the test file's imports execute:
// the app's getDb() now returns the test database for the whole file.
setDbForTests(getTestDb());

// Tests must never reach a real LLM provider (db.ts's dotenv import loads .env
// before this body runs, so scrub afterwards; ai.ts reads env at resolve time).
process.env.DECLUTTER_SETTINGS_PATH = "/nonexistent/declutter-test-settings.json";
for (const k of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_VISION_MODEL", "LLM2_BASE_URL", "LLM2_API_KEY", "LLM2_MODEL", "LLM2_VISION_MODEL", "GROQ_API_KEY", "AI_DEV_PROVIDER"]) {
  delete process.env[k];
}

afterAll(async () => {
  await closeTestDb();
});
