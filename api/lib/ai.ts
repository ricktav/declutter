import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { AiMisconfigured } from "./ai-client";
import { loadSettings, type AiSlot } from "./settings";

/**
 * Provider chain:
 *   1. Settings page (~/.declutter/settings.json) — saved from the UI
 *   2. LLM_BASE_URL + LLM_API_KEY + LLM_MODEL env vars
 *      (any OpenAI-compatible endpoint: xAI Grok, OpenAI, Ollama, …)
 *   3. XAI_API_KEY — official xAI env name; base https://api.x.ai/v1,
 *      default model grok-4.7 (chat + vision)
 *   4. otherwise: AI features degrade with a clear "not configured" notice
 *
 * Auth is pluggable (`LlmAuth`) so an OAuth token could be dropped in later.
 * xAI's public API docs authenticate with `Authorization: Bearer $XAI_API_KEY`
 * created in the console — there is no documented OAuth/sign-in grant for
 * API access (subscription device-code login on accounts.x.ai is unofficial).
 */

export const XAI_BASE_URL = "https://api.x.ai/v1";
/** Flagship Grok; xAI documents image input on the chat models (jpg/png). */
export const XAI_DEFAULT_MODEL = "grok-4.7";
export const XAI_DEFAULT_VISION_MODEL = "grok-4.7";

export type ProviderSource = "settings" | "env" | "xai-env";

/** How we authenticate to an OpenAI-compatible endpoint. */
export type LlmAuth =
  | { kind: "api-key"; apiKey: string }
  | { kind: "oauth"; accessToken: string };

function tokenOf(auth: LlmAuth): string {
  return auth.kind === "api-key" ? auth.apiKey : auth.accessToken;
}

interface ResolvedProvider {
  chat: ReturnType<ReturnType<typeof createOpenAICompatible>>;
  vision: ReturnType<ReturnType<typeof createOpenAICompatible>>;
  source: ProviderSource;
}

let cached: { key: string; a: ResolvedProvider; b: ResolvedProvider | null } | null = null;

function fromAuth(
  baseURL: string | undefined,
  auth: LlmAuth | null,
  model: string | undefined,
  visionModel: string | undefined,
  source: ProviderSource,
): ResolvedProvider | null {
  if (!baseURL || !auth) return null;
  if (!model) {
    throw new AiMisconfigured("LLM base URL and key are set but no model is chosen.");
  }
  const p = createOpenAICompatible({
    name: "custom-llm",
    baseURL,
    apiKey: tokenOf(auth),
    supportsStructuredOutputs: true,
  });
  return { chat: p(model), vision: p(visionModel ?? model), source };
}

function apiKeyAuth(key: string | undefined): LlmAuth | null {
  return key ? { kind: "api-key", apiKey: key } : null;
}

function grokFromXaiEnv(): ResolvedProvider | null {
  const key = process.env.XAI_API_KEY;
  if (!key) return null;
  return fromAuth(
    XAI_BASE_URL,
    apiKeyAuth(key),
    process.env.LLM_MODEL || XAI_DEFAULT_MODEL,
    process.env.LLM_VISION_MODEL || XAI_DEFAULT_VISION_MODEL,
    "xai-env",
  );
}

function resolvePair(): { a: ResolvedProvider; b: ResolvedProvider | null } {
  const s = loadSettings();
  const cacheKey = JSON.stringify({
    s,
    env: {
      LLM_BASE_URL: process.env.LLM_BASE_URL,
      LLM_MODEL: process.env.LLM_MODEL,
      LLM_VISION_MODEL: process.env.LLM_VISION_MODEL,
      hasLlmKey: !!process.env.LLM_API_KEY,
      hasXaiKey: !!process.env.XAI_API_KEY,
      LLM2_BASE_URL: process.env.LLM2_BASE_URL,
      LLM2_MODEL: process.env.LLM2_MODEL,
      hasLlm2Key: !!process.env.LLM2_API_KEY,
    },
  });
  if (cached && cached.key === cacheKey) return { a: cached.a, b: cached.b };

  const settingsKey =
    s.llmApiKey ||
    (s.llmBaseUrl?.replace(/\/+$/, "") === XAI_BASE_URL ? process.env.XAI_API_KEY : undefined);
  const a =
    fromAuth(s.llmBaseUrl, apiKeyAuth(settingsKey), s.llmModel, s.llmVisionModel, "settings") ??
    fromAuth(
      process.env.LLM_BASE_URL,
      apiKeyAuth(process.env.LLM_API_KEY || (process.env.LLM_BASE_URL?.includes("api.x.ai") ? process.env.XAI_API_KEY : undefined)),
      process.env.LLM_MODEL,
      process.env.LLM_VISION_MODEL,
      "env",
    ) ??
    grokFromXaiEnv();
  if (!a) {
    throw new AiMisconfigured(
      "No LLM configured. Open Settings and pick a provider (xAI Grok uses " +
        "https://api.x.ai/v1 + an API key), or set XAI_API_KEY / LLM_* in .env.",
    );
  }

  const b =
    fromAuth(s.llm2BaseUrl, apiKeyAuth(s.llm2ApiKey), s.llm2Model, s.llm2VisionModel, "settings") ??
    fromAuth(
      process.env.LLM2_BASE_URL,
      apiKeyAuth(process.env.LLM2_API_KEY),
      process.env.LLM2_MODEL,
      process.env.LLM2_VISION_MODEL,
      "env",
    );

  cached = { key: cacheKey, a, b };
  return { a, b };
}

function pick(slot: AiSlot | undefined): ResolvedProvider {
  const { a, b } = resolvePair();
  if (slot === "b") {
    if (!b) {
      throw new AiMisconfigured(
        "This feature is set to Provider B, but B is not configured. Open Settings.",
      );
    }
    return b;
  }
  return a;
}

export async function getModel() {
  return pick("a").chat;
}

export async function getVisionModel() {
  return pick("a").vision;
}

/** Inbox AI triage (text + photo object spotting on a capture). */
export async function getTriageModel() {
  return pick(loadSettings().llmTriageSlot).chat;
}

export async function getTriageVisionModel() {
  return pick(loadSettings().llmTriageSlot).vision;
}

/** pins.detect — needs a vision-capable model. */
export async function getDetectVisionModel() {
  return pick(loadSettings().llmDetectSlot).vision;
}

export async function getProviderSource(): Promise<ProviderSource> {
  return pick("a").source;
}

/**
 * Optional second provider (Provider B) for side-by-side comparison.
 * Resolves from: settings.json llm2* fields -> LLM2_* env vars -> null.
 */
export async function getSecondModel(): Promise<{ model: ResolvedProvider["chat"]; source: ProviderSource } | null> {
  try {
    const { b } = resolvePair();
    if (!b) return null;
    return { model: b.chat, source: b.source };
  } catch {
    return null;
  }
}
