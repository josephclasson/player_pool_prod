import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSeasonProjectionBundle, playerTournamentProjections } from "@/lib/player-pool-projection";
import {
  externalTeamIdToSeo,
  getEspnMbbTeamIndex,
  resolveEspnTeamLogoFromIndex
} from "@/lib/espn-mbb-directory";
import { resolveEspnTeamLogoForPoolRow } from "@/lib/espn-ncaam-assets";
import { resolvePlayerHeadshotUrlCandidates } from "@/lib/player-media";
import { regionNameFromOverallSeedApprox } from "@/lib/henrygd-bracket-seeds";
import { MIN_POOL_SEASON_PPG } from "@/lib/player-pool-constants";

function safeNum(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

export type PlayerPoolRecord = Record<string, unknown>;

/**
 * Same player rows as `GET /api/players/pool` (enriched JSON), without HTTP/ETag.
 * Used by the leaderboard payload (undrafted highlight) and the pool API route.
 */
export async function buildPlayerPoolRecordsForLeague(
  supabase: SupabaseClient,
  opts: {
    seasonYear: number;
    /** When set, each row gets `ownerTeamName` for league roster/draft picks. */
    leagueId?: string | null;
    limit?: number;
    searchQuery?: string | null;
  }
): Promise<{ players: PlayerPoolRecord[]; hasLiveGames: boolean }> {
  const { seasonYear, leagueId, searchQuery, limit: limitOpt } = opts;
  const take = limitOpt ?? 8000;

  const ownerByPlayerId = new Map<number, string>();
  if (leagueId) {
    const { data: leagueTeams } = await supabase
      .from("league_teams")
      .select("id, team_name")
      .eq("league_id", leagueId);
    const ltRows = (leagueTeams ?? []) as { id: string; team_name: string }[];
    const nameByLtId = new Map(ltRows.map((x) => [x.id, String(x.team_name ?? "Team")]));
    const ltIds = ltRows.map((x) => x.id);

    if (ltIds.length > 0) {
      const { data: slots } = await supabase
        .from("player_roster_slots")
        .select("player_id, league_team_id")
        .in("league_team_id", ltIds);
      for (const s of (slots ?? []) as { player_id: number; league_team_id: string }[]) {
        const pid = safeNum(s.player_id);
        if (pid <= 0) continue;
        const nm = nameByLtId.get(s.league_team_id);
        if (nm) ownerByPlayerId.set(pid, nm);
      }
    }

    const { data: room } = await supabase
      .from("draft_rooms")
      .select("id")
      .eq("league_id", leagueId)
      .maybeSingle();
    const roomId = (room as { id?: string } | null)?.id;
    if (roomId) {
      const { data: picks } = await supabase
        .from("player_draft_picks")
        .select("player_id, league_team_id")
        .eq("draft_room_id", roomId);
      for (const p of (picks ?? []) as { player_id: number; league_team_id: string }[]) {
        const pid = safeNum(p.player_id);
        if (pid <= 0) continue;
        if (ownerByPlayerId.has(pid)) continue;
        const nm = nameByLtId.get(p.league_team_id);
        if (nm) ownerByPlayerId.set(pid, nm);
      }
    }
  }

  const playerSelect =
    "id, name, short_name, position, jersey_number, height, season_year, season_ppg, season_ppg_source, external_player_id, headshot_url, espn_athlete_id, team_id";

  const { data: playerRows, error: pErr } = await supabase
    .from("players")
    .select(playerSelect)
    .eq("season_year", seasonYear)
    .gte("season_ppg", MIN_POOL_SEASON_PPG);

  if (pErr) {
    throw new Error(pErr.message);
  }

  let rows = (playerRows ?? []) as Record<string, unknown>[];
  const q = searchQuery?.trim();
  if (q) {
    const ql = q.toLowerCase();
    rows = rows.filter((p) => String(p.name ?? "").toLowerCase().includes(ql));
  }
  rows.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
  rows = rows.slice(0, take);
  const teamIds = [...new Set(rows.map((r) => safeNum(r.team_id)).filter((id) => id > 0))];
  let teamById = new Map<number, Record<string, unknown>>();

  if (teamIds.length > 0) {
    const { data: teams, error: tErr } = await supabase
      .from("teams")
      .select(
        "id, name, short_name, seed, overall_seed, region, conference, is_power5, external_team_id, logo_url"
      )
      .in("id", teamIds);
    if (!tErr && teams) {
      teamById = new Map(teams.map((t: { id: number }) => [t.id, t as Record<string, unknown>]));
    }
  }

  let espnIdx: Awaited<ReturnType<typeof getEspnMbbTeamIndex>> | null = null;
  try {
    espnIdx = await getEspnMbbTeamIndex();
  } catch {
    espnIdx = null;
  }

  const resolvedLogoByTeamId = new Map<number, string | null>();
  function resolveLogoForTeamRow(t: Record<string, unknown>): string | null {
    const id = safeNum(t.id);
    if (id <= 0) return null;
    if (resolvedLogoByTeamId.has(id)) return resolvedLogoByTeamId.get(id) ?? null;
    const dbLogo = t.logo_url != null ? String(t.logo_url).trim() : "";
    if (dbLogo) {
      resolvedLogoByTeamId.set(id, dbLogo);
      return dbLogo;
    }
    const ext = String(t.external_team_id ?? "");
    const seo = externalTeamIdToSeo(ext, seasonYear);
    const resolved =
      espnIdx != null
        ? resolveEspnTeamLogoFromIndex(espnIdx, {
            logoUrl: null,
            shortName: t.short_name != null ? String(t.short_name) : null,
            fullName: t.name != null ? String(t.name) : null,
            seo
          })
        : null;
    const fallback =
      resolved ??
      resolveEspnTeamLogoForPoolRow({
        logoUrl: null,
        shortName: t.short_name != null ? String(t.short_name) : null,
        fullName: t.name != null ? String(t.name) : null
      });
    resolvedLogoByTeamId.set(id, fallback);
    return fallback;
  }

  const playerIdsForBundle = rows.map((p) => safeNum(p.id)).filter((id) => id > 0);
  const bundle = await loadSeasonProjectionBundle(supabase, seasonYear, playerIdsForBundle);
  const hasLiveGames = bundle.hasLiveGames;

  const players = rows.map((p: Record<string, unknown>) => {
    const tid = p.team_id as number;
    const t = teamById.get(tid);
    const pid = safeNum(p.id);
    const tproj = playerTournamentProjections({
      teamId: tid,
      playerId: pid,
      seasonPpg: p.season_ppg,
      bundle
    });
    const projection = tproj.liveProjection;
    const playingInLiveGame = tid > 0 ? bundle.teamIdsInLiveGame.has(tid) : false;
    const teamMeta = tid > 0 ? bundle.allTeams.get(String(tid)) : null;
    /** Matches leaderboard/scoring: final-loss elimination, not `chalkGamesRemaining === 0` alone. */
    const tournamentEliminated =
      tid <= 0 ? false : teamMeta != null ? !teamMeta.isActive : undefined;
    const byR = bundle.pointsByDisplayRoundByPlayer.get(pid) ?? {};
    const tournamentRoundPoints: Record<number, number> = {};
    for (const key of Object.keys(byR)) {
      const r = Number(key);
      if (!Number.isInteger(r) || r < 1 || r > 6) continue;
      const v = byR[r];
      if (typeof v === "number" && Number.isFinite(v)) tournamentRoundPoints[r] = v;
    }
    const headshotUrls = resolvePlayerHeadshotUrlCandidates({
      headshot_url: p.headshot_url != null ? String(p.headshot_url) : null,
      espn_athlete_id: p.espn_athlete_id as number | string | null | undefined
    });
    const displayHeadshotUrl = headshotUrls[0] ?? null;

    let regionLabel: string | null = null;
    if (t) {
      const tr = t.region;
      if (tr != null && String(tr).trim() !== "") {
        regionLabel = String(tr).trim();
      } else {
        const os = t.overall_seed;
        const on = typeof os === "number" ? os : Number(os);
        if (Number.isFinite(on) && on >= 1 && on <= 68) {
          regionLabel = regionNameFromOverallSeedApprox(Math.trunc(on));
        }
      }
    }

    return {
      ...p,
      displayHeadshotUrl,
      headshotUrls,
      projection,
      projectionChalk: projection,
      originalProjection: tproj.originalProjection,
      tournamentRoundPoints,
      chalkGamesRemaining: tproj.liveExpectedChalkGamesRemaining,
      expectedChalkGamesTotal: tproj.expectedChalkGamesTotal,
      completedTournamentGames: tproj.completedTournamentGames,
      playingInLiveGame,
      tournamentEliminated,
      ownerTeamName: leagueId ? (ownerByPlayerId.get(pid) ?? null) : null,
      team: t
        ? {
            id: t.id,
            name: t.name,
            shortName: t.short_name,
            seed: t.seed,
            overallSeed: t.overall_seed,
            region: regionLabel,
            conference: t.conference,
            isPower5: t.is_power5,
            externalTeamId: t.external_team_id,
            logoUrl: resolveLogoForTeamRow(t)
          }
        : null
    };
  });

  players.sort((a, b) => {
    const ap = (a as { projection?: number }).projection ?? 0;
    const bp = (b as { projection?: number }).projection ?? 0;
    if (bp !== ap) return bp - ap;
    const ao = (a.team as { overallSeed?: unknown } | null)?.overallSeed;
    const bo = (b.team as { overallSeed?: unknown } | null)?.overallSeed;
    const an = ao != null && Number.isFinite(Number(ao)) ? Number(ao) : 999;
    const bn = bo != null && Number.isFinite(Number(bo)) ? Number(bo) : 999;
    if (an !== bn) return an - bn;
    return String((a as Record<string, unknown>).name ?? "").localeCompare(
      String((b as Record<string, unknown>).name ?? "")
    );
  });

  return { players, hasLiveGames };
}
