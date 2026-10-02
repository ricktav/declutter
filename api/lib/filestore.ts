import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * File storage: local disk under ./uploads, served at /uploads/<name>.
 *
 * Keys are persisted on capture/attachment rows as "local/<name>". A bare
 * key (no prefix, optionally "uploads/<name>") is accepted on read for rows
 * written before the prefix existed.
 */

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

function ensureDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function sanitizeName(name: string): string {
  const base = name.replace(/[/\\]/g, "_").replace(/\.\./g, "_");
  return base.length > 120 ? base.slice(-120) : base;
}

/** Relative file name under UPLOAD_DIR for any accepted key shape. */
function relOf(key: string): string {
  if (key.startsWith("local/")) return key.slice("local/".length);
  return key.replace(/^uploads\//, "");
}

/** Absolute path, refusing anything that would escape UPLOAD_DIR. */
function pathOf(key: string): string {
  const abs = path.resolve(UPLOAD_DIR, relOf(key));
  if (!abs.startsWith(UPLOAD_DIR + path.sep)) {
    throw new Error("Invalid storage key");
  }
  return abs;
}

export async function putFile(opts: {
  bytes: Uint8Array;
  fileName: string;
  contentType?: string;
}): Promise<{ key: string; size: number }> {
  ensureDir();
  const id = crypto.randomBytes(6).toString("hex");
  const rel = `${id}-${sanitizeName(opts.fileName)}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, rel), Buffer.from(opts.bytes));
  return { key: `local/${rel}`, size: opts.bytes.byteLength };
}

export async function readFileBytes(key: string): Promise<Uint8Array> {
  return new Uint8Array(fs.readFileSync(pathOf(key)));
}

export async function deleteStoredFile(key: string): Promise<void> {
  fs.rmSync(pathOf(key), { force: true });
}

/** Same-origin URL the browser can render, or null if the file is gone. */
export async function urlForKey(key: string): Promise<string | null> {
  let abs: string;
  try {
    abs = pathOf(key);
  } catch {
    return null;
  }
  if (!fs.existsSync(abs)) return null;
  return `/uploads/${relOf(key)}`;
}
