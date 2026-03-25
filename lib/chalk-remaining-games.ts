/**
 * Shared helpers for tournament game status (used by scoring + projection).
 */

/** Exported for scoring + sync (henrygd may vary casing). */
export function isFinalStatus(status: string): boolean {
  const s = String(status ?? "").trim().toLowerCase();
  // Providers vary: final, final_ot, post, finished, complete, closed, ended.
  return (
    s === "post" ||
    s === "finished" ||
    s === "complete" ||
    s === "closed" ||
    s === "ended" ||
    s.startsWith("final")
  );
}

export function isLiveStatus(status: string): boolean {
  return String(status ?? "").trim().toLowerCase() === "live";
}
