import type { SupabaseClient } from "@supabase/supabase-js";
import {
  externalTeamIdToSeo,
  getEspnMbbTeamIndex,
  normalizePlayerNameForMatch,
  resolveEspnTeamLogoFromIndex
} from "@/lib/espn-mbb-directory";
import { resolveEspnTeamLogoForPoolRow } from "@/lib/espn-ncaam-assets";
import {
  fetchHenrygdBracketGames,
  upsertTournamentTeamsFromBracketGames
} from "@/lib/henrygd-bracket-seeds";

type PlayerRosterRow = {
  id: number;
  name: string;
  team_id: number;
  henrygd_boxscore_player_id: string | null;
};

/** Prefer existing pool row on `team_id` + name; set `henrygd_boxscore_player_id` to attach stats. */
function resolveCanonicalPlayerForBoxscore(opts: {
  roster: PlayerRosterRow[];
  henrygdBoxscorePlayerId: string;
  displayName: string;
}): { id: number; needsHenrygdLink: boolean } | null {
  const hg = opts.henrygdBoxscorePlayerId.trim();
  if (!hg) return null;
  for (const r of opts.roster) {
    const cur = r.henrygd_boxscore_player_id?.trim() ?? "";
    if (cur === hg) return { id: r.id, needsHenrygdLink: false };
  }
  const nk = normalizePlayerNameForMatch(opts.displayName);
  if (!nk) return null;
  for (const r of opts.roster) {
    if (normalizePlayerNameForMatch(r.name) !== nk) continue;
    const cur = r.henrygd_boxscore_player_id?.trim() ?? "";
    return { id: r.id, needsHenrygdLink: cur !== hg };
  }
  return null;
}

/**
 * Assign `henrygd_boxscore_player_id` to the canonical pool row. Clears the same id from any other
 * row on the team (legacy henrygd-only duplicates), merging `player_game_stats` onto the canonical id.
 */
export async function claimHenrygdBoxscorePlayerForCanonicalRow(opts: {
  supabase: SupabaseClient;
  teamInternalId: number;
  seasonYear: number;
  henrygdBoxscorePlayerId: string;
  canonicalPlayerId: number;
}): Promise<void> {
  const { supabase, teamInternalId, seasonYear, henrygdBoxscorePlayerId, canonicalPlayerId } = opts;
  const hg = henrygdBoxscorePlayerId.trim();
  if (!hg || canonicalPlayerId <= 0) return;

  const { data: holders } = await supabase
    .from("players")
    .select("id")
    .eq("team_id", teamInternalId)
    .eq("season_year", seasonYear)
    .eq("henrygd_boxscore_player_id", hg);

  for (const h of holders ?? []) {
    const oid = safeNum(h.id);
    if (oid == null || oid <= 0 || oid === canonicalPlayerId) continue;

    const { data: fromStats } = await supabase
      .from("player_game_stats")
      .select("game_id, points")
      .eq("player_id", oid);
    for (const st of fromStats ?? []) {
      const gid = safeNum(st.game_id);
      if (gid == null || gid <= 0) continue;
      const pts = safeNum(st.points) ?? 0;
      const { data: existing } = await supabase
        .from("player_game_stats")
        .select("points")
        .eq("player_id", canonicalPlayerId)
        .eq("game_id", gid)
        .maybeSingle();
      const prev = existing?.points != null ? safeNum(existing.points) ?? 0 : 0;
      const merged = Math.max(pts, prev);
      await supabase.from("player_game_stats").upsert(
        { game_id: gid, player_id: canonicalPlayerId, points: merged },
        { onConflict: "game_id,player_id" }
      );
    }

    await supabase.from("player_game_stats").delete().eq("player_id", oid);

    const { data: orphanSlots } = await supabase
      .from("player_roster_slots")
      .select("id, league_team_id")
      .eq("player_id", oid);
    for (const slot of orphanSlots ?? []) {
      const lt = slot.league_team_id as string;
      const { data: canonSlot } = await supabase
        .from("player_roster_slots")
        .select("id")
        .eq("league_team_id", lt)
        .eq("player_id", canonicalPlayerId)
        .maybeSingle();
      if (canonSlot?.id) {
        await supabase.from("player_roster_slots").delete().eq("id", slot.id as string);
      } else {
        await supabase
          .from("player_roster_slots")
          .update({
            player_id: canonicalPlayerId,
            updated_at: new Date().toISOString()
          })
          .eq("id", slot.id as string);
      }
    }

    await supabase
      .from("players")
      .update({
        henrygd_boxscore_player_id: null,
        updated_at: new Date().toISOString()
      })
      .eq("id", oid);
  }

  await supabase
    .from("players")
    .update({
      henrygd_boxscore_player_id: hg,
      updated_at: new Date().toISOString()
    })
    .eq("id", canonicalPlayerId);
}

