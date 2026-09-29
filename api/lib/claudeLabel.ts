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

/**
 * Label a cropped object photo using the Claude Code CLI (`claude -p`) -
 * rides on whatever Claude subscription/auth is already set up on this
 * machine, no separate API key. Best-effort: returns null (never throws)
 * if the CLI isn't installed, isn't authenticated, or times out, so
 * callers can fall back to the generic detector label instead.
 */
export async function labelCropWithClaude(imageBytes: Uint8Array): Promise<string | null> {
  const tmpPath = path.join(os.tmpdir(), `claude-label-${crypto.randomBytes(6).toString("hex")}.jpg`);
  await fs.writeFile(tmpPath, Buffer.from(imageBytes));
  try {
    const { stdout } = await execFileAsync("claude", ["-p", `${PROMPT} Image: ${tmpPath}`], {
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
