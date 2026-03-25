import { espnNcaamPlayerHeadshotUrlCandidates } from "@/lib/espn-ncaam-assets";

/** Row shape from Supabase `players` (+ optional joined `teams`). */
export type PlayerMediaFields = {
  headshot_url?: string | null;
  /** ESPN NCAA men's basketball athlete id (same CDN as StatTracker / draft UI). */
  espn_athlete_id?: number | string | null;
};

function parseEspnAthleteId(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/**
 * Ordered URLs for <img src>: stored CDN URL(s) first, then ESPN PNG/JPG (some assets 404 on one extension).
 */
export function resolvePlayerHeadshotUrlCandidates(row: PlayerMediaFields): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    const t = u?.trim();
    if (!t || !/^https?:\/\//i.test(t)) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };

  push(row.headshot_url);
  const id = parseEspnAthleteId(row.espn_athlete_id);
  if (id != null) {
    for (const u of espnNcaamPlayerHeadshotUrlCandidates(id)) push(u);
  }
  return out;
}

/**
 * First candidate only — prefer {@link resolvePlayerHeadshotUrlCandidates} in UIs that can retry on error.
 */
export function resolvePlayerHeadshotUrl(row: PlayerMediaFields): string | null {
  return resolvePlayerHeadshotUrlCandidates(row)[0] ?? null;
}

export type TeamLogoFields = {
  logo_url?: string | null;
};

export function resolveTeamLogoUrl(row: TeamLogoFields, _teamName: string): string | null {
  const u = row.logo_url?.trim();
  return u || null;
}
