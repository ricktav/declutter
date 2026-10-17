import fs from "fs";
import os from "os";
import path from "path";

// Deliberately OUTSIDE the project directory: this file holds API keys in
// plaintext, and the project root is what Vite's dev server serves over the
// LAN (host: true) - a file sitting there is reachable by anyone on the
// network who requests its path, dev server or not.
// DECLUTTER_SETTINGS_PATH overrides it (tests point it at nothing).
function settingsPath(): string {
  return process.env.DECLUTTER_SETTINGS_PATH || path.join(os.homedir(), ".declutter", "settings.json");
}

export type AiSlot = "a" | "b";
export const UI_DEPTHS = ["quick", "standard", "detail"] as const;
export type UiDepth = (typeof UI_DEPTHS)[number];

/** The links the Workbench used before they moved to Settings, so an install that never set them keeps them. */
export const DEFAULT_LINKS = {
  meterkastUrl: "http://10.50.0.10/meterkast.html",
  parcelViewerUrl: "http://10.50.0.102/grokbot/kadastrale-kaart/",
};

export interface AppSettings {
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  llmVisionModel?: string;
  llm2BaseUrl?: string;
  llm2ApiKey?: string;
  llm2Model?: string;
  llm2VisionModel?: string;
  /** Which saved provider inbox.triage uses. Default A. */
  llmTriageSlot?: AiSlot;
  /** Which saved provider pins.detect uses. Default A. */
  llmDetectSlot?: AiSlot;
  /** Triage new photo snaps in the background. Default off. */
  autoTriage?: boolean;
  /** External dashboard with live meter readings, linked from the sidebar and Energy sections. Unset: DEFAULT_LINKS; null: off. */
  meterkastUrl?: string | null;
  /** Parcel map viewer; the address is appended as ?q=. Unset: DEFAULT_LINKS; null: off. */
  parcelViewerUrl?: string | null;
  /** How much of the Workbench shows: quick, standard or detail. Unset: see settings.ui. */
  uiDepth?: UiDepth;
}

export function loadSettings(): AppSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf-8")) as AppSettings;
  } catch {
    return {};
  }
}

export function saveSettings(patch: AppSettings): AppSettings {
  const current = loadSettings();
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === "") delete (next as Record<string, unknown>)[k];
    else (next as Record<string, unknown>)[k] = v;
  }
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}
