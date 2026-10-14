/** Click the selected detection again to clear it so every frame can show. */
export function toggleSelection<K>(current: K | null, key: K): K | null {
  return current === key ? null : key;
}

/** Only the selected detection's frame, or every visible one when none is selected. */
export function framesOnPhoto<T, K>(visible: T[], selectedKey: K | null, keyOf: (row: T) => K): T[] {
  if (selectedKey == null) return visible;
  return visible.filter((row) => keyOf(row) === selectedKey);
}

/**
 * Existing Things stay off the list and photo until "Show all".
 * `isExisting` is whatever match the caller already has — do not invent a new one.
 */
export function visibleDetections<T>(rows: T[], showAll: boolean, isExisting: (row: T) => boolean): T[] {
  return showAll ? rows : rows.filter((row) => !isExisting(row));
}

/** How many existing detections the default view is holding back. */
export function hiddenExistingCount<T>(rows: T[], isExisting: (row: T) => boolean): number {
  return rows.filter(isExisting).length;
}

/** Drop a discarded detection from the working list; clear selection if it was that one. */
export function discardDetection<T, K>(
  rows: T[],
  key: K,
  selectedKey: K | null,
  keyOf: (row: T) => K,
): { rows: T[]; selectedKey: K | null } {
  return {
    rows: rows.filter((row) => keyOf(row) !== key),
    selectedKey: selectedKey === key ? null : selectedKey,
  };
}

/** Inbox detect: a still-open suggestion already matched to a Thing. */
export function isMatchedOpenSuggestion(s: { state: string; matchedItemId: number | null }): boolean {
  return s.state === "open" && s.matchedItemId != null;
}

/** Annotate: already linked to a Thing, or the page's own duplicate-of-a-pin check. */
export function isExistingSuggestedPin(s: { itemId: number | null }, isDuplicateOfPin: boolean): boolean {
  return s.itemId != null || isDuplicateOfPin;
}
