import { getDb } from "../queries/connection";
import { captures, type Capture } from "@db/schema";
import { logEvent } from "./events";
import { putFile } from "./filestore";

export type CaptureKind = "note" | "link" | "image" | "file" | "scan" | "voice";

export interface CreateCaptureInput {
  kind: CaptureKind;
  rawText?: string | null;
  url?: string | null;
  bytes?: Uint8Array;
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

  if (input.bytes) {
    const saved = await putFile({
      bytes: input.bytes,
      fileName: `inbox/${input.fileName ?? input.kind}`,
      contentType: input.contentType,
    });
    storageKey = saved.key;
  }

  const [{ id }] = await db
    .insert(captures)
    .values({
      kind: input.kind,
      rawText: input.rawText ?? null,
      url: input.url ?? null,
      storageKey,
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
