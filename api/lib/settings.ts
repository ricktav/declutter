import fs from "fs";
import path from "path";

const SETTINGS_PATH = path.resolve(process.cwd(), "settings.json");

export interface AppSettings {
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  llmVisionModel?: string;
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
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}
