import { Bot } from "grammy";
import exifr from "exifr";
import { createCapture } from "./captures";
import { tryTranscribe } from "./transcribe";

/**
 * Telegram → inbox bridge. One person's phone, four capture types (photo,
 * voice note, document/scan file, text note), all landing as `captures`
 * rows — the same inbox the web UI's drop zone feeds. Preprocesses what it
 * safely can (EXIF/GPS off photos, best-effort voice transcription) and
 * leaves the rest for the inbox's existing triage step.
 *
 * Opt-in: does nothing unless TELEGRAM_BOT_TOKEN is set. Long-polling, not
 * a webhook — works from behind NAT/no public URL, matches a home-network
 * deployment.
 */

const SCAN_EXTENSIONS = [".usdz", ".glb", ".gltf", ".obj", ".geojson"];

function allowedChatIds(): Set<number> | null {
  const raw = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  if (!raw) return null; // unset = misconfigured-closed, see start() below
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  return new Set(ids);
}

function extOf(fileName: string): string {
  const m = fileName.toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : "";
}

export function startTelegramBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return; // feature is opt-in

  const allowed = allowedChatIds();
  if (!allowed || allowed.size === 0) {
    console.warn(
      "[telegram] TELEGRAM_BOT_TOKEN is set but TELEGRAM_ALLOWED_CHAT_IDS is empty — " +
        "refusing to start (a bot with no allowlist accepts input from anyone who finds it).",
    );
    return;
  }

  const bot = new Bot(token);

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !allowed.has(chatId)) {
      if (chatId) await ctx.reply("Not authorized for this inventory. Ask the owner to add your chat ID.").catch(() => {});
      return;
    }
    await next();
  });

  bot.on("message:text", async (ctx) => {
    await createCapture({ kind: "note", rawText: ctx.message.text, source: "telegram" });
    await ctx.reply("Noted — filed to inbox.");
  });

  bot.on("message:photo", async (ctx) => {
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1];
    const file = await ctx.api.getFile(largest.file_id);
    const bytes = await downloadFile(token, file.file_path!);

    let exifGps: { lat: number; lng: number } | null = null;
    try {
      const gps = await exifr.gps(Buffer.from(bytes));
      if (gps) exifGps = { lat: gps.latitude, lng: gps.longitude };
    } catch {
      // Telegram usually strips EXIF from compressed photos — no GPS is expected, not an error
    }

    await createCapture({
      kind: "image",
      bytes,
      fileName: `telegram-${largest.file_unique_id}.jpg`,
      contentType: "image/jpeg",
      exifGps,
      rawText: ctx.message.caption ?? null,
      source: "telegram",
    });
    await ctx.reply(exifGps ? "Photo filed (with location)." : "Photo filed.");
  });

  bot.on("message:voice", async (ctx) => {
    const file = await ctx.api.getFile(ctx.message.voice.file_id);
    const bytes = await downloadFile(token, file.file_path!);
    const fileName = `telegram-${ctx.message.voice.file_unique_id}.ogg`;
    const transcript = await tryTranscribe(bytes, fileName);

    await createCapture({
      kind: "voice",
      bytes,
      fileName,
      contentType: "audio/ogg",
      rawText: transcript,
      source: "telegram",
    });
    await ctx.reply(transcript ? `Voice note filed: "${transcript.slice(0, 120)}"` : "Voice note filed (no transcription configured — listen from the inbox).");
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const fileName = doc.file_name ?? `telegram-${doc.file_unique_id}`;
    const file = await ctx.api.getFile(doc.file_id);
    const bytes = await downloadFile(token, file.file_path!);
    const isScan = SCAN_EXTENSIONS.includes(extOf(fileName));

    await createCapture({
      kind: isScan ? "scan" : "file",
      bytes,
      fileName,
      contentType: doc.mime_type,
      rawText: isScan ? `Scan file: ${fileName}` : (ctx.message.caption ?? null),
      source: "telegram",
    });
    await ctx.reply(isScan ? `Scan filed: ${fileName}` : `File filed: ${fileName}`);
  });

  bot.catch((err) => console.error("[telegram] handler error:", err.message));
  bot.start();
  console.log(`[telegram] inbox bot started, ${allowed.size} allowed chat(s)`);
}

async function downloadFile(token: string, filePath: string): Promise<Uint8Array> {
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
