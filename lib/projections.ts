import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeagueLeaderboardTeamRow } from "@/lib/scoring";
import {
  computeExpectedChalkGamesPlayedFromBracket,
  type ChalkTeamMeta as BracketChalkTeamMeta
} from "@/lib/chalk-bracket-sim";
import { isFinalStatus, isLiveStatus } from "@/lib/chalk-remaining-games";
import { playerTournamentProjectionsCore } from "@/lib/player-pool-projection";
import {
  buildBracketStateFromHenrygdAndDb,
  countPlayedTournamentGamesForTeam,
  sumPointsFromPlayerGameStats,
  type BracketState,
  type DbTournamentGameRow
} from "@/lib/tournament-projection";
import { fetchTournamentSeasonTeamsMerged } from "@/lib/tournament-season-teams";
import {
  buildEliminationRoundByCanonicalFromGames,
  fetchTeamRowsForCanonicalKeys,
  reconcileCanonicalTeamIdsFromRows,
  resolveCanonicalTeamKeyFromRow,
  stablePoolSlugForTeamContext,
  type TeamRowForCanonical
} from "@/lib/tournament-team-canonical";

export type ProjectionRow = {
  leagueTeamId: string;
  /** Sum of per-player integer projections (no-upset sim + actual tournament points). */
  projectionChalk: number | null;
};

function safeNum(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function seasonPpgOrDefault(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n) || n <= 0) return 68;
  return n;
}

export type ProjectionsComputationResult = {
  teams: Array<LeagueLeaderboardTeamRow & ProjectionRow>;
  /** `player_roster_slots.id` → integer live projection for that roster row. */
  slotProjectionByRosterSlotId: Map<string, number>;
};

/**
 * Per-player projection (integer):
 * - Eliminated team: sum of actual tournament points (final + live box scores).
 * - Active team: actual points + season PPG × (full chalk expected games − R1–R6 games played: decisive finals + live).
 */
