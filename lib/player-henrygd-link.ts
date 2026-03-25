/**
 * Link third-party pool rows (`…:cbbd:…`, `…:espn:…`) to henrygd box-score player ids (`…:{seoname}:{id}`).
 */

/** Parse henrygd boxscore id from `external_player_id` when it is not a third-party stats row. */
export function parseHenrygdBoxscorePlayerIdFromExternal(
  externalPlayerId: string | null | undefined
): string | null {
  if (!externalPlayerId?.trim()) return null;
  const parts = externalPlayerId.split(":");
  if (parts.length < 3) return null;
  if (parts[1] === "cbbd" || parts[1] === "espn") return null;
  const id = parts[parts.length - 1]?.trim();
  return id || null;
}
