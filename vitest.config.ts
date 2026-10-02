import { defineConfig } from "vitest/config";
import path from "path";

const root = path.resolve(import.meta.dirname);

export default defineConfig({
  root,
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      "@db": path.resolve(root, "db"),
      "@contracts": path.resolve(root, "contracts"),
    },
  },
  test: {
    environment: "node",
    include: ["api/**/*.test.ts", "api/**/*.spec.ts"],
    globalSetup: ["./api/test/globalSetup.ts"],
    setupFiles: ["./api/test/setup.ts"],
    // all test files share one test database; resetTestDb() in parallel
    // workers would race, so files run one at a time
    fileParallelism: false,
  },
});
