import type { SupabaseClient } from "@supabase/supabase-js";
import { displayCollegeTeamNameForUi } from "@/lib/college-team-display";
import { loadSeasonProjectionBundle, projectionIntForPlayer } from "@/lib/player-pool-projection";
import { playerHasValidSeasonPpg } from "@/lib/player-pool-eligibility";
import { computeLeagueLeaderboardAndRoundScores } from "@/lib/scoring";
import { fetchTournamentSeasonTeamsMerged } from "@/lib/tournament-season-teams";

function safeNum(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function seasonPpgOrDefault(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n) || n <= 0) return 68;
  return n;
}

export type PoolScoresPlayerRow = {
  id: number;
  name: string;
  shortName: string | null;
  seasonPpg: number;
  /** Integer projection: actual tournament pts (final/live) + PPG × expected remaining scheduled games (no-upset path). */
  expPts: number;
  available: boolean;
  pickedByOwnerName: string | null;
  team: {
    id: number;
    name: string;
    seed: number | null;
    overallSeed: number | null;
    region: string | null;
  } | null;
};

export type PoolScoresApiResponse = {
  leagueId: string;
  seasonYear: number;
  currentRound: number;
  lastSyncedAt: string | null;
  partialDataWarning: boolean;
  anyLiveGames: boolean;
  liveGamesCount: number;
  players: PoolScoresPlayerRow[];
};

export async function buildPoolScoresResponse(
  supabase: SupabaseClient,
  leagueId: string
): Promise<PoolScoresApiResponse> {
  const { data: league } = await supabase
    .from("leagues")
    .select("season_year")
    .eq("id", leagueId)
    .maybeSingle();

  const seasonYear = (league as { season_year?: number } | null)?.season_year;
  if (!seasonYear) {
    throw new Error("league not found or missing season_year");
  }

  const scoring = await computeLeagueLeaderboardAndRoundScores(supabase, leagueId);

  const { data: draftRoom } = await supabase
    .from("draft_rooms")
    .select("id")
    .eq("league_id", leagueId)
    .maybeSingle();

  const { data: picks } = draftRoom
    ? await supabase
        .from("player_draft_picks")
        .select("player_id, league_team_id")
        .eq("draft_room_id", draftRoom.id)
    : { data: [] as any[] };

  const pickedPlayerIds = new Set((picks ?? []).map((p: any) => safeNum(p.player_id)));

  const pickOwnerByPlayerId = new Map<number, string>();
  if ((picks ?? []).length > 0) {
    const ltIds = Array.from(
      new Set((picks ?? []).map((p: any) => String(p.league_team_id)))
    );
    const { data: leagueTeams } = await supabase
      .from("league_teams")
      .select("id, team_name, user_id")
      .in("id", ltIds);

    const ltById = new Map<string, any>((leagueTeams ?? []).map((t: any) => [String(t.id), t]));
    const userIds = Array.from(
      new Set((leagueTeams ?? []).map((t: any) => t.user_id).filter(Boolean))
    );
    const { data: profiles } =
      userIds.length > 0
        ? await supabase.from("profiles").select("id, display_name").in("id", userIds)
        : { data: [] as any[] };
    const profById = new Map<string, any>((profiles ?? []).map((p: any) => [p.id, p]));

    for (const p of picks ?? []) {
      const pid = safeNum((p as any).player_id);
      const lt = ltById.get(String((p as any).league_team_id));
      const ownerName =
        lt?.team_name ?? profById.get(lt?.user_id)?.display_name ?? "Unknown";
      pickOwnerByPlayerId.set(pid, ownerName);
    }
  }

  const { data: players } = await supabase
    .from("players")
    .select("id, name, short_name, season_ppg, team_id")
    .eq("season_year", seasonYear);

  const eligiblePlayers = (players ?? []).filter((p: any) => playerHasValidSeasonPpg(p.season_ppg));

  const eligibleTeamIds = eligiblePlayers.map((p: any) => safeNum(p.team_id)).filter((id: number) => id > 0);
  const teamsMerged = await fetchTournamentSeasonTeamsMerged(
    supabase,
    seasonYear,
    eligibleTeamIds,
    "id, name, short_name, seed, overall_seed, region, external_team_id"
  );

  const teamById = new Map<number, any>(teamsMerged.map((t: any) => [safeNum(t.id), t]));

  const playerIds = eligiblePlayers.map((p: any) => safeNum(p.id)).filter((id: number) => id > 0);
  const bundle = await loadSeasonProjectionBundle(supabase, seasonYear, playerIds);

  const rows: PoolScoresPlayerRow[] = eligiblePlayers.map((p: any) => {
    const tid = safeNum(p.team_id);
    const pid = safeNum(p.id);
    const ppg = seasonPpgOrDefault(p.season_ppg);
    const available = !pickedPlayerIds.has(pid);
    const t = teamById.get(tid);
    const expPts = projectionIntForPlayer({
      teamId: tid,
      playerId: pid,
      seasonPpg: p.season_ppg,
      bundle
    });
    return {
      id: pid,
      name: String(p.name ?? ""),
      shortName: p.short_name ?? null,
      seasonPpg: ppg,
      expPts,
      available,
      pickedByOwnerName: available ? null : pickOwnerByPlayerId.get(pid) ?? "—",
      team: t
        ? {
            id: safeNum(t.id),
            name: displayCollegeTeamNameForUi(t, `Team #${safeNum(t.id)}`),
            seed: t.seed != null ? safeNum(t.seed) : null,
            overallSeed: t.overall_seed != null ? safeNum(t.overall_seed) : null,
            region: t.region != null ? String(t.region) : null
          }
        : null
    };
  });

  rows.sort((a, b) => {
    if (b.expPts !== a.expPts) return b.expPts - a.expPts;
    return a.name.localeCompare(b.name);
  });

  return {
    leagueId,
    seasonYear,
    currentRound: scoring.currentRound,
    lastSyncedAt: scoring.lastSyncedAt,
    partialDataWarning: scoring.partialDataWarning,
    anyLiveGames: scoring.anyLiveGames,
    liveGamesCount: scoring.liveGamesCount,
    players: rows
  };
}
