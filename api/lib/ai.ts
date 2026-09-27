import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { listModels, AiMisconfigured } from "./ai-client";

let provider: ReturnType<typeof createOpenAICompatible> | null = null;

function getProvider() {
  if (!provider) {
    const baseURL = process.env.KIMI_AGENTGW_BASE_URL;
    const apiKey = process.env.KIMI_AGENTGW_API_KEY;
    if (!baseURL || !apiKey) {
      throw new AiMisconfigured(
        "AI is not provisioned for this site yet. Publish (or reopen) the site once, then retry.",
      );
    }
    provider = createOpenAICompatible({
      name: "kimi-gw",
      baseURL,
      apiKey,
      includeUsage: true,
      supportsStructuredOutputs: true,
    });
  }
  return provider;
}

let cachedModelId: string | null = null;

export async function getModelId(): Promise<string> {
  if (!cachedModelId) {
    const { defaultModelId } = await listModels();
    cachedModelId = defaultModelId;
  }
  return cachedModelId;
}

export async function getModel() {
  const p = getProvider();
  return p(await getModelId());
}

/** Prefer a vision-capable model for image analysis; fall back to the default. */
export async function getVisionModel() {
  const p = getProvider();
  const { models, defaultModelId } = await listModels();
  const vision = models.find((m) => m.supportsImageIn);
  return p(vision?.id ?? defaultModelId);
}
