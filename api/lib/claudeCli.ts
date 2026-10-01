import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import type { ZodType } from "zod";

const execFileAsync = promisify(execFile);

export class ClaudeCliError extends Error {}

/**
 * Dev-mode experiment: swap a specific AI call for the Claude Code CLI
 * (`claude -p`) instead of the configured API provider, to feel out its
 * latency/quality on this one call without touching anything else. Rides on
 * whatever Claude subscription/login is already set up on this machine - no
 * separate API key, but also no retry/rate-limit handling and no enforced
 * JSON mode (the CLI just free-forms text), so the result is parsed and
 * validated against the same zod schema the API path uses.
 *
 * Opt-in only: set AI_DEV_PROVIDER=claude-cli in .env. Leave it unset for
 * normal operation (the configured API provider, unaffected either way).
 */
export function isClaudeCliDevMode(): boolean {
  return process.env.AI_DEV_PROVIDER === "claude-cli";
}

export async function claudeCliObject<T>(opts: {
  textPrompt: string;
  jsonShape: string;
  schema: ZodType<T>;
  imageBytes?: Uint8Array;
}): Promise<T> {
  let imagePath: string | null = null;
  let fullPrompt = `${opts.textPrompt}\n\nRespond with ONLY a single JSON object - no markdown code fences, no explanation before or after - matching exactly this shape:\n${opts.jsonShape}`;
  if (opts.imageBytes) {
    imagePath = path.join(os.tmpdir(), `claude-cli-${crypto.randomBytes(6).toString("hex")}.jpg`);
    await fs.writeFile(imagePath, Buffer.from(opts.imageBytes));
    fullPrompt += `\n\nImage to analyze: ${imagePath}`;
  }
  try {
    const { stdout } = await execFileAsync("claude", ["-p", fullPrompt], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const jsonText = extractJson(stdout);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new ClaudeCliError(`claude -p did not return valid JSON. Raw output: ${stdout.slice(0, 400)}`);
    }
    const result = opts.schema.safeParse(parsed);
    if (!result.success) {
      throw new ClaudeCliError(`claude -p's JSON didn't match the expected shape: ${result.error.message}`);
    }
    return result.data;
  } catch (err) {
    if (err instanceof ClaudeCliError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) {
      throw new ClaudeCliError("The `claude` CLI isn't installed or isn't on PATH.");
    }
    throw new ClaudeCliError(`claude -p failed: ${msg}`);
  } finally {
    if (imagePath) await fs.unlink(imagePath).catch(() => {});
  }
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) return trimmed.slice(braceStart, braceEnd + 1);
  return trimmed;
}