export async function computeLeagueProjections(
  supabase: SupabaseClient,
  leagueId: string
): Promise<ProjectionsComputationResult> {
  const { data: league } = await supabase.from("leagues").select("season_year").eq("id", leagueId).maybeSingle();
  const seasonYear = (league as { season_year?: number } | null)?.season_year;
  if (!seasonYear) {
    const { computeLeagueLeaderboardAndRoundScores } = await import("@/lib/scoring");
    const scoring = await computeLeagueLeaderboardAndRoundScores(supabase, leagueId);
    return {
      teams: scoring.teams.map((t) => ({ ...t, projectionChalk: null })),
      slotProjectionByRosterSlotId: new Map()
    };
  }

  const { data: leagueTeams } = await supabase
    .from("league_teams")
    .select("id, user_id")
    .eq("league_id", leagueId);

  const ltRows = leagueTeams ?? [];
  if (ltRows.length === 0) {
    return { teams: [], slotProjectionByRosterSlotId: new Map<string, number>() };
  }

  const leagueTeamIds = ltRows.map((t: { id: string }) => t.id as string);
  const { data: rosterSlots } = await supabase
    .from("player_roster_slots")
    .select("id, league_team_id, player_id, team_id")
    .in("league_team_id", leagueTeamIds);

  const slots = rosterSlots ?? [];
  const rosterTeamIds = Array.from(new Set(slots.map((s: { team_id: unknown }) => safeNum(s.team_id)))).filter(
    (id) => id > 0
  );
  const rosterPlayerIds = Array.from(new Set(slots.map((s: { player_id: unknown }) => safeNum(s.player_id)))).filter(
    (id) => id > 0
  );

  const { data: rosterPlayers } = await supabase
    .from("players")
    .select("id, season_ppg, team_id")
    .in("id", rosterPlayerIds);
  const seasonPpgByPlayer = new Map<number, number>();
  const playerTeamIdByPlayerId = new Map<number, number>();
  for (const p of rosterPlayers ?? []) {
    const pid = safeNum((p as { id: unknown }).id);
    if (pid > 0) {
      seasonPpgByPlayer.set(pid, seasonPpgOrDefault((p as { season_ppg: unknown }).season_ppg));
      playerTeamIdByPlayerId.set(pid, safeNum((p as { team_id: unknown }).team_id));
    }
  }

  const { data: games } = await supabase
    .from("games")
    .select("id, round, status, start_time, team_a_id, team_b_id, team_a_score, team_b_score")
    .in("round", [0, 1, 2, 3, 4, 5, 6]);

  const dbGameRows: DbTournamentGameRow[] = (games ?? []).map((g: Record<string, unknown>) => ({
    id: safeNum(g.id),
    round: safeNum(g.round),
    status: String(g.status ?? ""),
    team_a_id: safeNum(g.team_a_id),
    team_b_id: safeNum(g.team_b_id),
    team_a_score: g.team_a_score != null ? safeNum(g.team_a_score) : null,
    team_b_score: g.team_b_score != null ? safeNum(g.team_b_score) : null
  }));

  const gameRows = dbGameRows;
  const gameRowsWithTime = (games ?? []).map((g: Record<string, unknown>) => ({
    id: safeNum(g.id),
    round: safeNum(g.round),
    status: String(g.status ?? ""),
    start_time: String(g.start_time ?? ""),
    team_a_id: safeNum(g.team_a_id),
    team_b_id: safeNum(g.team_b_id),
    team_a_score: g.team_a_score != null ? safeNum(g.team_a_score) : null,
    team_b_score: g.team_b_score != null ? safeNum(g.team_b_score) : null
  }));

  const teamsRows = await fetchTournamentSeasonTeamsMerged(
    supabase,
    seasonYear,
    rosterTeamIds,
    "id, overall_seed, seed, external_team_id"
  );

  const teamIdByExternalTeamId = new Map<string, number>(
    teamsRows.map((t) => [
      String((t as Record<string, unknown>).external_team_id ?? ""),
      safeNum((t as Record<string, unknown>).id)
    ])
  );

  const overallRankByTeamId = new Map<number, number | null>(
    teamsRows.map((t) => {
      const tr = t as Record<string, unknown>;
      return [
        safeNum(tr.id),
        tr.overall_seed != null ? safeNum(tr.overall_seed) : null
      ] as const;
    })
  );

  let bracketState: BracketState = { seasonYear, games: [] };
  try {
    bracketState = await buildBracketStateFromHenrygdAndDb({
      seasonYear,
      teamIdByExternalTeamId,
      dbGames: dbGameRows,
      overallRankByTeamId
    });
  } catch {
    bracketState = { seasonYear, games: [] };
  }

  const gameSideTeamIds = new Set<number>();
  for (const g of gameRowsWithTime) {
    if (g.team_a_id > 0) gameSideTeamIds.add(g.team_a_id);
    if (g.team_b_id > 0) gameSideTeamIds.add(g.team_b_id);
  }
  const playerTeamIds = [...playerTeamIdByPlayerId.values()].filter((id) => id > 0);
  const allCanonTeamIds = [
    ...new Set<number>([...rosterTeamIds, ...gameSideTeamIds, ...playerTeamIds])
  ];
  const canonRows = await fetchTeamRowsForCanonicalKeys(supabase, allCanonTeamIds);
  const canonRowById = new Map<number, TeamRowForCanonical>();
  for (const row of canonRows) {
    const id = safeNum(row.id);
    if (id > 0) canonRowById.set(id, row);
  }
  const canonicalByInternalTeamId = new Map<number, string>();
  for (const id of allCanonTeamIds) {
    const row = canonRowById.get(id);
    canonicalByInternalTeamId.set(id, row ? resolveCanonicalTeamKeyFromRow(row) : `__id_${id}`);
  }
  reconcileCanonicalTeamIdsFromRows(canonRows, canonicalByInternalTeamId);
  const eliminationRoundByCanonical = buildEliminationRoundByCanonicalFromGames(
    gameRowsWithTime,
    canonicalByInternalTeamId,
    canonRowById
  );

  function isInternalTeamIdEliminated(tid: number): boolean {
    const slug = stablePoolSlugForTeamContext(tid, canonicalByInternalTeamId, canonRowById);
    return slug != null && eliminationRoundByCanonical.has(slug);
  }

  function rosterSlotTeamEliminated(slotTeamId: number, playerId: number): boolean {
    const effective = playerTeamIdByPlayerId.get(playerId) ?? slotTeamId;
    if (isInternalTeamIdEliminated(effective)) return true;
    if (slotTeamId !== effective && isInternalTeamIdEliminated(slotTeamId)) return true;
    return false;
  }

  const allTeamsProjection = new Map<string, { overallRank: number; isActive: boolean }>();
  for (const teamId of rosterTeamIds) {
    const os = overallRankByTeamId.get(teamId);
    const rank = os != null && os > 0 ? os : 999;
    allTeamsProjection.set(String(teamId), {
      overallRank: rank,
      isActive: !isInternalTeamIdEliminated(teamId)
    });
  }

  let expectedChalkGamesTotalByTeamId = new Map<number, number>();
  try {
    const metaByTeamId = new Map<number, BracketChalkTeamMeta>();
    for (const t of teamsRows) {
      const id = safeNum((t as { id: unknown }).id);
      if (id <= 0) continue;
      metaByTeamId.set(id, {
        teamId: id,
        overallSeed: (t as { overall_seed?: unknown }).overall_seed != null ? safeNum((t as { overall_seed: unknown }).overall_seed) : null,
        regionalSeed: (t as { seed?: unknown }).seed != null ? safeNum((t as { seed: unknown }).seed) : null
      });
    }
    expectedChalkGamesTotalByTeamId = await computeExpectedChalkGamesPlayedFromBracket({
      seasonYear,
      metaByTeamId,
      teamIdByExternalTeamId
    });
  } catch {
    expectedChalkGamesTotalByTeamId = new Map();
  }

  const completedTournamentGamesByTeamId = new Map<number, number>();
  for (const teamId of rosterTeamIds) {
    completedTournamentGamesByTeamId.set(teamId, countPlayedTournamentGamesForTeam(teamId, dbGameRows));
  }

  const tournamentGameIds = new Set(
    gameRows.filter((g) => isFinalStatus(g.status) || isLiveStatus(g.status)).map((g) => g.id)
  );

  const statsByPlayer = new Map<number, Array<{ points: unknown }>>();
  const statGameIdsByPlayerId = new Map<number, Set<number>>();
  if (rosterPlayerIds.length > 0 && tournamentGameIds.size > 0) {
    const { data: pgs } = await supabase
      .from("player_game_stats")
      .select("player_id, points, game_id")
      .in("player_id", rosterPlayerIds)
      .in("game_id", [...tournamentGameIds]);

    for (const row of pgs ?? []) {
      const pid = safeNum((row as { player_id: unknown }).player_id);
      const gid = safeNum((row as { game_id: unknown }).game_id);
      const arr = statsByPlayer.get(pid) ?? [];
      arr.push({ points: (row as { points: unknown }).points });
      statsByPlayer.set(pid, arr);
      if (pid > 0 && gid > 0) {
        const gset = statGameIdsByPlayerId.get(pid) ?? new Set<number>();
        gset.add(gid);
        statGameIdsByPlayerId.set(pid, gset);
      }
    }
  }

  const { computeLeagueLeaderboardAndRoundScores } = await import("@/lib/scoring");
  const scoring = await computeLeagueLeaderboardAndRoundScores(supabase, leagueId);
  const baseLeaderboard = scoring.teams;

  const slotsByLeagueTeam = new Map<string, typeof slots>();
  for (const s of slots) {
    const lid = s.league_team_id as string;
    const arr = slotsByLeagueTeam.get(lid) ?? [];
    arr.push(s);
    slotsByLeagueTeam.set(lid, arr);
  }

  const projectedByLeagueTeam = new Map<string, number | null>();
  const slotProjectionByRosterSlotId = new Map<string, number>();

  for (const lt of baseLeaderboard) {
    const ltId = lt.leagueTeamId;
    const ltSlots = slotsByLeagueTeam.get(ltId) ?? [];
    if (ltSlots.length === 0) {
      projectedByLeagueTeam.set(ltId, null);
      continue;
    }

    let sumProj = 0;
    for (const slot of ltSlots) {
      const teamId = safeNum(slot.team_id);
      const playerId = safeNum(slot.player_id);
      const ppg = seasonPpgByPlayer.get(playerId) ?? 68;
      const actualPts = sumPointsFromPlayerGameStats(statsByPlayer.get(playerId) ?? []);
      const eliminated = rosterSlotTeamEliminated(teamId, playerId);
      const proj = playerTournamentProjectionsCore({
        teamId,
        seasonPpg: ppg,
        actualTournamentPoints: actualPts,
        teamEliminated: eliminated,
        bracketState,
        allTeams: allTeamsProjection,
        expectedChalkGamesTotalByTeamId,
        completedTournamentGamesByTeamId,
        statDistinctGameCount: statGameIdsByPlayerId.get(playerId)?.size ?? 0
      }).liveProjection;
      slotProjectionByRosterSlotId.set(String(slot.id), proj);
      sumProj += proj;
    }

    projectedByLeagueTeam.set(ltId, sumProj);
  }

  const projectedTeams = baseLeaderboard.map((t) => ({
    ...t,
    projectionChalk: projectedByLeagueTeam.get(t.leagueTeamId) ?? null
  }));

  return { teams: projectedTeams, slotProjectionByRosterSlotId };
}