function safeNum(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

function parseIntOrNull(x: unknown) {
  const n = safeNum(x);
  return n === null ? null : Math.trunc(n);
}

function parseHeightInches(height: unknown): number | null {
  if (height == null) return null;
  if (typeof height === "number") return safeNum(height);
  const s = String(height).trim();
  if (!s) return null;

  // Common patterns: "6-7" or "6'7\"" or "78in".
  const ftInMatch = s.match(/^\s*(\d+)\s*[-']\s*(\d+)\s*(in|")?\s*$/i);
  if (ftInMatch) {
    const ft = safeNum(ftInMatch[1]);
    const inch = safeNum(ftInMatch[2]);
    if (ft == null || inch == null) return null;
    return ft * 12 + inch;
  }

  const inchesMatch = s.match(/(\d+(?:\.\d+)?)\s*(in|inch|inches)\s*$/i);
  if (inchesMatch) {
    const inch = safeNum(inchesMatch[1]);
    if (inch == null) return null;
    return Math.round(inch);
  }

  return null;
}

function isPower5ConferenceSeo(conferenceSeo: string | null | undefined) {
  if (!conferenceSeo) return false;
  const s = conferenceSeo.toLowerCase();
  // Conservative set; extend later.
  return ["acc", "big-ten", "big12", "big-12", "sec", "pac-12", "pac-10"].some((k) =>
    s.includes(k.replace("-", "-"))
  ) || s.includes("big-12") || s.includes("big12") || s.includes("pac-12");
}

function seoBase(slug: string): string {
  const s = slug.trim().toLowerCase();
  if (!s) return s;
  const parts = s.split("-").filter(Boolean);
  if (parts.length <= 1) return s;
  return parts.slice(0, -1).join("-");
}

function resolveTeamInternalIdFromSeo(
  seoname: string,
  seasonYear: number,
  teamIdByExternal: ReadonlyMap<string, number>,
  teamIdBySeo: ReadonlyMap<string, number>
): number | null {
  const seo = seoname.trim().toLowerCase();
  if (!seo) return null;
  const direct = teamIdByExternal.get(`${seo}-${seasonYear}`);
  if (direct != null && direct > 0) return direct;
  const bySeo = teamIdBySeo.get(seo);
  if (bySeo != null && bySeo > 0) return bySeo;
  const byBase = teamIdBySeo.get(seoBase(seo));
  if (byBase != null && byBase > 0) return byBase;
  return null;
}

export type HenrygdSyncResult = {
  teamsUpserted: number;
  gamesUpserted: number;
  teamGameStatsUpserted: number;
  playersUpserted: number;
  playerGameStatsUpserted: number;
  /** Increment when changing bracket/game filtering logic, to confirm deployed backend version. */
  henrygdSyncLogicVersion: number;
  /** Optional debug when using the Henrygd bracket endpoint as a source of truth for `games` round bucketing. */
  bracketDebug?: {
    bracketAllCount: number;
    bracketPlayedCount: number;
    bracketExternalTeamIdsCount: number;
    bracketGamesUpserted: number;
    bracketTeamsUpserted: number;
  };
  /** Set when bracket sync was attempted but failed; legacy scoreboard sync may still run. */
  bracketError?: string | null;
};

/**
 * Syncs bracket games/scores from the **daily scoreboard** feed (games playing on `date`).
 * Updates regional `seed` (1–16 pod) from that feed; it does **not** set committee `overall_seed` (1–68).
 * For 1–68 and the full published field, use `applyHenrygdBracketOfficialSeeds` / commissioner official-seeds
 * (`lib/henrygd-bracket-seeds.ts`, `lib/official-seeds.ts`).
 */
export async function syncHenrygdMensD1ScoreboardToSupabase(opts: {
  supabase: SupabaseClient;
  seasonYear: number;
  date: Date;
  syncPlayerBoxscores?: boolean;
  /**
   * When true (default), skip henrygd `roundNumber === 1` (First Four / play-ins). Those games are not
   * part of the NCAA First Round and must not affect fantasy scoring.
   */
  excludeFirstFour?: boolean;
}): Promise<HenrygdSyncResult> {
  const { supabase, seasonYear, date, syncPlayerBoxscores = true } = opts;
  const excludeFirstFour = opts.excludeFirstFour !== false;
  let bracketError: string | null = null;
  let bracketDebug: NonNullable<HenrygdSyncResult["bracketDebug"]> = {
    bracketAllCount: 0,
    bracketPlayedCount: 0,
    bracketExternalTeamIdsCount: 0,
    bracketGamesUpserted: 0,
    bracketTeamsUpserted: 0
  };
  const henrygdSyncLogicVersion = 2;

  // Henrygd’s daily scoreboard endpoint does not reliably include bracket metadata
  // (e.g. `championshipGame.round.roundNumber`). When that happens, our previous
  // filter results in zero bracket games → zero `public.games` rows for R1–R6.
  //
  // The bracket endpoint is the correct source of truth for:
  // - `contestId` (used by `/game/{id}/boxscore`)
  // - `startTimeEpoch`
  // - team `seoname`
  // - and gameState (final/live).
  try {
    const bracketAll = await fetchHenrygdBracketGames(seasonYear);
    const dateMs = date.getTime();
    const bracketPlayed = (bracketAll as any[]).filter((g) => {
      const epochSec = safeNum(g?.startTimeEpoch);
      if (epochSec == null) return false;
      const startMs = epochSec * 1000;
      const stateRaw = String(g?.gameState ?? "");
      const state = stateRaw.trim().toUpperCase();
      // Henrygd uses inconsistent gameState labels depending on endpoint/version.
      return state === "F" || state === "L" || state === "FINAL" || state === "LIVE";
    });

    // Default bracket debug values are already set; if we have no played games, keep zeros but still
    // report how many were fetched from the endpoint.
    if (bracketPlayed.length === 0) {
      bracketDebug.bracketAllCount = Array.isArray(bracketAll) ? bracketAll.length : 0;
    }

    if (bracketPlayed.length > 0) {
      // Ensure teams exist for all seonames that appear in the played games.
      const teamsUpserted = await upsertTournamentTeamsFromBracketGames(
        supabase,
        seasonYear,
        bracketPlayed as any
      );

      const externalTeamIds = new Set<string>();
      for (const g of bracketPlayed) {
        const teams = (g?.teams ?? []) as any[];
        const home = teams.find((t) => t?.isHome === true);
        const away = teams.find((t) => t?.isHome === false);
        const homeSeo = home?.seoname;
        const awaySeo = away?.seoname;
        if (typeof homeSeo === "string" && homeSeo.trim()) externalTeamIds.add(`${homeSeo}-${seasonYear}`);
        if (typeof awaySeo === "string" && awaySeo.trim()) externalTeamIds.add(`${awaySeo}-${seasonYear}`);
      }

      const { data: teamRows } = externalTeamIds.size
        ? await supabase
            .from("teams")
            .select("id, external_team_id")
            .in("external_team_id", Array.from(externalTeamIds))
        : { data: [] as any[] };

      const teamIdByExternal = new Map<string, number>(
        (teamRows ?? []).map((t: any) => [String(t.external_team_id ?? ""), safeNum(t.id) ?? 0])
      );

      const nowIso = new Date().toISOString();
      const gameUpserts: any[] = [];

      for (const g of bracketPlayed) {
        const bracketPositionId = safeNum(g?.bracketPositionId);
        if (bracketPositionId == null || bracketPositionId <= 0) continue;

        // bracketPositionId: 101 first four, 201 round of 64, ..., 701 championship
        const mappedRound = Math.floor(bracketPositionId / 100) - 1; // -> 0..6
        if (excludeFirstFour && mappedRound === 0) continue;
        if (mappedRound < 0 || mappedRound > 6) continue;

        const contestId = g?.contestId != null ? String(g.contestId) : String(g?.url ?? "").split("/").pop();
        if (!contestId) continue;

        const epochSec = safeNum(g?.startTimeEpoch);
        if (epochSec == null) continue;
        const startTime = new Date(epochSec * 1000).toISOString();

        const teams = (g?.teams ?? []) as any[];
        const home = teams.find((t) => t?.isHome === true) ?? null;
        const away = teams.find((t) => t?.isHome === false) ?? null;
        if (!home || !away) continue;

        const homeSeo = typeof home.seoname === "string" ? home.seoname : null;
        const awaySeo = typeof away.seoname === "string" ? away.seoname : null;
        if (!homeSeo || !awaySeo) continue;

        const homeExternal = `${homeSeo}-${seasonYear}`;
        const awayExternal = `${awaySeo}-${seasonYear}`;
        const teamB = teamIdByExternal.get(homeExternal);
        const teamA = teamIdByExternal.get(awayExternal);
        if (!teamA || !teamB) continue;

        const homeScore = safeNum(home?.score) ?? 0;
        const awayScore = safeNum(away?.score) ?? 0;

        const stateRaw = String(g?.gameState ?? "");
        const state = stateRaw.trim().toUpperCase();
        const status = state === "L" || state === "LIVE" ? "live" : "final";

        gameUpserts.push({
          external_game_id: contestId,
          round: mappedRound,
          start_time: startTime,
          team_a_id: teamA,
          team_b_id: teamB,
          team_a_score: awayScore,
          team_b_score: homeScore,
          status,
          last_synced_at: nowIso
        });
      }

      if (gameUpserts.length > 0) {
        await supabase.from("games").upsert(gameUpserts, { onConflict: "external_game_id" });
        const { data: upsertedGames } = await supabase
          .from("games")
          .select("id, external_game_id")
          .in("external_game_id", gameUpserts.map((u) => u.external_game_id));

        const gameIdByExternal = new Map<string, number>(
          (upsertedGames ?? []).map((row: any) => [String(row.external_game_id ?? ""), safeNum(row.id) ?? 0])
        );

        const teamStatsUpserts: any[] = [];
        for (const u of gameUpserts) {
          const gid = gameIdByExternal.get(String(u.external_game_id ?? ""));
          if (!gid) continue;
          if (safeNum(u.team_a_id) && safeNum(u.team_a_id) > 0) {
            teamStatsUpserts.push({ game_id: gid, team_id: u.team_a_id, points: u.team_a_score ?? 0 });
          }
          if (safeNum(u.team_b_id) && safeNum(u.team_b_id) > 0) {
            teamStatsUpserts.push({ game_id: gid, team_id: u.team_b_id, points: u.team_b_score ?? 0 });
          }
        }
        if (teamStatsUpserts.length > 0) {
          await supabase
            .from("team_game_stats")
            .upsert(teamStatsUpserts, { onConflict: "game_id,team_id" });
        }
      }

      // Player box scores are intentionally handled by the explicit “Fill player box scores” step.
      // (Per-day boxscore syncing is extremely rate-limited and expensive.)
      bracketDebug = {
        bracketAllCount: Array.isArray(bracketAll) ? bracketAll.length : 0,
        bracketPlayedCount: bracketPlayed.length,
        bracketExternalTeamIdsCount: externalTeamIds.size,
        bracketGamesUpserted: gameUpserts.length,
        bracketTeamsUpserted: teamsUpserted
      };
      return {
        teamsUpserted: teamsUpserted,
        gamesUpserted: gameUpserts.length,
        teamGameStatsUpserted: 0,
        playersUpserted: 0,
        playerGameStatsUpserted: 0,
        bracketDebug,
        bracketError,
        henrygdSyncLogicVersion
      };
    }
  } catch (e) {
    // Important: don't silently swallow bracket failures; they cause 0-team/0-game sync.
    bracketError = e instanceof Error ? e.message : String(e);
    console.error("[henrygd] bracket sync failed", bracketError);
  }

  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();

  // henrygd uses month/day without zero-padding in path examples.
  const scoreboardUrl = `https://ncaa-api.henrygd.me/scoreboard/basketball-men/d1/${y}/${m}/${d}/all-conf`;

  const resp = await fetch(scoreboardUrl);
  if (!resp.ok) {
    throw new Error(`henrygd scoreboard failed: ${resp.status}`);
  }

  const json = await resp.json();
  const games = (json?.games ?? []) as any[];

  // We only want tournament-bracket games.
  // Henrygd is inconsistent: some responses omit `championshipGame.round.roundNumber` but still
  // provide `bracketRound`, so use whichever is available to decide eligibility + mapping.
  const bracketGames = games
    .map((entry) => entry?.game)
    .filter((g) => {
      if (!g?.gameID) return false;
      const roundNumberRaw = g?.championshipGame?.round?.roundNumber;
      const hasRoundNumber = roundNumberRaw != null && String(roundNumberRaw).trim() !== "";
      const bracketRoundRaw = g?.bracketRound;
      const hasBracketRound =
        bracketRoundRaw != null &&
        !(typeof bracketRoundRaw === "string" && bracketRoundRaw.trim() === "");
      return hasRoundNumber || hasBracketRound;
    });

  let espnTeamIndex: Awaited<ReturnType<typeof getEspnMbbTeamIndex>> | null = null;
  try {
    espnTeamIndex = await getEspnMbbTeamIndex();
  } catch {
    espnTeamIndex = null;
  }

  // Upsert teams and map external identifiers -> internal ids.
  // We use external_team_id = `${seo}-${seasonYear}` to avoid collisions across seasons.
  type TeamKey = string; // external_team_id
  const teamIdByExternal = new Map<TeamKey, number>();
  const teamIdBySeo = new Map<string, number>();

  // Helper: ensure team upsert and return internal id.
  const upsertTeams = async (teamPayloads: any[]) => {
    if (teamPayloads.length === 0) return 0;

    const upserts = teamPayloads.map((t) => ({
      external_team_id: t.external_team_id,
      name: t.name,
      short_name: t.short_name,
      seed: t.seed,
      region: t.region,
      conference: t.conference,
      is_power5: t.is_power5,
      logo_url:
        espnTeamIndex != null
          ? resolveEspnTeamLogoFromIndex(espnTeamIndex, {
              logoUrl: null,
              shortName: t.short_name != null ? String(t.short_name) : null,
              fullName: t.name != null ? String(t.name) : null,
              seo: typeof t.seo === "string" ? t.seo : null
            }) ??
            resolveEspnTeamLogoForPoolRow({
              logoUrl: null,
              shortName: t.short_name != null ? String(t.short_name) : null,
              fullName: t.name != null ? String(t.name) : null
            })
          : resolveEspnTeamLogoForPoolRow({
              logoUrl: null,
              shortName: t.short_name != null ? String(t.short_name) : null,
              fullName: t.name != null ? String(t.name) : null
            })
    }));

    // Upsert by external_team_id
    await supabase.from("teams").upsert(upserts, {
      onConflict: "external_team_id"
    });

    // Re-fetch internal ids for mapping.
    const { data: createdTeams } = await supabase
      .from("teams")
      .select("id, external_team_id")
      .in("external_team_id", upserts.map((u) => u.external_team_id));

    for (const row of createdTeams ?? []) {
      teamIdByExternal.set(row.external_team_id, row.id);
      const seo = externalTeamIdToSeo(String(row.external_team_id ?? ""), seasonYear);
      if (seo) {
        if (!teamIdBySeo.has(seo)) teamIdBySeo.set(seo, row.id);
        const base = seoBase(seo);
        if (base && !teamIdBySeo.has(base)) teamIdBySeo.set(base, row.id);
      }
    }

    return upserts.length;
  };

  // Collect unique team external ids.
  const teamPayloads: any[] = [];
  for (const g of bracketGames) {
    const away = g?.away;
    const home = g?.home;
    const awaySeo = away?.names?.seo;
    const homeSeo = home?.names?.seo;

    if (awaySeo) {
      teamPayloads.push({
        external_team_id: `${awaySeo}-${seasonYear}`,
        name: away?.names?.full ?? away?.names?.short,
        short_name: away?.names?.short,
        seed: parseIntOrNull(away?.seed),
        region: null,
        conference: away?.conferences?.[0]?.conferenceSeo ?? null,
        is_power5: isPower5ConferenceSeo(away?.conferences?.[0]?.conferenceSeo),
        seo: awaySeo
      });
    }
    if (homeSeo) {
      teamPayloads.push({
        external_team_id: `${homeSeo}-${seasonYear}`,
        name: home?.names?.full ?? home?.names?.short,
        short_name: home?.names?.short,
        seed: parseIntOrNull(home?.seed),
        region: null,
        conference: home?.conferences?.[0]?.conferenceSeo ?? null,
        is_power5: isPower5ConferenceSeo(home?.conferences?.[0]?.conferenceSeo),
        seo: homeSeo
      });
    }
  }

  // Preload internal team ids (after upsert).
  await upsertTeams(teamPayloads);

  // Upsert games
  const nowIso = new Date().toISOString();
  const gameUpserts: any[] = [];
  const teamGameStatUpserts: any[] = [];
  const boxscoreGameUpserts: any[] = [];

  for (const g of bracketGames) {
    const gameId = g?.gameID;
    const roundNumber = parseIntOrNull(g?.championshipGame?.round?.roundNumber);
    // Map henrygd `bracketRound` to our `games.round` buckets (0..6 where 0 is First Four).
    //
    // The feed sometimes provides `bracketRound` already bucketed (0..6),
    // but in other henrygd endpoints it can be a "position id" style number (e.g. 100..600),
    // so we normalize by /100 when needed.
    const bracketRoundInput = g?.bracketRound;
    const bracketRoundRaw =
      typeof bracketRoundInput === "string" && bracketRoundInput.trim() === ""
        ? null
        : safeNum(bracketRoundInput);
    let mappedRound: number | null = null;
    if (bracketRoundRaw != null) {
      if (bracketRoundRaw >= 0 && bracketRoundRaw <= 6) {
        mappedRound = bracketRoundRaw;
      } else {
        const bucket = Math.floor(bracketRoundRaw / 100);
        if (bucket >= 0 && bucket <= 6) mappedRound = bucket;
        // Some feeds use a 100/200/.. style position id where 100..700 maps to 0..6.
        else if (bucket - 1 >= 0 && bucket - 1 <= 6) mappedRound = bucket - 1;
      }
    }

    if (mappedRound == null) {
      // Fallback: Map henrygd roundNumber to our `games.round`:
      // - roundNumber 1 => First Four => store as 0
      // - roundNumber 2 => Round of 64 => store as 1 (R1)
      // - Some henrygd shapes can send position ids (e.g. 100..600); bucket those.
      if (roundNumber != null) {
        if (roundNumber >= 100) {
          mappedRound = Math.floor(roundNumber / 100);
        } else {
          mappedRound = roundNumber === 1 ? 0 : roundNumber - 1;
        }
      }
    }

    if (mappedRound == null) continue;
    if (excludeFirstFour && mappedRound === 0) continue;
    if (mappedRound < 0 || mappedRound > 6) continue;

    const awaySeo = g?.away?.names?.seo;
    const homeSeo = g?.home?.names?.seo;
    const awayTeamInternal =
      awaySeo ? resolveTeamInternalIdFromSeo(awaySeo, seasonYear, teamIdByExternal, teamIdBySeo) : undefined;
    const homeTeamInternal =
      homeSeo ? resolveTeamInternalIdFromSeo(homeSeo, seasonYear, teamIdByExternal, teamIdBySeo) : undefined;
    if (!awayTeamInternal || !homeTeamInternal) continue;

    const statusRaw = String(g?.gameState ?? "");
    const status = statusRaw === "live" ? "live" : statusRaw === "final" ? "final" : "scheduled";

    const startTimeEpoch = safeNum(g?.startTimeEpoch);
    const startTime = startTimeEpoch ? new Date(startTimeEpoch * 1000).toISOString() : nowIso;

    const awayScore = parseIntOrNull(g?.away?.score);
    const homeScore = parseIntOrNull(g?.home?.score);

    const awayPts = awayScore ?? 0;
    const homePts = homeScore ?? 0;

    const externalGameId = `${gameId}`;
    gameUpserts.push({
      external_game_id: externalGameId,
      round: mappedRound,
      start_time: startTime,
      team_a_id: awayTeamInternal,
      team_b_id: homeTeamInternal,
      team_a_score: awayPts,
      team_b_score: homePts,
      status,
      last_synced_at: nowIso
    });

    if (syncPlayerBoxscores) {
      boxscoreGameUpserts.push({ external_game_id: externalGameId, status });
    }

    // Only upsert team_game_stats when we have numeric scores; otherwise keep 0.
    teamGameStatUpserts.push({
      game_id: undefined, // filled after game upsert
      team_id: awayTeamInternal,
      points: awayPts
    });
    teamGameStatUpserts.push({
      game_id: undefined,
      team_id: homeTeamInternal,
      points: homePts
    });
  }

  let gamesUpserted = 0;
  if (gameUpserts.length > 0) {
    await supabase.from("games").upsert(gameUpserts, {
      onConflict: "external_game_id"
    });
    gamesUpserted = gameUpserts.length;

    // Map game internal ids by external_game_id
    const { data: upsertedGames } = await supabase
      .from("games")
      .select("id, external_game_id")
      .in("external_game_id", gameUpserts.map((u) => u.external_game_id));

    const gameByExternal = new Map<string, number>(
      (upsertedGames ?? []).map((row: any) => [row.external_game_id, row.id])
    );

    // Build team_game_stats upserts now that game ids are known
    const statsUpsertsFinal: any[] = [];
    for (const u of gameUpserts) {
      const gInternalId = gameByExternal.get(String(u.external_game_id));
      if (!gInternalId) continue;
      statsUpsertsFinal.push({
        game_id: gInternalId,
        team_id: u.team_a_id,
        points: u.team_a_score ?? 0
      });
      statsUpsertsFinal.push({
        game_id: gInternalId,
        team_id: u.team_b_id,
        points: u.team_b_score ?? 0
      });
    }

    if (statsUpsertsFinal.length > 0) {
      await supabase.from("team_game_stats").upsert(statsUpsertsFinal, {
        onConflict: "game_id,team_id"
      });
    }

    let playersUpserted = 0;
    let playerGameStatsUpserted = 0;

    if (syncPlayerBoxscores && boxscoreGameUpserts.length > 0) {
      // Fetch box scores per game and upsert:
      // - `players` (names/positions) if missing
      // - `player_game_stats` (points)
      for (const gU of boxscoreGameUpserts) {
        const gInternalId = gameByExternal.get(String(gU.external_game_id));
        if (!gInternalId) continue;

        const boxUrl = `https://ncaa-api.henrygd.me/game/${encodeURIComponent(
          String(gU.external_game_id)
        )}/boxscore`;

        // Keep boxscore sync robust: skip failures instead of breaking the entire sync.
        try {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 20_000);
          const resp = await fetch(boxUrl, {
            signal: ac.signal,
            headers: { Accept: "application/json", "User-Agent": "player-pool/boxscore-sync" }
          });
          clearTimeout(t);
          if (!resp.ok) continue;

          const box = await resp.json();
          const teamsArr = (box?.teams ?? []) as any[];
          const teamIdToSeoname = new Map<number, string>(
            teamsArr.map((x) => [safeNum(x.teamId) ?? 0, String(x.seoname ?? "")])
          );

          const teamBox = (box?.teamBoxscore ?? []) as any[];
          const teamInternalIds = new Set<number>();
          for (const tb of teamBox) {
            const teamIdNum = safeNum(tb.teamId);
            const seoname = teamIdToSeoname.get(teamIdNum ?? 0) ?? "";
            if (!seoname) continue;
            const tid = resolveTeamInternalIdFromSeo(seoname, seasonYear, teamIdByExternal, teamIdBySeo);
            if (tid != null && tid > 0) teamInternalIds.add(tid);
          }

          const rosterByTeam = new Map<number, PlayerRosterRow[]>();
          if (teamInternalIds.size > 0) {
            const { data: rosterRows } = await supabase
              .from("players")
              .select("id, name, team_id, henrygd_boxscore_player_id")
              .eq("season_year", seasonYear)
              .in("team_id", [...teamInternalIds]);
            for (const raw of rosterRows ?? []) {
              const tid = safeNum(raw.team_id);
              const pid = safeNum(raw.id);
              if (tid == null || tid <= 0 || pid == null || pid <= 0) continue;
              const row: PlayerRosterRow = {
                id: pid,
                name: String(raw.name ?? ""),
                team_id: tid,
                henrygd_boxscore_player_id:
                  raw.henrygd_boxscore_player_id != null ? String(raw.henrygd_boxscore_player_id) : null
              };
              const arr = rosterByTeam.get(tid) ?? [];
              arr.push(row);
              rosterByTeam.set(tid, arr);
            }
          }

          const statsUpserts: any[] = [];

          for (const tb of teamBox) {
            const teamIdNum = safeNum(tb.teamId);
            const seoname = teamIdToSeoname.get(teamIdNum ?? 0) ?? "";
            if (!seoname) continue;

            const teamInternalId = resolveTeamInternalIdFromSeo(
              seoname,
              seasonYear,
              teamIdByExternal,
              teamIdBySeo
            );
            if (teamInternalId == null || teamInternalId <= 0) continue;

            const roster = rosterByTeam.get(teamInternalId) ?? [];
            const playerStats = (tb?.playerStats ?? []) as any[];

            for (const ps of playerStats) {
              const hgId = String(ps?.id ?? "").trim();
              if (!hgId) continue;

              const external_player_id = `${seasonYear}:${seoname}:${ps?.id}`;
              const first = String(ps?.firstName ?? "").trim();
              const last = String(ps?.lastName ?? "").trim();
              const name = [first, last].filter(Boolean).join(" ").trim() || `Player ${ps?.id}`;
              const points = ps?.points != null ? safeNum(ps.points) ?? 0 : 0;
              const jersey_number = parseIntOrNull(ps?.number);
              const height = (ps as any)?.height ?? (ps as any)?.heightFull ?? null;
              const height_inches = parseHeightInches(height);

              const resolved = resolveCanonicalPlayerForBoxscore({
                roster,
                henrygdBoxscorePlayerId: hgId,
                displayName: name
              });

              let internalPlayerId: number | null = null;

              if (resolved) {
                internalPlayerId = resolved.id;
                if (resolved.needsHenrygdLink) {
                  await claimHenrygdBoxscorePlayerForCanonicalRow({
                    supabase,
                    teamInternalId,
                    seasonYear,
                    henrygdBoxscorePlayerId: hgId,
                    canonicalPlayerId: resolved.id
                  });
                  const hit = roster.find((r) => r.id === resolved.id);
                  if (hit) hit.henrygd_boxscore_player_id = hgId;
                  playersUpserted += 1;
                }
              } else {
                const insertPayload: Record<string, unknown> = {
                  external_player_id,
                  team_id: teamInternalId,
                  name,
                  short_name: String(jersey_number ?? last ?? "").trim() || null,
                  position: ps?.position ?? null,
                  jersey_number,
                  height: height != null ? String(height) : null,
                  height_inches,
                  season_year: seasonYear,
                  season_ppg: null,
                  season_ppg_source: null,
                  henrygd_boxscore_player_id: hgId
                };
                const { data: inserted, error: insErr } = await supabase
                  .from("players")
                  .insert(insertPayload)
                  .select("id")
                  .maybeSingle();

                const newPid = inserted?.id != null ? safeNum(inserted.id) : null;
                if (!insErr && newPid != null && newPid > 0) {
                  internalPlayerId = newPid;
                  roster.push({
                    id: newPid,
                    name,
                    team_id: teamInternalId,
                    henrygd_boxscore_player_id: hgId
                  });
                  rosterByTeam.set(teamInternalId, roster);
                  playersUpserted += 1;
                } else {
                  // Insert often conflicts on (team_id, name, season_year) when ESPN used a different string
                  // than the box score ("C.J." vs "CJ", suffixes, etc.). Match the same way as resolveCanonical.
                  const nkBox = normalizePlayerNameForMatch(name);
                  let clashId: number | null = null;
                  if (nkBox) {
                    const { data: teamPlayers } = await supabase
                      .from("players")
                      .select("id, name")
                      .eq("team_id", teamInternalId)
                      .eq("season_year", seasonYear);
                    for (const row of teamPlayers ?? []) {
                      if (normalizePlayerNameForMatch(String(row.name ?? "")) !== nkBox) continue;
                      const cid = safeNum(row.id);
                      if (cid != null && cid > 0) {
                        clashId = cid;
                        break;
                      }
                    }
                  }
                  if (clashId != null && clashId > 0) {
                    internalPlayerId = clashId;
                    await claimHenrygdBoxscorePlayerForCanonicalRow({
                      supabase,
                      teamInternalId,
                      seasonYear,
                      henrygdBoxscorePlayerId: hgId,
                      canonicalPlayerId: clashId
                    });
                    if (!roster.some((r) => r.id === clashId)) {
                      roster.push({
                        id: clashId,
                        name,
                        team_id: teamInternalId,
                        henrygd_boxscore_player_id: hgId
                      });
                    } else {
                      const r = roster.find((x) => x.id === clashId);
                      if (r) r.henrygd_boxscore_player_id = hgId;
                    }
                    rosterByTeam.set(teamInternalId, roster);
                    playersUpserted += 1;
                  }
                }
              }

              if (internalPlayerId != null && internalPlayerId > 0) {
                statsUpserts.push({
                  game_id: gInternalId,
                  player_id: internalPlayerId,
                  points: points ?? 0
                });
              }
            }
          }

          if (statsUpserts.length > 0) {
            const { error: pgsErr } = await supabase.from("player_game_stats").upsert(statsUpserts, {
              onConflict: "game_id,player_id"
            });
            if (!pgsErr) playerGameStatsUpserted += statsUpserts.length;
          }
        } catch {
          // ignore per-game failures
        }

        // Small throttle to reduce the chance of tripping rate limits.
        await new Promise((r) => setTimeout(r, 60));
      }
    }

    return {
      teamsUpserted: teamPayloads.length,
      gamesUpserted,
      teamGameStatsUpserted: statsUpsertsFinal.length,
      playersUpserted,
      playerGameStatsUpserted,
      bracketError,
      bracketDebug,
      henrygdSyncLogicVersion
    };
  }

  return {
    teamsUpserted: teamPayloads.length,
    gamesUpserted: 0,
    teamGameStatsUpserted: 0,
    playersUpserted: 0,
    playerGameStatsUpserted: 0,
    bracketError,
    bracketDebug,
    henrygdSyncLogicVersion
  };
}

