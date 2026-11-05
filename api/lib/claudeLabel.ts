import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

const PROMPT =
  "Identify the physical object in this photo for a home inventory app. " +
  "Give a short, specific name - brand and model if visible, otherwise a " +
  "specific descriptive name (not just the generic category). " +
  "One line only, no explanation, no markdown.";

/** Prompt sent to `claude -p`. A detector label is only a hint, never the name. */
export function claudeLabelPrompt(hint?: string): string {
  const trimmed = hint?.trim();
  if (!trimmed) return PROMPT;
  return (
    `${PROMPT} A local detector labelled this crop as "${trimmed}". ` +
    "Use that if it fits, but prefer a more specific name if you can see one."
  );
}

/**
 * Label a cropped object photo using the Claude Code CLI (`claude -p`) -
 * rides on whatever Claude subscription/auth is already set up on this
 * machine, no separate API key. Best-effort: returns null (never throws)
 * if the CLI isn't installed, isn't authenticated, or times out, so
 * callers can fall back to the generic detector label instead.
 *
 * `opts.hint` is a Florence-2 / generic OWL label to bias the name, not
 * a ChatGPT/OpenAI call — naming still goes only through `claude -p`.
 */
export async function labelCropWithClaude(
  imageBytes: Uint8Array,
  opts?: { hint?: string },
): Promise<string | null> {
  const tmpPath = path.join(os.tmpdir(), `claude-label-${crypto.randomBytes(6).toString("hex")}.jpg`);
  await fs.writeFile(tmpPath, Buffer.from(imageBytes));
  try {
    const { stdout } = await execFileAsync("claude", ["-p", `${claudeLabelPrompt(opts?.hint)} Image: ${tmpPath}`], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const label = stdout.trim().split("\n")[0]?.trim();
    return label || null;
  } catch {
    return null;
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}
