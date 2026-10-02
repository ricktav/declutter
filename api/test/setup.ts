import { afterAll } from "vitest";
import { setDbForTests } from "../queries/connection";
import { getTestDb, closeTestDb } from "./db";

// Runs in every test worker before the test file's imports execute:
// the app's getDb() now returns the test database for the whole file.
setDbForTests(getTestDb());

afterAll(async () => {
  await closeTestDb();
});
