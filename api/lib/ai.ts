import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { listModels, AiMisconfigured } from "./ai-client";

/**
 * Provider chain:
 *   1. LLM_BASE_URL + LLM_API_KEY (+ LLM_MODEL / LLM_VISION_MODEL) — any
 *      OpenAI-compatible endpoint: xAI Grok, OpenAI, DeepSeek, Ollama, …
 *   2. Kimi platform gateway (KIMI_AGENTGW_*) — when running on Kimi
 *   3. otherwise: AI features degrade with a clear "not configured" notice
 */

interface ResolvedProvider {
  chat: ReturnType<ReturnType<typeof createOpenAICompatible>>;
  vision: ReturnType<ReturnType<typeof createOpenAICompatible>>;
  name: string;
}

let resolved: ResolvedProvider | null = null;

function fromEnv(): ResolvedProvider | null {
  const baseURL = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  if (!baseURL || !apiKey) return null;
  const p = createOpenAICompatible({
    name: "custom-llm",
    baseURL,
    apiKey,
    supportsStructuredOutputs: true,
  });
  const chatModel = process.env.LLM_MODEL;
  if (!chatModel) {
    throw new AiMisconfigured("LLM_BASE_URL/LLM_API_KEY are set but LLM_MODEL is missing.");
  }
  const visionModel = process.env.LLM_VISION_MODEL ?? chatModel;
  return { chat: p(chatModel), vision: p(visionModel), name: "custom" };
}

let kimiChat: ResolvedProvider | null = null;

async function fromKimi(): Promise<ResolvedProvider> {
  if (!kimiChat) {
    const baseURL = process.env.KIMI_AGENTGW_BASE_URL;
    const apiKey = process.env.KIMI_AGENTGW_API_KEY;
    if (!baseURL || !apiKey) {
      throw new AiMisconfigured(
        "No LLM configured. Set LLM_BASE_URL/LLM_API_KEY/LLM_MODEL in .env " +
          "(e.g. Grok: https://api.x.ai/v1), or run on the Kimi platform.",
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
    kimiChat = { chat: p(defaultModelId), vision: p(visionId), name: "kimi" };
  }
  return kimiChat;
}

async function resolveProvider(): Promise<ResolvedProvider> {
  if (!resolved) {
    resolved = fromEnv() ?? (await fromKimi());
  }
  return resolved;
}

export async function getModel() {
  return (await resolveProvider()).chat;
}

export async function getVisionModel() {
  return (await resolveProvider()).vision;
}

export async function getProviderName(): Promise<string> {
  return (await resolveProvider()).name;
}
