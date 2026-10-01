import fs from "fs";
import os from "os";
import path from "path";

// Deliberately OUTSIDE the project directory: this file holds API keys in
// plaintext, and the project root is what Vite's dev server serves over the
// LAN (host: true) - a file sitting there is reachable by anyone on the
// network who requests its path, dev server or not.
const SETTINGS_DIR = path.join(os.homedir(), ".declutter");
const SETTINGS_PATH = path.join(SETTINGS_DIR, "settings.json");

export interface AppSettings {
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  llmVisionModel?: string;
  llm2BaseUrl?: string;
  llm2ApiKey?: string;
  llm2Model?: string;
  llm2VisionModel?: string;
}

export function loadSettings(): AppSettings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) as AppSettings;
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
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}
