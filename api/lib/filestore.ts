import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Photo/file storage abstraction.
 *  - On the Kimi platform: platform object storage (api/lib/storage.ts)
 *  - Self-hosted: local disk under ./uploads, served at /uploads/<key>
 *
 * Keys carry a prefix: "plat/..." vs "local/...". A key is minted at upload
 * time and persisted on the attachment row; reads dispatch on the prefix.
 */

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

function ensureDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function sanitizeName(name: string): string {
  const base = name.replace(/[/\\]/g, "_").replace(/\.\./g, "_");
  return base.length > 120 ? base.slice(-120) : base;
}

export async function putFile(opts: {
  bytes: Uint8Array;
  fileName: string;
  contentType?: string;
}): Promise<{ key: string; size: number }> {
  // try platform storage first
  try {
    const { storage } = await import("./storage");
    const saved = await storage.uploadFile({
      fileContent: opts.bytes,
      fileName: opts.fileName,
      contentType: opts.contentType,
    });
    return { key: `plat/${saved.key}`, size: saved.size };
  } catch {
    // fall through to local disk
  }
  ensureDir();
  const id = crypto.randomBytes(6).toString("hex");
  const rel = `${id}-${sanitizeName(opts.fileName)}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, rel), Buffer.from(opts.bytes));
  return { key: `local/${rel}`, size: opts.bytes.byteLength };
}

/** Strip a legacy "uploads/" prefix if present. */
function stripLegacy(key: string): string {
  return key.replace(/^uploads\//, "");
}

export async function readFileBytes(key: string): Promise<Uint8Array> {
  if (key.startsWith("local/")) {
    const rel = key.slice("local/".length);
    return new Uint8Array(fs.readFileSync(path.join(UPLOAD_DIR, rel)));
  }
  if (key.startsWith("plat/")) {
    const { storage } = await import("./storage");
    return storage.readFile({ fileKey: key.slice(5) });
  }
  // bare key (legacy): try local disk first, platform storage second
  const rel = stripLegacy(key);
  const localPath = path.join(UPLOAD_DIR, rel);
  if (fs.existsSync(localPath)) return new Uint8Array(fs.readFileSync(localPath));
  const { storage } = await import("./storage");
  return storage.readFile({ fileKey: key });
}

export async function deleteStoredFile(key: string): Promise<void> {
  if (key.startsWith("local/")) {
    const rel = key.slice("local/".length);
    fs.rmSync(path.join(UPLOAD_DIR, rel), { force: true });
    return;
  }
  if (!key.startsWith("plat/") && fs.existsSync(path.join(UPLOAD_DIR, stripLegacy(key)))) {
    fs.rmSync(path.join(UPLOAD_DIR, stripLegacy(key)), { force: true });
    return;
  }
  try {
    const { storage } = await import("./storage");
    await storage.deleteFile({ fileKey: key.startsWith("plat/") ? key.slice(5) : key });
  } catch {
    // ignore
  }
}

/** URL the browser can render. Local keys get a same-origin path (no expiry). */
export async function urlForKey(key: string): Promise<string | null> {
  if (key.startsWith("local/")) {
    return `/uploads/${key.slice("local/".length)}`;
  }
  if (!key.startsWith("plat/")) {
    // bare key (legacy): serve from local disk if the file is there
    const rel = stripLegacy(key);
    if (fs.existsSync(path.join(UPLOAD_DIR, rel))) return `/uploads/${rel}`;
  }
  try {
    const { storage } = await import("./storage");
    const { url } = await storage.getPresignedUrl({
      key: key.startsWith("plat/") ? key.slice(5) : key,
    });
    return url;
  } catch {
    return null;
  }
}
