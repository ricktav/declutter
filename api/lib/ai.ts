import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { listModels, AiMisconfigured } from "./ai-client";
import { loadSettings } from "./settings";

/**
 * Provider chain:
 *   1. Settings page (settings.json) — saved from the UI
 *   2. LLM_BASE_URL + LLM_API_KEY + LLM_MODEL env vars
 *      (any OpenAI-compatible endpoint: xAI Grok, OpenAI, Ollama, …)
 *   3. Kimi platform gateway (KIMI_AGENTGW_*) — when running on Kimi
 *   4. otherwise: AI features degrade with a clear "not configured" notice
 */

interface ResolvedProvider {
  chat: ReturnType<ReturnType<typeof createOpenAICompatible>>;
  vision: ReturnType<ReturnType<typeof createOpenAICompatible>>;
  source: "settings" | "env" | "kimi";
}

let cached: { key: string; provider: ResolvedProvider } | null = null;

function fromCustom(baseURL?: string, apiKey?: string, model?: string, visionModel?: string, source: "settings" | "env" = "env"): ResolvedProvider | null {
  if (!baseURL || !apiKey) return null;
  if (!model) {
    throw new AiMisconfigured("LLM base URL and key are set but no model is chosen.");
  }
  const p = createOpenAICompatible({
    name: "custom-llm",
    baseURL,
    apiKey,
    supportsStructuredOutputs: true,
  });
  return { chat: p(model), vision: p(visionModel ?? model), source };
}

let kimiProvider: ResolvedProvider | null = null;

async function fromKimi(): Promise<ResolvedProvider> {
  if (!kimiProvider) {
    const baseURL = process.env.KIMI_AGENTGW_BASE_URL;
    const apiKey = process.env.KIMI_AGENTGW_API_KEY;
    if (!baseURL || !apiKey) {
      throw new AiMisconfigured(
        "No LLM configured. Open Settings in the app and add a provider " +
          "(e.g. Grok: https://api.x.ai/v1 + your xAI key), or set LLM_* in .env.",
      );
    }
    const p = createOpenAICompatible({
      name: "kimi-gw",
      baseURL,
      apiKey,
      includeUsage: true,
      supportsStructuredOutputs: true,
    });
    const { models, defaultModelId } = await listModels();
    const visionId = models.find((m) => m.supportsImageIn)?.id ?? defaultModelId;
    kimiProvider = { chat: p(defaultModelId), vision: p(visionId), source: "kimi" };
  }
  return kimiProvider;
}

async function resolveProvider(): Promise<ResolvedProvider> {
  const s = loadSettings();
  const cacheKey = JSON.stringify(s);
  if (cached && cached.key === cacheKey) return cached.provider;

  const provider =
    fromCustom(s.llmBaseUrl, s.llmApiKey, s.llmModel, s.llmVisionModel, "settings") ??
    fromCustom(process.env.LLM_BASE_URL, process.env.LLM_API_KEY, process.env.LLM_MODEL, process.env.LLM_VISION_MODEL) ??
    (await fromKimi());

  cached = { key: cacheKey, provider };
  return provider;
}

export async function getModel() {
  return (await resolveProvider()).chat;
}

export async function getVisionModel() {
  return (await resolveProvider()).vision;
}

export async function getProviderSource(): Promise<string> {
  return (await resolveProvider()).source;
}

/**
 * Optional second provider (Provider B) for side-by-side comparison.
 * Resolves from: settings.json llm2* fields -> LLM2_* env vars -> null.
 * Never falls back to the Kimi gateway — an A/B against itself is pointless.
 */
export async function getSecondModel(): Promise<{ model: ResolvedProvider["chat"]; source: "settings" | "env" } | null> {
  const s = loadSettings();
  const provider =
    fromCustom(s.llm2BaseUrl, s.llm2ApiKey, s.llm2Model, s.llm2VisionModel, "settings") ??
    fromCustom(process.env.LLM2_BASE_URL, process.env.LLM2_API_KEY, process.env.LLM2_MODEL, process.env.LLM2_VISION_MODEL);
  if (!provider) return null;
  return { model: provider.chat, source: provider.source as "settings" | "env" };
}

/** short human label for a provider source, for comparison displays */
export function providerLabel(source: "settings" | "env" | "kimi"): string {
  return source === "settings" ? "Settings (A)" : source === "env" ? "Env .env (A)" : "Kimi platform (A)";
}

