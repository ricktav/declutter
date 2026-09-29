import { loadSettings } from "./settings";

/**
 * Best-effort voice-note transcription against an OpenAI-compatible
 * /audio/transcriptions endpoint (Whisper-shaped). Not every configured
 * LLM provider supports this (xAI Grok and most OpenRouter models don't) —
 * callers must treat a null result as "couldn't preprocess this one",
 * not an error. The voice capture is stored either way; this only decides
 * whether it arrives in the inbox with a transcript already attached.
 */
export async function tryTranscribe(bytes: Uint8Array, fileName: string): Promise<string | null> {
  const s = loadSettings();
  const baseURL = s.llmBaseUrl || process.env.LLM_BASE_URL;
  const apiKey = s.llmApiKey || process.env.LLM_API_KEY;
  const model = process.env.LLM_TRANSCRIBE_MODEL; // opt-in only — no safe default across providers
  if (!baseURL || !apiKey || !model) return null;

  try {
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
  } catch {
    return null;
  }
}