/**
 * Draft-completion snapshot: season PPG × expected chalk tournament games played (full bracket, no live results).
 */
export async function computeLeagueChalkOriginalTotals(
  supabase: SupabaseClient,
  leagueId: string
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();

  const { data: league } = await supabase
    .from("leagues")
    .select("season_year")
    .eq("id", leagueId)
    .maybeSingle();
  const seasonYear = (league as { season_year?: number } | null)?.season_year;
  if (!seasonYear) return out;

  const { data: leagueTeams } = await supabase.from("league_teams").select("id").eq("league_id", leagueId);
  const ltRows = leagueTeams ?? [];
  if (ltRows.length === 0) return out;

  const leagueTeamIds = ltRows.map((t: { id: string }) => t.id as string);
  const { data: rosterSlots } = await supabase
    .from("player_roster_slots")
    .select("league_team_id, player_id, team_id")
    .in("league_team_id", leagueTeamIds);

  const slots = rosterSlots ?? [];
  const slotsByLeagueTeam = new Map<string, typeof slots>();
  for (const s of slots) {
    const lid = s.league_team_id as string;
    const arr = slotsByLeagueTeam.get(lid) ?? [];
    arr.push(s);
    slotsByLeagueTeam.set(lid, arr);
  }

  const rosterPlayerIds = Array.from(new Set(slots.map((s: { player_id: unknown }) => safeNum(s.player_id)))).filter(
    (id) => id > 0
  );

  const rosterTeamIdsForChalk = Array.from(
    new Set(slots.map((s: { team_id: unknown }) => safeNum(s.team_id)).filter((id) => id > 0))
  );
  const teamsForChalk = await fetchTournamentSeasonTeamsMerged(
    supabase,
    seasonYear,
    rosterTeamIdsForChalk,
    "id, seed, overall_seed, external_team_id"
  );

  const metaByTeamId = new Map<number, BracketChalkTeamMeta>(
    teamsForChalk.map((t: Record<string, unknown>) => [
      safeNum(t.id),
      {
        teamId: safeNum(t.id),
        overallSeed: t.overall_seed != null ? safeNum(t.overall_seed) : null,
        regionalSeed: t.seed != null ? safeNum(t.seed) : null
      }
    ])
  );

  const teamIdByExternalTeamId = new Map<string, number>(
    teamsForChalk.map((t: Record<string, unknown>) => [String(t.external_team_id ?? ""), safeNum(t.id)])
  );

  let gamesPlayedByTeamId: Map<number, number>;
  try {
    gamesPlayedByTeamId = await computeExpectedChalkGamesPlayedFromBracket({
      seasonYear,
      metaByTeamId,
      teamIdByExternalTeamId
    });
  } catch {
    gamesPlayedByTeamId = new Map();
  }

  const { data: rosterPlayers } = await supabase
    .from("players")
    .select("id, season_ppg")
    .in("id", rosterPlayerIds)
    .eq("season_year", seasonYear);

  const seasonPpgByPlayer = new Map<number, number>();
  for (const p of rosterPlayers ?? []) {
    seasonPpgByPlayer.set(safeNum(p.id), seasonPpgOrDefault(p.season_ppg));
  }

  for (const ltId of leagueTeamIds) {
    const ltSlots = slotsByLeagueTeam.get(ltId) ?? [];
    if (ltSlots.length === 0) {
      out.set(ltId, null);
      continue;
    }
    let sum = 0;
    for (const slot of ltSlots) {
      const tid = safeNum(slot.team_id);
      const pid = safeNum(slot.player_id);
      const ppg = seasonPpgByPlayer.get(pid) ?? 68;
      const eg = gamesPlayedByTeamId.get(tid) ?? 6;
      sum += ppg * eg;
    }
    out.set(ltId, sum);
  }

  return out;
}

