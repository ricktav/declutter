import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import { loadSettings, saveSettings } from "../lib/settings";
import { getProviderSource } from "../lib/ai";
import { logEvent } from "../lib/events";

export const settingsRouter = createRouter({
  /** current effective config (key masked) */
  get: publicQuery.query(async () => {
    const s = loadSettings();
    const envConfigured = !!(process.env.LLM_BASE_URL && process.env.LLM_API_KEY);
    let source: string;
    try {
      source = await getProviderSource();
    } catch {
      source = "none";
    }
    const mask = (k?: string) => (k ? `${k.slice(0, 6)}…${k.slice(-3)}` : null);
    return {
      source,
      settings: {
        llmBaseUrl: s.llmBaseUrl ?? null,
        llmApiKeyMasked: mask(s.llmApiKey),
        llmModel: s.llmModel ?? null,
        llmVisionModel: s.llmVisionModel ?? null,
      },
      envConfigured,
      env: envConfigured
        ? {
            llmBaseUrl: process.env.LLM_BASE_URL ?? null,
            llmApiKeyMasked: mask(process.env.LLM_API_KEY),
            llmModel: process.env.LLM_MODEL ?? null,
            llmVisionModel: process.env.LLM_VISION_MODEL ?? null,
          }
        : null,
    };
  }),

  /** persist settings (UI takes precedence over env) */
  update: publicQuery
    .input(
      z.object({
        llmBaseUrl: z.string().optional(),
        llmApiKey: z.string().optional(),
        llmModel: z.string().optional(),
        llmVisionModel: z.string().optional(),
        clear: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.clear) {
        saveSettings({ llmBaseUrl: "", llmApiKey: "", llmModel: "", llmVisionModel: "" });
      } else {
        const patch: Record<string, string> = {};
        if (input.llmBaseUrl !== undefined) patch.llmBaseUrl = input.llmBaseUrl;
        if (input.llmApiKey !== undefined && input.llmApiKey !== "") patch.llmApiKey = input.llmApiKey;
        if (input.llmModel !== undefined) patch.llmModel = input.llmModel;
        if (input.llmVisionModel !== undefined) patch.llmVisionModel = input.llmVisionModel;
        saveSettings(patch);
      }
      await logEvent({
        entityType: "settings",
        action: input.clear ? "cleared" : "updated",
        summary: input.clear ? "LLM settings cleared (falling back to env/platform)" : "LLM settings updated",
      });
      return { ok: true };
    }),

  /** list models the configured key can actually use */
  testConnection: publicQuery
    .input(
      z
        .object({
          llmBaseUrl: z.string().optional(),
          llmApiKey: z.string().optional(),
        })
        .optional(),
    )
    .mutation(async ({ input }) => {
      const s = loadSettings();
      const baseURL = (input?.llmBaseUrl ?? s.llmBaseUrl ?? process.env.LLM_BASE_URL ?? "").replace(/\/+$/, "");
      const apiKey = input?.llmApiKey || s.llmApiKey || process.env.LLM_API_KEY || "";
      if (!baseURL || !apiKey) {
        return { ok: false as const, error: "No base URL / API key configured yet." };
      }
      try {
        const res = await fetch(`${baseURL}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text();
        if (!res.ok) {
          return { ok: false as const, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
        }
        const body = JSON.parse(text) as { data?: Array<{ id?: string }> };
        const models = (body.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
        return { ok: true as const, models };
      } catch (err) {
        return { ok: false as const, error: `Connection failed: ${(err as Error).message}` };
      }
    }),
});
