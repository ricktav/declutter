import { loadSettings } from "./settings";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_DEFAULT_MODEL = "whisper-large-v3-turbo";

/**
 * Best-effort voice-note transcription against an OpenAI-compatible
 * /audio/transcriptions endpoint (Whisper-shaped). Not every configured
 * LLM provider supports this (xAI Grok and most OpenRouter models don't,
 * and note: xAI "Grok" vs Groq's hosted Whisper are unrelated products
 * despite the near-identical name) — callers must treat a null result as
 * "couldn't preprocess this one", not an error. The voice capture is
 * stored either way; this only decides whether it arrives in the inbox
 * with a transcript already attached.
 *
 * Groq's whisper-large-v3(-turbo) auto-detects language per request — no
 * config needed to handle English/Dutch/anything else Whisper supports.
 */
async function transcribeAgainst(
  baseURL: string,
  apiKey: string,
  model: string,
  bytes: Uint8Array,
  fileName: string,
): Promise<string | null> {
  const form = new FormData();
  form.append("file", new Blob([bytes]), fileName);
  form.append("model", model);
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { text?: string };
  return data.text?.trim() || null;
}

export async function tryTranscribe(bytes: Uint8Array, fileName: string): Promise<string | null> {
  try {
    // Groq first: a dedicated, free-tier Whisper endpoint — the common case
    if (process.env.GROQ_API_KEY) {
      const model = process.env.GROQ_TRANSCRIBE_MODEL || GROQ_DEFAULT_MODEL;
      const text = await transcribeAgainst(GROQ_BASE_URL, process.env.GROQ_API_KEY, model, bytes, fileName);
      if (text) return text;
    }

    // fall back to whatever's configured as the main LLM provider, if it
    // happens to also expose /audio/transcriptions (most don't)
    const s = loadSettings();
    const baseURL = s.llmBaseUrl || process.env.LLM_BASE_URL;
    const apiKey = s.llmApiKey || process.env.LLM_API_KEY;
    const model = process.env.LLM_TRANSCRIBE_MODEL; // opt-in only — no safe default across providers
    if (!baseURL || !apiKey || !model) return null;
    return await transcribeAgainst(baseURL, apiKey, model, bytes, fileName);
  } catch {
    return null;
  }
}