export async function upsertLeagueProjectionChalkPreservingOriginals(
  supabase: SupabaseClient,
  leagueId: string,
  teams: Array<{ leagueTeamId: string; projectionChalk: number | null }>
): Promise<void> {
  if (teams.length === 0) return;

  const { data: existing } = await supabase
    .from("projections")
    .select("league_team_id, projection_chalk_original, projection_original_captured_at")
    .eq("league_id", leagueId);

  const byLt = new Map(
    (existing ?? []).map((r: Record<string, unknown>) => [
      String(r.league_team_id),
      {
        projection_chalk_original:
          r.projection_chalk_original != null ? Number(r.projection_chalk_original) : null,
        projection_original_captured_at:
          r.projection_original_captured_at != null ? String(r.projection_original_captured_at) : null
      }
    ])
  );

  const projPayload = teams.map((t) => {
    const prev = byLt.get(t.leagueTeamId);
    return {
      league_id: leagueId,
      league_team_id: t.leagueTeamId,
      win_chance: null as number | null,
      pool_odds_label: null as string | null,
      projection_chalk: t.projectionChalk != null ? Number(t.projectionChalk.toFixed(2)) : null,
      projection_chalk_original: prev?.projection_chalk_original ?? null,
      projection_original_captured_at: prev?.projection_original_captured_at ?? null
    };
  });

  const { error } = await supabase.from("projections").upsert(projPayload, {
    onConflict: "league_id,league_team_id"
  });
  if (error) throw error;
}

