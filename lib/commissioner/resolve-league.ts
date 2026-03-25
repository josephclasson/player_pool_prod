import type { SupabaseClient } from "@supabase/supabase-js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResolvedLeagueRow = { id: string; season_year: number; name: string };

function normalizeParam(raw: string) {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

export function paramLooksLikeLeagueUuid(raw: string): boolean {
  return UUID_RE.test(normalizeParam(raw));
}

/**
 * Commissioner routes accept either the league row UUID or the short `leagues.code`
 * (e.g. demo "365"). For code, we use the newest `season_year` row if several exist.
 */
export async function resolveLeagueFromCommissionerParam(
  supabase: SupabaseClient,
  rawLeagueParam: string
): Promise<
  | { ok: true; league: ResolvedLeagueRow }
  | { ok: false; error: string; status: 400 | 404 | 503 }
> {
  const key = normalizeParam(rawLeagueParam);
  if (!key) {
    return { ok: false, error: "leagueId required", status: 400 };
  }

  if (paramLooksLikeLeagueUuid(key)) {
    const { data, error } = await supabase
      .from("leagues")
      .select("id, season_year, name")
      .eq("id", key)
      .maybeSingle();

    if (error) {
      return {
        ok: false,
        error: `League lookup failed: ${error.message}`,
        status: 503
      };
    }
    if (!data) {
      return {
        ok: false,
        error:
          "League not found for that id. Use your league UUID from the Draft tab or Commissioner Tools, or your league code (e.g. 365).",
        status: 404
      };
    }
    return { ok: true, league: data as ResolvedLeagueRow };
  }

  const { data: rows, error } = await supabase
    .from("leagues")
    .select("id, season_year, name")
    .eq("code", key)
    .order("season_year", { ascending: false })
    .limit(1);

  if (error) {
    return {
      ok: false,
      error: `League lookup failed: ${error.message}`,
      status: 503
    };
  }

  const row = (rows?.[0] ?? null) as ResolvedLeagueRow | null;
  if (!row) {
    return {
      ok: false,
      error: `No league with code "${key}". Use the UUID from the Draft tab or a valid code.`,
      status: 404
    };
  }

  return { ok: true, league: row };
}
