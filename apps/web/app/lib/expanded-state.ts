// Session-only mobile card state, newest first. Storage may be unavailable in private browsers.
export const EXPANDED_KEY = "psyhot:expanded";
export const EXPANDED_LIMIT = 200;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

export function getExpandedIds(): string[] {
  try {
    const raw = window.sessionStorage.getItem(EXPANDED_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is string => typeof id === "string" && ID_PATTERN.test(id)))].slice(0, EXPANDED_LIMIT);
  } catch {
    return [];
  }
}

export function setExpanded(id: string, expanded: boolean) {
  if (!ID_PATTERN.test(id)) return;
  const others = getExpandedIds().filter((value) => value !== id);
  const next = expanded ? [id, ...others].slice(0, EXPANDED_LIMIT) : others;
  try { window.sessionStorage.setItem(EXPANDED_KEY, JSON.stringify(next)); } catch { /* the card's local state still works */ }
}

export const EXPAND_EVENT = "psyhot:feed-expand";

/** Only explicit expansions notify the active page counter; restoring saved state does not. */
export function countExpand() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EXPAND_EVENT));
}