export async function captureLeagueOriginalProjectionsIfNeeded(
  supabase: SupabaseClient,
  leagueId: string
): Promise<{ captured: number }> {
  const { data: dr } = await supabase
    .from("draft_rooms")
    .select("status")
    .eq("league_id", leagueId)
    .maybeSingle();
  if (String(dr?.status ?? "") !== "completed") return { captured: 0 };

  const totals = await computeLeagueChalkOriginalTotals(supabase, leagueId);
  const { data: rows } = await supabase
    .from("projections")
    .select("id, league_team_id, projection_chalk_original")
    .eq("league_id", leagueId);

  const byLt = new Map<string, { id: number; projection_chalk_original: number | null }>(
    (rows ?? []).map((r: Record<string, unknown>) => [
      String(r.league_team_id),
      {
        id: safeNum(r.id),
        projection_chalk_original: r.projection_chalk_original != null ? Number(r.projection_chalk_original) : null
      }
    ])
  );

  const now = new Date().toISOString();
  let captured = 0;

  for (const [ltId, total] of totals) {
    if (total == null || !Number.isFinite(total)) continue;
    const ex = byLt.get(ltId);
    if (ex?.projection_chalk_original != null) continue;

    const payload = {
      projection_chalk_original: Number(total.toFixed(2)),
      projection_original_captured_at: now
    };

    if (ex?.id != null) {
      const { error } = await supabase.from("projections").update(payload).eq("id", ex.id);
      if (!error) captured++;
    } else {
      const { error } = await supabase.from("projections").insert({
        league_id: leagueId,
        league_team_id: ltId,
        ...payload
      });
      if (!error) captured++;
    }
  }

  return { captured };
}

export async function clearLeagueOriginalProjections(
  supabase: SupabaseClient,
  leagueId: string
): Promise<void> {
  await supabase
    .from("projections")
    .update({ projection_chalk_original: null, projection_original_captured_at: null })
    .eq("league_id", leagueId);
}
