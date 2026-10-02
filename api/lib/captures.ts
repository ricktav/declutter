import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { captures, type Capture } from "@db/schema";
import { logEvent } from "./events";
import { putFile, readFileBytes, deleteStoredFile } from "./filestore";
import { sniffMime } from "./sniff";

export type CaptureKind = "note" | "link" | "image" | "file" | "scan" | "voice";

export interface CreateCaptureInput {
  kind: CaptureKind;
  rawText?: string | null;
  url?: string | null;
  /** raw bytes (unattended channels such as the Telegram bot) */
  bytes?: Uint8Array;
  /** a key returned by POST /api/upload (the web UI) */
  storageKey?: string;
  fileName?: string;
  contentType?: string;
  exifGps?: { lat: number; lng: number } | null;
  /** who/what produced this capture, for the event log */
  source?: "user" | "telegram" | "system";
}

/**
 * Single entry point for landing something in the inbox, used by the web
 * UI's inbox.create *and* any unattended ingestion channel (Telegram bot,
 * a future email/webhook intake). Keeping one path means every capture —
 * regardless of where it came from — gets the same storage/event handling,
 * and the "sacred raw input" file is written exactly once.
 */
export async function createCapture(input: CreateCaptureInput): Promise<Capture> {
  const db = getDb();
  let storageKey: string | null = null;
  let contentHash: string | null = null;

  let bytes = input.bytes;
  if (!bytes && input.storageKey) bytes = await readFileBytes(input.storageKey);

  if (bytes) {
    // content type comes from the bytes, never from the sender
    await sniffMime(bytes, input.fileName);
    contentHash = createHash("sha256").update(bytes).digest("hex");
    // same bytes already in the inbox (a re-sent Telegram photo, the same
    // file uploaded twice) - return that one instead of storing a duplicate
    const dup = await db.query.captures.findFirst({ where: eq(captures.contentHash, contentHash) });
    if (dup) {
      if (input.storageKey) await deleteStoredFile(input.storageKey).catch(() => {});
      return dup;
    }

    if (input.storageKey) {
      storageKey = input.storageKey;
    } else {
      const saved = await putFile({
        bytes,
        fileName: `inbox/${input.fileName ?? input.kind}`,
        contentType: input.contentType,
      });
      storageKey = saved.key;
    }
  }

  const [{ id }] = await db
    .insert(captures)
    .values({
      kind: input.kind,
      rawText: input.rawText ?? null,
      url: input.url ?? null,
      storageKey,
      contentHash,
      exifGps: input.exifGps ?? null,
    })
    .$returningId();

  await logEvent({
    entityType: "capture",
    entityId: id,
    action: "created",
    summary: `Inbox capture (${input.kind}) added${input.source && input.source !== "user" ? ` via ${input.source}` : ""}`,
    actor: input.source === "user" || !input.source ? "user" : "system",
  });

  const row = await db.query.captures.findFirst({ where: (c, { eq }) => eq(c.id, id) });
  if (!row) throw new Error("capture insert did not round-trip");
  return row;
}
