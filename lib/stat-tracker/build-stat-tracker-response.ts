import type { SupabaseClient } from "@supabase/supabase-js";
import { displayCollegeTeamNameForUi } from "@/lib/college-team-display";
import { computeLeagueProjections } from "@/lib/projections";
import {
  externalTeamIdToSeo,
  getEspnMbbTeamIndex,
  resolveEspnTeamLogoFromIndex
} from "@/lib/espn-mbb-directory";
import { resolveEspnTeamLogoForPoolRow } from "@/lib/espn-ncaam-assets";
import { regionNameFromOverallSeedApprox } from "@/lib/henrygd-bracket-seeds";
import { loadSeasonProjectionBundle, playerTournamentProjections } from "@/lib/player-pool-projection";
import { playerAdvancedPastLeagueActiveRound } from "@/lib/leaderboard-owner-metrics";
import { resolvePlayerHeadshotUrlCandidates } from "@/lib/player-media";
import {
  loadLeagueScoringEngineState,
  resolveLeagueOwnerDisplayName,
  type LeagueScoringEngineState
} from "@/lib/scoring";
import { stablePoolSlugForTeamContext } from "@/lib/tournament-team-canonical";

function safeNum(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function safeEspnAthleteId(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x) && x > 0) return Math.trunc(x);
  if (typeof x === "string") {
    const n = parseInt(x.trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function regionLabelForTeamRow(t: Record<string, unknown> | undefined): string | null {
  if (!t) return null;
  const tr = t.region;
  if (tr != null && String(tr).trim() !== "") return String(tr).trim();
  const os = t.overall_seed;
  const on = typeof os === "number" ? os : Number(os);
  if (Number.isFinite(on) && on >= 1 && on <= 68) {
    return regionNameFromOverallSeedApprox(Math.trunc(on));
  }
  return null;
}

export type StatTrackerPlayerRow = {
  rosterSlotId: string;
  playerId: number;
  /** ESPN athlete id for profile links; null when unknown. */
  espnAthleteId: number | null;
  playerName: string;
  position: string | null;
  /** College team label (short name preferred). */
  teamName: string;
  headshotUrls: string[];
  teamLogoUrl: string | null;
  roundScores: Record<number, number | null | undefined>;
  /** Regional pod seed (1–16), if known. */
  seed: number | null;
  /** NCAA tournament overall seed / S-curve rank (1–68), if known. */
  overallSeed: number | null;
  region: string | null;
  seasonPpg: number;
  total: number;
  /** Live projection (integer). */
  projection: number;
  /** Pre-tournament chalk projection (integer), aligned with Player Statistics. */
  originalProjection: number | null;
  eliminated: boolean;
  /** Tournament display round where team was eliminated (1..6), else null. */
  eliminatedRound: number | null;
  /** Clinched past the league’s active display round (final win there, or eliminated only later). */
  advancedPastActiveRound: boolean;
  /** Player's college team is in a game with `live` status. */
  playingInLiveGame: boolean;
};

export type StatTrackerOwnerRow = {
  leagueTeamId: string;
  ownerName: string;
  draftPosition: number;
  players: StatTrackerPlayerRow[];
};

export type StatTrackerApiResponse = {
  leagueId: string;
  seasonYear: number | null;
  currentRound: number;
  lastSyncedAt: string | null;
  partialDataWarning: boolean;
  anyLiveGames: boolean;
  liveGamesCount: number;
  owners: StatTrackerOwnerRow[];
};

function seasonPpgDisplay(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n) || n <= 0) return 68;
  return n;
}

