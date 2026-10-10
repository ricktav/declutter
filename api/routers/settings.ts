import { z } from "zod";
import { createRouter, procedure } from "../middleware";
import { loadSettings, saveSettings } from "../lib/settings";
import { getProviderSource } from "../lib/ai";
import { logEvent } from "../lib/events";

export const settingsRouter = createRouter({
  /** current effective config (key masked) */
  get: procedure.query(async () => {
    const s = loadSettings();
    const envConfigured = !!(process.env.LLM_BASE_URL && process.env.LLM_API_KEY);
    let source: string;
    try {
      source = await getProviderSource();
    } catch {
      source = "none";
    }
    const mask = (k?: string) => (k ? `${k.slice(0, 6)}…${k.slice(-3)}` : null);
    const env2Configured = !!(process.env.LLM2_BASE_URL && process.env.LLM2_API_KEY);
    const xaiEnvConfigured = !!process.env.XAI_API_KEY;
    return {
      source,
      settings: {
        llmBaseUrl: s.llmBaseUrl ?? null,
        llmApiKeyMasked: mask(s.llmApiKey),
        llmModel: s.llmModel ?? null,
        llmVisionModel: s.llmVisionModel ?? null,
        llm2BaseUrl: s.llm2BaseUrl ?? null,
        llm2ApiKeyMasked: mask(s.llm2ApiKey),
        llm2Model: s.llm2Model ?? null,
        llm2VisionModel: s.llm2VisionModel ?? null,
        llmTriageSlot: s.llmTriageSlot ?? "a",
        llmDetectSlot: s.llmDetectSlot ?? "a",
      },
      xaiEnvConfigured,
      xaiEnv: xaiEnvConfigured ? { llmApiKeyMasked: mask(process.env.XAI_API_KEY) } : null,
      envConfigured,
      env: envConfigured
        ? {
            llmBaseUrl: process.env.LLM_BASE_URL ?? null,
            llmApiKeyMasked: mask(process.env.LLM_API_KEY),
            llmModel: process.env.LLM_MODEL ?? null,
            llmVisionModel: process.env.LLM_VISION_MODEL ?? null,
          }
        : null,
      env2Configured,
      env2: env2Configured
        ? {
            llm2BaseUrl: process.env.LLM2_BASE_URL ?? null,
            llm2ApiKeyMasked: mask(process.env.LLM2_API_KEY),
            llm2Model: process.env.LLM2_MODEL ?? null,
            llm2VisionModel: process.env.LLM2_VISION_MODEL ?? null,
          }
        : null,
    };
  }),

  /** persist settings (UI takes precedence over env) */
  update: procedure
    .input(
      z.object({
        llmBaseUrl: z.string().optional(),
        llmApiKey: z.string().optional(),
        llmModel: z.string().optional(),
        llmVisionModel: z.string().optional(),
        llm2BaseUrl: z.string().optional(),
        llm2ApiKey: z.string().optional(),
        llm2Model: z.string().optional(),
        llm2VisionModel: z.string().optional(),
        llmTriageSlot: z.enum(["a", "b"]).optional(),
        llmDetectSlot: z.enum(["a", "b"]).optional(),
        clear: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.clear) {
        saveSettings({
          llmBaseUrl: "", llmApiKey: "", llmModel: "", llmVisionModel: "",
          llm2BaseUrl: "", llm2ApiKey: "", llm2Model: "", llm2VisionModel: "",
          llmTriageSlot: undefined,
          llmDetectSlot: undefined,
        });
      } else {
        const patch: Record<string, string> = {};
        if (input.llmBaseUrl !== undefined) patch.llmBaseUrl = input.llmBaseUrl;
        if (input.llmApiKey !== undefined && input.llmApiKey !== "") patch.llmApiKey = input.llmApiKey;
        if (input.llmModel !== undefined) patch.llmModel = input.llmModel;
        if (input.llmVisionModel !== undefined) patch.llmVisionModel = input.llmVisionModel;
        if (input.llm2BaseUrl !== undefined) patch.llm2BaseUrl = input.llm2BaseUrl;
        if (input.llm2ApiKey !== undefined && input.llm2ApiKey !== "") patch.llm2ApiKey = input.llm2ApiKey;
        if (input.llm2Model !== undefined) patch.llm2Model = input.llm2Model;
        if (input.llm2VisionModel !== undefined) patch.llm2VisionModel = input.llm2VisionModel;
        if (input.llmTriageSlot !== undefined) patch.llmTriageSlot = input.llmTriageSlot;
        if (input.llmDetectSlot !== undefined) patch.llmDetectSlot = input.llmDetectSlot;
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
  testConnection: procedure
    .input(
      z
        .object({
          llmBaseUrl: z.string().optional(),
          llmApiKey: z.string().optional(),
          provider: z.enum(["1", "2"]).default("1"),
        })
        .optional(),
    )
    .mutation(async ({ input }) => {
      const s = loadSettings();
      const want2 = (input?.provider ?? "1") === "2";
      const baseURL = (
        input?.llmBaseUrl ??
        (want2 ? (s.llm2BaseUrl ?? process.env.LLM2_BASE_URL) : (s.llmBaseUrl ?? process.env.LLM_BASE_URL)) ??
        ""
      ).replace(/\/+$/, "");
      // The stored key is only ever sent to the stored base URL. A caller
      // that supplies its own URL must also supply the key, otherwise this
      // endpoint would leak the configured secret to any address.
      const storedBase = (want2 ? (s.llm2BaseUrl ?? process.env.LLM2_BASE_URL) : (s.llmBaseUrl ?? process.env.LLM_BASE_URL))?.replace(/\/+$/, "");
      const mayUseStoredKey = !input?.llmBaseUrl || baseURL === storedBase;
      const apiKey =
        input?.llmApiKey ||
        (mayUseStoredKey ? (want2 ? (s.llm2ApiKey || process.env.LLM2_API_KEY) : (s.llmApiKey || process.env.LLM_API_KEY)) : "") ||
        "";
      if (!baseURL || !apiKey) {
        return { ok: false as const, error: "No base URL / API key configured yet." };
      }
      try {
        const res = await fetch(`${baseURL}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(20_000),
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

  /** real generation test: send a tiny prompt, report latency + reply */
  testPrompt: procedure
    .input(
      z.object({
        llmBaseUrl: z.string().optional(),
        llmApiKey: z.string().optional(),
        model: z.string(),
        provider: z.enum(["1", "2"]).default("1"),
      }),
    )
    .mutation(async ({ input }) => {
      const s = loadSettings();
      const want2 = input.provider === "2";
      const baseURL = (
        input.llmBaseUrl ??
        (want2 ? (s.llm2BaseUrl ?? process.env.LLM2_BASE_URL) : (s.llmBaseUrl ?? process.env.LLM_BASE_URL)) ??
        ""
      ).replace(/\/+$/, "");
      const storedBase = (want2 ? (s.llm2BaseUrl ?? process.env.LLM2_BASE_URL) : (s.llmBaseUrl ?? process.env.LLM_BASE_URL))?.replace(/\/+$/, "");
      const mayUseStoredKey = !input.llmBaseUrl || baseURL === storedBase;
      const apiKey =
        input.llmApiKey ||
        (mayUseStoredKey ? (want2 ? (s.llm2ApiKey || process.env.LLM2_API_KEY) : (s.llmApiKey || process.env.LLM_API_KEY)) : "") ||
        "";
      if (!baseURL || !input.model.trim()) {
        return { ok: false as const, error: "Base URL and model are required." };
      }
      const started = Date.now();
      try {
        const res = await fetch(`${baseURL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: input.model.trim(),
            messages: [{ role: "user", content: "Reply with exactly: ok" }],
            max_tokens: 16,
          }),
          signal: AbortSignal.timeout(25_000),
        });
        const ms = Date.now() - started;
        const text = await res.text();
        let reply: string | null = null;
        try {
          const body = JSON.parse(text) as {
            choices?: Array<{ message?: { content?: string } }>;
            error?: { message?: string };
          };
          reply = body.choices?.[0]?.message?.content?.trim() ?? null;
          if (!res.ok) {
            return {
              ok: false as const,
              error: `HTTP ${res.status}: ${body.error?.message ?? text.slice(0, 300)}`,
              ms,
            };
          }
        } catch {
          if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}: ${text.slice(0, 300)}`, ms };
        }
        return { ok: true as const, reply: reply ?? "(empty reply)", ms };
      } catch (err) {
        return { ok: false as const, error: `Request failed: ${(err as Error).message}`, ms: Date.now() - started };
      }
    }),
});
