import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { isAuthorized, productionAuthProblem } from "./lib/auth";
import { health } from "./lib/health";
import { putFile, servePathForKey } from "./lib/filestore";
import { sniffMime, isInlineMime, mimeFromExtension, UnsupportedFileType } from "./lib/sniff";

const app = new Hono<{ Bindings: HttpBindings }>();

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));

app.get("/api/health", async (c) => {
  const h = await health();
  return c.json(h, h.ok ? 200 : 503);
});

// Everything else under /api and /uploads needs the app token (when configured).
app.use("/api/*", async (c, next) => {
  if (!isAuthorized(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  await next();
});
app.use("/uploads/*", async (c, next) => {
  if (!isAuthorized(c.req.raw)) return c.text("Unauthorized", 401);
  await next();
});

/**
 * Multipart upload. Bytes never travel inside a JSON body any more; the
 * client uploads here first and then passes the returned storageKey to
 * inbox.create / attachments.add. The MIME type is sniffed from content.
 *   form fields: file (required), scope ("inbox" | "attachments")
 */
app.post("/api/upload", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "No file" }, 400);
  const scope = form.get("scope") === "attachments" ? "attachments" : "inbox";
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) return c.json({ error: "Empty file" }, 400);

  let mimeType: string;
  try {
    mimeType = await sniffMime(bytes, file.name);
  } catch (err) {
    if (err instanceof UnsupportedFileType) return c.json({ error: err.message }, 415);
    throw err;
  }
  const saved = await putFile({ bytes, fileName: `${scope}/${file.name || "upload"}`, contentType: mimeType });
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  return c.json({ key: saved.key, size: saved.size, mimeType, fileName: file.name, contentHash });
});

// one line per mutation (not queries: lists run every few seconds) so the phone's writes are visible
app.use("/api/trpc/*", async (c, next) => {
  if (c.req.method === "POST") {
    const ua = c.req.header("user-agent") ?? "";
    console.log(`[trpc] POST ${c.req.path.replace("/api/trpc/", "")} house=${c.req.header("x-house-id") ?? "-"} ua=${ua.slice(0, 40)}`);
  }
  await next();
});
app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
    // one line per failed procedure in the server log, so a client error can be traced
    onError({ error, path, type, input, req }) {
      // one line: zod issues as path=message, the input and the caller, so a bad client is traceable
      const cause = error.cause as { issues?: Array<{ path: (string | number)[]; message: string }> } | undefined;
      const detail = cause?.issues?.length
        ? cause.issues.map((i) => `${i.path.join(".") || "(root)"}=${i.message}`).join("; ")
        : error.message.replace(/\s+/g, " ");
      let shownInput = "";
      try {
        shownInput = JSON.stringify(input);
      } catch {
        shownInput = String(input);
      }
      const ua = req.headers.get("user-agent") ?? "-";
      console.error(
        `[trpc] ${type} ${path ?? "?"} ${error.code}: ${detail.slice(0, 300)} input=${(shownInput ?? "").slice(0, 300)} ua=${ua.slice(0, 40)} url=${req.url.slice(0, 200)}`,
      );
    },
  });
});

app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

// Stored uploads. Served with a content type derived from the extension
// and never sniffed by the browser; only media renders inline, anything
// else downloads, so a stored file can never run as a page on this origin.
app.get("/uploads/:name", async (c) => {
  const name = c.req.param("name");
  const abs = servePathForKey(`local/${name}`);
  if (!abs) return c.text("Not found", 404);
  const mime = mimeFromExtension(name);
  const body = fs.readFileSync(abs);
  c.header("Content-Type", mime);
  c.header("Content-Length", String(body.byteLength));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Disposition", `${isInlineMime(mime) ? "inline" : "attachment"}; filename="${path.basename(name)}"`);
  c.header("Cache-Control", "private, max-age=31536000, immutable");
  return c.body(body);
});

export default app;

if (env.isProduction) {
  const authProblem = productionAuthProblem(process.env);
  if (authProblem) {
    console.error(`[boot] refusing to start.\n${authProblem}`);
    process.exit(1);
  }
  if (!process.env.APP_TOKEN?.trim()) {
    console.warn("[boot] ALLOW_OPEN_ACCESS=1: the API and uploads are open to anyone who can reach this port.");
  }

  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  // long-polling, gated to production like the HTTP listener above — a dev
  // hot-reload would otherwise spawn a new poller on every file save
  const { startTelegramBot } = await import("./lib/telegramBot");
  startTelegramBot();
}
