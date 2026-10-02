/**
 * Error classification for LLM calls made through the AI SDK.
 *
 * Callers branch on the error class instead of decoding HTTP status codes.
 * This module never retries: billed calls may double-charge on a retry
 * because a 5xx or a client timeout does not prove the provider did not run
 * the request. `classifyAiError` only labels the error.
 */

/** Terminal: quota exhausted or plan does not allow this call. Do not retry. */
export class AiUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiUnavailable";
  }
}

/** Terminal: the provider refused the content (moderation / safety). */
export class ContentRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentRejected";
  }
}

/** Terminal: no provider configured, or credentials rejected. */
export class AiMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiMisconfigured";
  }
}

/** Terminal: the request itself was invalid (a bug on our side). */
export class AiInvalidRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiInvalidRequest";
  }
}

/** Possibly transient: 408 / 424 / 429 / 5xx / network failure. */
export class AiTransient extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiTransient";
  }
}

interface ErrorBody {
  error?: { type?: string; message?: string; code?: string };
  message?: string;
}

export function mapAiError(status: number, body: ErrorBody | undefined, raw: string): Error {
  const type = body?.error?.type ?? body?.error?.code ?? "";
  const detail = body?.error?.message ?? body?.message ?? raw.slice(0, 300);

  if (type.includes("content") || type.includes("moderation")) {
    return new ContentRejected(detail || "The provider rejected this content.");
  }
  switch (status) {
    case 401:
      return new AiMisconfigured("The provider rejected the API key. Check Settings.");
    case 402:
      return new AiUnavailable(detail || "The provider reports no remaining credit.");
    case 400:
      return type === "payment_required" || type === "insufficient_quota"
        ? new AiUnavailable(detail || "The provider reports no remaining credit.")
        : new AiInvalidRequest(detail || "The provider rejected the request as invalid.");
    case 403:
      return new ContentRejected(detail || "The provider refused this request.");
    case 404:
      return new AiMisconfigured(detail || "Model or endpoint not found. Check the base URL and model name in Settings.");
    case 429:
      return new AiTransient(detail || "Rate limited by the provider. Try again in a moment.");
    case 408:
    case 424:
      return new AiTransient(detail || "The provider timed out. Try again.");
    default:
      if (status >= 500) return new AiTransient(detail || "The provider is having trouble. Try again later.");
      return new AiInvalidRequest(detail || `Request failed (HTTP ${status}).`);
  }
}

/**
 * Turn whatever the AI SDK threw into one of the classes above.
 * Field names differ between SDK versions, so every known place a status
 * or body can hide is checked. Without a status the error is treated as
 * transient: network-level failures usually are.
 */
export function classifyAiError(err: unknown): Error {
  if (
    err instanceof AiUnavailable ||
    err instanceof ContentRejected ||
    err instanceof AiMisconfigured ||
    err instanceof AiInvalidRequest ||
    err instanceof AiTransient
  ) {
    return err;
  }

  const anyErr = err as {
    status?: number;
    statusCode?: number;
    response?: { status?: number; body?: unknown };
    data?: unknown;
    error?: unknown;
    message?: string;
    responseBody?: unknown;
  };

  const status = anyErr?.status ?? anyErr?.statusCode ?? anyErr?.response?.status;
  // ai@6 APICallError only carries `data` when the body matched the provider
  // error schema; otherwise the raw JSON string sits in `responseBody`.
  const rawBody = anyErr?.response?.body ?? anyErr?.data ?? anyErr?.error ?? anyErr?.responseBody;
  let body: ErrorBody | undefined;
  if (rawBody && typeof rawBody === "object") {
    body = rawBody as ErrorBody;
  } else if (typeof rawBody === "string") {
    try {
      body = JSON.parse(rawBody) as ErrorBody;
    } catch {
      body = undefined;
    }
  }

  if (typeof status === "number") {
    return mapAiError(status, body, typeof rawBody === "string" ? rawBody : "");
  }
  return new AiTransient(anyErr?.message || "The AI call failed. Try again.");
}

export function isRetryableAiError(err: unknown): boolean {
  return err instanceof AiTransient;
}