export async function buildStatTrackerApiResponse(
  supabase: SupabaseClient,
  leagueId: string
): Promise<StatTrackerApiResponse> {
  const engine = await loadLeagueScoringEngineState(supabase, leagueId);
  if (!engine) {
    const { data: leagueRow } = await supabase
      .from("leagues")
      .select("season_year")
      .eq("id", leagueId)
      .maybeSingle();
    const seasonYear =
      leagueRow && (leagueRow as { season_year?: number }).season_year != null
        ? Number((leagueRow as { season_year: number }).season_year)
        : null;
    return {
      leagueId,
      seasonYear,
      currentRound: 0,
      lastSyncedAt: null,
      partialDataWarning: false,
      anyLiveGames: false,
      liveGamesCount: 0,
      owners: []
    };
  }

  const seasonYear = engine.seasonYear;
  const allSlots = engine.slots;
  const playerIds = Array.from(
    new Set(allSlots.map((s) => safeNum(s.player_id)).filter((id) => id > 0))
  );
  let teamIds = Array.from(new Set(allSlots.map((s) => safeNum(s.team_id)).filter((id) => id > 0)));

  const playersPromise =
    playerIds.length > 0 && seasonYear != null
      ? supabase
          .from("players")
          .select("id, name, short_name, position, team_id, season_ppg, headshot_url, espn_athlete_id")
          .in("id", playerIds)
          .eq("season_year", seasonYear)
      : Promise.resolve({ data: [] as any[], error: null });

  const bundlePromise =
    seasonYear != null && playerIds.length > 0
      ? loadSeasonProjectionBundle(supabase, seasonYear, playerIds)
      : Promise.resolve(null);

  const espnIdxPromise = getEspnMbbTeamIndex().catch((): null => null);

  const [projections, liveSbRes, playerRes, bundle, espnIdx, draftRoomRes] = await Promise.all([
    computeLeagueProjections(supabase, leagueId),
    supabase.from("league_live_scoreboard").select("updated_at").eq("league_id", leagueId).maybeSingle(),
    playersPromise,
    bundlePromise,
    espnIdxPromise,
    supabase.from("draft_rooms").select("id").eq("league_id", leagueId).maybeSingle()
  ]);

  const slotProj = projections.slotProjectionByRosterSlotId;
  const liveScoreboardRow = liveSbRes.data;

  // "Synced" should reflect either latest game provider sync OR latest cached scoreboard recompute.
  const mergedLastSyncedAt = (() => {
    const a = engine.lastSyncedAt ? new Date(engine.lastSyncedAt).getTime() : 0;
    const bRaw = (liveScoreboardRow as { updated_at?: unknown } | null)?.updated_at;
    const b = typeof bRaw === "string" ? new Date(bRaw).getTime() : 0;
    const m = Math.max(a, b);
    return m > 0 ? new Date(m).toISOString() : null;
  })();

  const playerRows = (playerRes.data ?? []) as Record<string, unknown>[];
  const playerById = new Map<number, Record<string, unknown>>(
    playerRows.map((p) => [safeNum(p.id), p])
  );

  for (const p of playerRows) {
    const tid = safeNum((p as { team_id?: unknown }).team_id);
    if (tid > 0) teamIds.push(tid);
  }
  teamIds = [...new Set(teamIds.filter((id) => id > 0))];

  const { data: teamsSeason } =
    teamIds.length > 0
      ? await supabase
          .from("teams")
          .select(
            "id, name, short_name, seed, overall_seed, region, conference, is_power5, external_team_id, logo_url"
          )
          .in("id", teamIds)
      : { data: [] as any[] };

  const teamById = new Map<number, Record<string, unknown>>(
    (teamsSeason ?? []).map((t: Record<string, unknown>) => [safeNum(t.id), t])
  );

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
    const seo = seasonYear != null ? externalTeamIdToSeo(ext, seasonYear) : null;
    const resolved =
      espnIdx != null && seo
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

  const rowsByLt = new Map<string, StatTrackerPlayerRow[]>();
  for (const lt of engine.leagueTeamRows) {
    rowsByLt.set(lt.id, []);
  }

  const liveTeamIds = engine.teamIdsInLiveGame;

  for (const slot of allSlots) {
    const slotId = String(slot.id ?? "");
    const ltId = String(slot.league_team_id ?? "");
    if (!slotId || !ltId) continue;

    const c = engine.slotComputed.get(slotId);
    const playerId = safeNum(slot.player_id);
    const rosterTeamId = safeNum(slot.team_id);
    const pRow = playerById.get(playerId);
    const playerTeamFromDb = pRow != null ? safeNum(pRow.team_id) : 0;
    const effectiveTeamId = playerTeamFromDb > 0 ? playerTeamFromDb : rosterTeamId;
    const playerTeamId = pRow != null ? safeNum(pRow.team_id) : rosterTeamId;
    const collegeRow = teamById.get(playerTeamId) ?? teamById.get(rosterTeamId);

    const playerName = String(
      pRow?.name != null && String(pRow.name).trim()
        ? pRow.name
        : pRow?.short_name != null && String(pRow.short_name).trim()
          ? pRow.short_name
          : `Player #${playerId}`
    );
    const fallbackTeam = `Team #${rosterTeamId}`;
    const teamName = displayCollegeTeamNameForUi(collegeRow, fallbackTeam);

    const roundScores: Record<number, number | null | undefined> = {};
    for (let r = 1; r <= 6; r++) {
      const v = c?.pointsByRound[r];
      roundScores[r] = v === undefined ? undefined : v;
    }

    const total = c?.teamTotal ?? 0;
    const seedRaw = collegeRow?.seed != null ? safeNum(collegeRow.seed) : null;
    const seed = seedRaw != null && seedRaw > 0 ? seedRaw : null;
    const overallRaw = collegeRow?.overall_seed != null ? safeNum(collegeRow.overall_seed) : null;
    const overallSeed =
      overallRaw != null && Number.isFinite(overallRaw) && overallRaw >= 1 && overallRaw <= 68
        ? Math.trunc(overallRaw)
        : null;
    const region = regionLabelForTeamRow(collegeRow);

    const headshotUrls = resolvePlayerHeadshotUrlCandidates({
      headshot_url: pRow?.headshot_url != null ? String(pRow.headshot_url) : null,
      espn_athlete_id: pRow?.espn_athlete_id as number | string | null | undefined
    });

    const teamLogoUrl = collegeRow ? resolveLogoForTeamRow(collegeRow) : null;

    const tidForProj = rosterTeamId > 0 ? rosterTeamId : playerTeamId;
    let originalProjection: number | null = null;
    let liveProjectionInt = slotProj.get(slotId) ?? 0;
    if (bundle && tidForProj > 0) {
      const tproj = playerTournamentProjections({
        teamId: tidForProj,
        playerId,
        seasonPpg: pRow?.season_ppg,
        bundle
      });
      originalProjection = Math.round(tproj.originalProjection);
      const fromSlot = slotProj.get(slotId);
      liveProjectionInt =
        fromSlot != null && Number.isFinite(Number(fromSlot))
          ? Math.round(Number(fromSlot))
          : Math.round(tproj.liveProjection);
    } else {
      liveProjectionInt = Math.round(liveProjectionInt);
    }

    const playingInLiveGame =
      (playerTeamId > 0 && liveTeamIds.has(playerTeamId)) ||
      (rosterTeamId > 0 && liveTeamIds.has(rosterTeamId));

    const playerCanonKey = stablePoolSlugForTeamContext(
      effectiveTeamId,
      engine.canonicalByInternalTeamId,
      engine.canonRowById
    );
    const advancedPastActiveRound = playerAdvancedPastLeagueActiveRound({
      currentRound: engine.currentRound,
      eliminated: c?.eliminated ?? false,
      eliminatedRound: c?.eliminatedRound ?? null,
      playerCanonKey,
      finalWinBucketsByCanon: engine.finalWinDisplayBucketsByCanonical
    });

    const row: StatTrackerPlayerRow = {
      rosterSlotId: slotId,
      playerId,
      espnAthleteId: safeEspnAthleteId(pRow?.espn_athlete_id),
      playerName,
      position: pRow?.position != null && String(pRow.position).trim() !== "" ? String(pRow.position).trim() : null,
      teamName,
      headshotUrls,
      teamLogoUrl,
      roundScores,
      seed,
      overallSeed,
      region,
      seasonPpg: seasonPpgDisplay(pRow?.season_ppg),
      total,
      projection: liveProjectionInt,
      originalProjection,
      eliminated: c?.eliminated ?? false,
      eliminatedRound: c?.eliminatedRound ?? null,
      advancedPastActiveRound,
      playingInLiveGame
    };

    const arr = rowsByLt.get(ltId) ?? [];
    arr.push(row);
    rowsByLt.set(ltId, arr);
  }

  type DraftPickRow = { player_id: number; league_team_id: string; pick_overall: number };

  let draftPicks: DraftPickRow[] = [];
  const draftRoomId = (draftRoomRes.data as { id?: string } | null)?.id;
  if (draftRoomId) {
    const { data: picks } = await supabase
      .from("player_draft_picks")
      .select("player_id, league_team_id, pick_overall")
      .eq("draft_room_id", draftRoomId)
      .order("pick_overall", { ascending: true });
    draftPicks = (picks ?? []) as DraftPickRow[];
  }

  const picksByLt = new Map<string, DraftPickRow[]>();
  for (const p of draftPicks) {
    const lid = String(p.league_team_id);
    const arr = picksByLt.get(lid) ?? [];
    arr.push(p);
    picksByLt.set(lid, arr);
  }

  function orderTrackerPlayersForTeam(
    ltId: string,
    players: StatTrackerPlayerRow[],
    eng: LeagueScoringEngineState
  ): StatTrackerPlayerRow[] {
    const byPid = new Map(players.map((r) => [r.playerId, r]));
    const teamPicks = picksByLt.get(ltId) ?? [];
    const ordered: StatTrackerPlayerRow[] = [];
    const seen = new Set<number>();
    if (teamPicks.length > 0) {
      for (const p of teamPicks) {
        const r = byPid.get(safeNum(p.player_id));
        if (r) {
          ordered.push(r);
          seen.add(r.playerId);
        }
      }
    }
    for (const r of players) {
      if (!seen.has(r.playerId)) ordered.push(r);
    }
    if (teamPicks.length === 0 && ordered.length > 0) {
      const slots = eng.slotsByLeagueTeam.get(ltId) ?? [];
      return [...ordered].sort((a, b) => {
        const sa = slots.find((s) => safeNum(s.player_id) === a.playerId);
        const sb = slots.find((s) => safeNum(s.player_id) === b.playerId);
        return safeNum(sa?.pick_overall) - safeNum(sb?.pick_overall);
      });
    }
    return ordered;
  }

  const sortedTeams = [...engine.leagueTeamRows].sort((a, b) => {
    const da = a.draft_position ?? 999;
    const db = b.draft_position ?? 999;
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });

  const owners: StatTrackerOwnerRow[] = sortedTeams.map((lt) => {
    const profile = engine.profileById.get(lt.user_id);
    const ownerName = resolveLeagueOwnerDisplayName({
      teamName: lt.team_name,
      profileDisplayName: profile?.display_name
    });
    const raw = rowsByLt.get(lt.id) ?? [];
    const players = orderTrackerPlayersForTeam(lt.id, raw, engine);
    return {
      leagueTeamId: lt.id,
      ownerName,
      draftPosition: lt.draft_position ?? 999,
      players
    };
  });

  return {
    leagueId,
    seasonYear,
    currentRound: engine.currentRound,
    lastSyncedAt: mergedLastSyncedAt,
    partialDataWarning: engine.partialDataWarning,
    anyLiveGames: engine.anyLiveGames,
    liveGamesCount: engine.liveGamesCount,
    owners
  };
}
