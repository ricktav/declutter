/**
 * Place scoping and CLI for the local batch detector. Pure helpers so tests
 * do not download models or touch a database.
 */

export type CapturePlace = { houseId: number | null; roomId: number | null };

/**
 * Location photo's room wins (and that room's house). A missing room row is
 * not invented: fall back to the capture's house, unplaced. No house and no
 * room → empty place; callers must not match known names across every house.
 */
export function resolveCapturePlace(input: {
  captureHouseId: number | null | undefined;
  locationRoomId: number | null | undefined;
  locationHouseId: number | null | undefined;
}): CapturePlace {
  const captureHouseId = input.captureHouseId ?? null;
  const locationRoomId = input.locationRoomId ?? null;
  const locationHouseId = input.locationHouseId ?? null;
  if (locationRoomId != null && locationHouseId != null) {
    return { roomId: locationRoomId, houseId: locationHouseId };
  }
  return { roomId: null, houseId: captureHouseId };
}

export type NamedPlaceItem = {
  name: string;
  houseId: number | null;
  roomId: number | null;
};

/**
 * Known-name OWL candidates for one capture. Room → only Things of that
 * Place (stops kitchen/bathroom names matching a desk photo). House and no
 * room → that house. No place → none (do not search every house).
 */
export function knownItemsForPlace<T extends NamedPlaceItem>(items: T[], place: CapturePlace): T[] {
  if (place.roomId != null) return items.filter((it) => it.roomId === place.roomId);
  if (place.houseId != null) return items.filter((it) => it.houseId === place.houseId);
  return [];
}

export type BatchDetectCli = {
  apply: boolean;
  label: boolean;
  florence: boolean | undefined;
  model?: string;
  threshold?: number;
  limit?: number;
  maxResults: number;
  florenceReserve?: number;
};

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1];
  return undefined;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

function parseThreshold(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return undefined;
  return n;
}

/**
 * Default is dry-run (no DB / file / claude writes). `--apply` is required
 * to file. `--no-label` skips claude -p even on apply. Existing `--model`,
 * `--threshold`, `--florence` / `--no-florence` are unchanged.
 */
export function parseBatchDetectCli(argv: string[]): BatchDetectCli {
  const apply = argv.includes("--apply") && !argv.includes("--dry-run");
  const noLabel = argv.includes("--no-label") || argv.includes("--no-claude");
  const florence = argv.includes("--no-florence")
    ? false
    : argv.includes("--florence")
      ? true
      : undefined;
  const model = argValue(argv, "--model");
  const threshold = parseThreshold(argValue(argv, "--threshold"));
  const limit = parsePositiveInt(argValue(argv, "--limit") ?? argValue(argv, "-n"));
  const maxResults = parsePositiveInt(argValue(argv, "--max-results")) ?? 10;
  const florenceReserve = parsePositiveInt(argValue(argv, "--florence-reserve"));
  return {
    apply,
    label: apply && !noLabel,
    florence,
    ...(model ? { model } : {}),
    ...(threshold != null ? { threshold } : {}),
    ...(limit != null ? { limit } : {}),
    maxResults: maxResults > 0 ? maxResults : 10,
    ...(florenceReserve != null ? { florenceReserve } : {}),
  };
}

export function formatPlace(place: CapturePlace, names?: { houseName?: string | null; roomName?: string | null }): string {
  if (place.roomId != null) {
    const room = names?.roomName ? `"${names.roomName}"` : `#${place.roomId}`;
    const house = names?.houseName ? `"${names.houseName}"` : place.houseId != null ? `#${place.houseId}` : "unknown house";
    return `room ${room} in ${house}`;
  }
  if (place.houseId != null) {
    const house = names?.houseName ? `"${names.houseName}"` : `#${place.houseId}`;
    return `house ${house}, no room`;
  }
  return "no place (known names skipped)";
}
