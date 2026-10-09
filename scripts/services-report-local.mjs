#!/usr/bin/env node
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const ts = path.join(path.dirname(fileURLToPath(import.meta.url)), "services-report-local.ts");
const r = spawnSync(process.execPath, ["--experimental-strip-types", ts, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
