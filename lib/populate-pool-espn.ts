import type { SupabaseClient } from "@supabase/supabase-js";
import { MIN_POOL_SEASON_PPG, NCAA_BRACKET_TEAM_COUNT } from "@/lib/player-pool-constants";
import {
  clearEspnMbbRosterCache,
  fetchEspnMbbAthleteSeasonPpg,
  fetchEspnMbbTeamRosterAthletes,
  getEspnMbbTeamIndex,
  resolveEspnMbbTeamForPopulate,
  resolveEspnMbbTeamFromSeo
} from "@/lib/espn-mbb-directory";
import { poolSlugClusterKeyFromTeamRow } from "@/lib/tournament-team-canonical";

function safeNum(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function parseIntOrNull(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Regional pod seed (1–16 on `teams.seed`) → max players to keep per team.
 * Seeds 1–3: no cap (all roster players with season PPG ≥ {@link MIN_POOL_SEASON_PPG}). Missing/invalid seed → conservative 3.
 */
function maxPlayersForRegionalSeed(regionalSeed: number | null | undefined): number {
  if (regionalSeed == null || !Number.isFinite(Number(regionalSeed))) return 3;
  const s = Math.trunc(Number(regionalSeed));
  if (s < 1 || s > 16) return 3;
  if (s <= 3) return Number.POSITIVE_INFINITY;
  if (s <= 7) return 5;
  if (s <= 11) return 4;
  if (s === 12) return 3;
  return 2;
}

/** henrygd `external_team_id` is `${seo}-${seasonYear}` (e.g. `duke-2026`). */
function seoFromExternalTeamId(externalTeamId: string, seasonYear: number): string | null {
  const suf = `-${seasonYear}`;
  if (!externalTeamId.endsWith(suf)) return null;
  return externalTeamId.slice(0, -suf.length).toLowerCase();
}

export function buildEspnPoolExternalPlayerId(opts: { seasonYear: number; espnAthleteId: number }): string {
  return `${opts.seasonYear}:espn:${opts.espnAthleteId}`;
}

function chunkArray<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** After player `team_id` changes (e.g. re-import), align roster slots so scoring/elimination use the same NCAA team row as games. */
async function repairRosterSlotTeamIdsFromPlayers(
  supabase: SupabaseClient,
  seasonYear: number
): Promise<void> {
  const { data: players } = await supabase.from("players").select("id, team_id").eq("season_year", seasonYear);
  if (!players?.length) return;
  const byPid = new Map<number, number>();
  for (const p of players) {
    const pid = safeNum((p as { id?: unknown }).id);
    const tid = safeNum((p as { team_id?: unknown }).team_id);
    if (pid > 0 && tid > 0) byPid.set(pid, tid);
  }
  const { data: slots } = await supabase.from("player_roster_slots").select("id, player_id, team_id");
  const updates: Array<{ id: string; team_id: number }> = [];
  for (const s of slots ?? []) {
    const sid = String((s as { id?: unknown }).id ?? "").trim();
    const pid = safeNum((s as { player_id?: unknown }).player_id);
    const cur = safeNum((s as { team_id?: unknown }).team_id);
    const want = byPid.get(pid);
    if (!sid || want == null || want <= 0 || cur === want) continue;
    updates.push({ id: sid, team_id: want });
  }
  const nowIso = new Date().toISOString();
  for (const batch of chunkArray(updates, 80)) {
    await Promise.all(
      batch.map((u) =>
        supabase.from("player_roster_slots").update({ team_id: u.team_id, updated_at: nowIso }).eq("id", u.id)
      )
    );
  }
}

export type PopulatePoolFromEspnResult = {
  seasonYear: number;
  /** Always {@link NCAA_BRACKET_TEAM_COUNT} when populate runs successfully past validation. */
  bracketTeamsExpected: number;
  /** Distinct overall seeds 1–68 present before processing. */
  bracketTeamsPresent: number;
  teamsSuccess: number;
  teamsFailed: number;
  playersUpserted: number;
  seasonPpgPopulated: number;
  rosterFailures: number;
  statsFailures: number;
  /** Bracket teams with no player meeting min PPG / ESPN path failed (should be very few after good data). */
  teamsWithNoQualifiedPlayers: string[];
  warning?: string;
  debug?: {
    stMarys?: {
      teamLabel: string;
      externalTeamId: string;
      seo: string | null;
      espnTeamId: number | null;
      espnTeamSlug: string | null;
    };
    pauliusMurauskas?: {
      athleteId: number;
      teamEspnId: number;
      seasonPpg: number | null;
      existingSeasonPpg: number | null;
      existingHadValidPpg: boolean;
      hasExistingExternal: boolean;
      uniqueKeyExists: boolean;
    };
  };
};

const STAT_FETCH_THROTTLE_MS = 85;

type TeamRow = {
  id: number;
  name: string;
  short_name: string | null;
  seed: number | null;
  overall_seed: number | null;
  external_team_id: string;
};

function buildBracketTeamList(
  teamsRows: Record<string, unknown>[] | null | undefined
): TeamRow[] {
  const byOverall = new Map<number, TeamRow>();
  const sorted = [...(teamsRows ?? [])].sort(
    (a, b) => safeNum((a as { id?: unknown }).id) - safeNum((b as { id?: unknown }).id)
  );
  for (const raw of sorted) {
    const t = raw as TeamRow;
    const osRaw = t.overall_seed;
    const os = typeof osRaw === "number" ? osRaw : Number(osRaw);
    if (!Number.isFinite(os)) continue;
    const overall = Math.trunc(os);
    if (overall < 1 || overall > NCAA_BRACKET_TEAM_COUNT) continue;
    const tid = safeNum(t.id);
    if (tid <= 0) continue;
    if (!byOverall.has(overall)) {
      const sd = t.seed;
      const seedN = sd != null ? safeNum(sd) : null;
      byOverall.set(overall, {
        id: Math.trunc(tid),
        name: String(t.name ?? ""),
        short_name: t.short_name != null ? String(t.short_name) : null,
        seed: seedN != null && seedN > 0 ? Math.trunc(seedN) : null,
        overall_seed: overall,
        external_team_id: String(t.external_team_id ?? "")
      });
    }
  }

  if (byOverall.size !== NCAA_BRACKET_TEAM_COUNT) {
    const missing: number[] = [];
    for (let i = 1; i <= NCAA_BRACKET_TEAM_COUNT; i++) {
      if (!byOverall.has(i)) missing.push(i);
    }
    throw new Error(
      `Bracket incomplete: need exactly ${NCAA_BRACKET_TEAM_COUNT} teams with overall_seed 1–${NCAA_BRACKET_TEAM_COUNT} for season (found ${byOverall.size}). Missing overall seeds (sample): ${missing.slice(0, 24).join(", ")}${missing.length > 24 ? " …" : ""}. Run committee seed / tournament setup first.`
    );
  }

  return [...byOverall.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row);
}

/**
 * Import tournament player pool from ESPN (public site.api.espn.com): team roster + per-athlete season PPG.
 * Requires a full 1–68 overall_seed bracket. Only athletes with season PPG ≥ {@link MIN_POOL_SEASON_PPG} are stored.
 */
export async function populatePoolPlayersFromEspn(opts: {
  supabase: SupabaseClient;
  seasonYear: number;
  replace?: boolean;
  source?: string;
}): Promise<PopulatePoolFromEspnResult> {
  const { supabase, seasonYear, replace = true } = opts;
  const seasonPpgSource = opts.source ?? "espn_athlete_season_stats";

  // Target athlete for verification during imports.
  // ESPN athlete id for Paulius Murauskas (St. Mary's).
  const debugTargetAthleteId = 5174955;
  let debugPaulius: PopulatePoolFromEspnResult["debug"] = {};

  const { data: teamsRows } = await supabase
    .from("teams")
    .select("id, name, short_name, seed, overall_seed, external_team_id")
    .ilike("external_team_id", `%-${seasonYear}`);

  const allowedTeams = buildBracketTeamList(teamsRows as Record<string, unknown>[] | null);

  if (replace) {
    await supabase.from("players").delete().eq("season_year", seasonYear);
  }

  clearEspnMbbRosterCache();
  const espnIdx = await getEspnMbbTeamIndex();

  // Non-destructive mode: never delete players.
  // We still allow fixing broken season_ppg values for existing players whose
  // current season_ppg is null/blank or below the minimum threshold.
  const existingByExternalId = !replace
    ? new Map<
        string,
        { id: number; seasonPpg: number | null; teamId: number; name: string; externalPlayerId: string | null }
      >(
        (
          await supabase
            .from("players")
            .select("id, team_id, name, external_player_id, season_ppg")
            .eq("season_year", seasonYear)
        ).data
          ?.flatMap((r: {
            id?: unknown;
            team_id?: unknown;
            name?: unknown;
            external_player_id?: unknown;
            season_ppg?: unknown;
          }) => {
            const id = Number(r.id);
            const teamId = Number(r.team_id);
            const name = String(r.name ?? "").trim();
            const external = String(r.external_player_id ?? "").trim();
            if (!external || !Number.isFinite(id) || !Number.isFinite(teamId) || !name) return [];
            const raw = r.season_ppg;
            if (raw == null || raw === "")
              return [[external, { id, teamId, name, externalPlayerId: external, seasonPpg: null }]] as const;
            const n = typeof raw === "number" ? raw : Number(raw);
            return [
              [
                external,
                {
                  id,
                  teamId,
                  name,
                  externalPlayerId: external,
                  seasonPpg: Number.isFinite(n) ? n : null
                }
              ]
            ] as const;
          }) ?? []
      )
    : null;

  // Existing rows by (team_id,name) unique key so we can repair their season_ppg without inserts.
  const existingByTeamNameKey = !replace
    ? new Map<
        string,
        { id: number; seasonPpg: number | null; teamId: number; name: string; externalPlayerId: string | null }
      >(
        (
          await supabase
            .from("players")
            .select("id, team_id, name, external_player_id, season_ppg")
            .eq("season_year", seasonYear)
        ).data
          ?.flatMap((r: {
            id?: unknown;
            team_id?: unknown;
            name?: unknown;
            external_player_id?: unknown;
            season_ppg?: unknown;
          }) => {
            const id = Number((r.id as unknown) ?? NaN);
            const tid = Number((r.team_id as unknown) ?? NaN);
            const nm = String((r.name as unknown) ?? "").trim();
            if (!Number.isFinite(id) || !Number.isFinite(tid) || !nm) return [];
            const raw = r.season_ppg;
            const n =
              raw == null || raw === ""
                ? null
                : typeof raw === "number"
                  ? raw
                  : Number(raw);
            const external = String(r.external_player_id ?? "").trim();
            return [
              [
                `${tid}:${nm}`,
                {
                  id,
                  teamId: tid,
                  name: nm,
                  externalPlayerId: external || null,
                  seasonPpg: Number.isFinite(n as number) ? (n as number) : null
                }
              ]
            ] as const;
          }) ?? []
      )
    : null;

  let teamsSuccess = 0;
  let teamsFailed = 0;
  let playersUpserted = 0;
  let seasonPpgPopulated = 0;
  let rosterFailures = 0;
  let statsFailures = 0;
  const teamsWithNoQualifiedPlayers: string[] = [];

  const playersBatch: Record<string, unknown>[] = [];

  async function upsertPlayersBatch() {
    if (playersBatch.length === 0) return;
    const batches = chunkArray(playersBatch.splice(0, playersBatch.length), 250);
    for (const batch of batches) {
      const { error } = await supabase.from("players").upsert(batch, { onConflict: "external_player_id" });
      if (error) throw error;
      playersUpserted += batch.length;
      seasonPpgPopulated += batch.filter((p: { season_ppg?: unknown }) => p.season_ppg != null).length;
    }
  }

  for (const row of allowedTeams) {
    let seo = seoFromExternalTeamId(String(row.external_team_id ?? ""), seasonYear);
    if (seo && /^\d+$/.test(seo)) {
      const slug = poolSlugClusterKeyFromTeamRow({
        id: row.id,
        external_team_id: String(row.external_team_id ?? ""),
        name: row.name,
        short_name: row.short_name
      });
      if (slug) seo = slug;
    }
    const espnBySeo = seo?.trim() ? resolveEspnMbbTeamFromSeo(espnIdx, seo) : null;
    const espnTeamResolved = resolveEspnMbbTeamForPopulate(espnIdx, {
      seo,
      shortName: row.short_name,
      fullName: row.name
    });
    const espnTeam = espnBySeo ?? espnTeamResolved;

    const teamLabel = row.short_name?.trim() || row.name || `team ${row.id}`;

    // Record how St. Mary's is resolved for debugging (helps distinguish mapping vs PPG parsing).
    const teamLabelLower = `${row.name ?? ""} ${row.short_name ?? ""}`.toLowerCase();
    const isStMarys = teamLabelLower.includes("saint mary") || teamLabelLower.includes("st mary");
    if (isStMarys) {
      debugPaulius.stMarys = {
        teamLabel,
        externalTeamId: String(row.external_team_id ?? ""),
        seo: seo ?? null,
        espnTeamId: espnTeam?.id ?? null,
        espnTeamSlug: espnTeam?.slug ?? null
      };
    }

    if (!espnTeam) {
      teamsFailed += 1;
      rosterFailures += 1;
      teamsWithNoQualifiedPlayers.push(`${teamLabel} (no ESPN match)`);
      continue;
    }

    await new Promise((r) => setTimeout(r, 140));
    let athletes: Awaited<ReturnType<typeof fetchEspnMbbTeamRosterAthletes>>;
    try {
      athletes = await fetchEspnMbbTeamRosterAthletes(espnTeam.id);
    } catch {
      teamsFailed += 1;
      rosterFailures += 1;
      teamsWithNoQualifiedPlayers.push(`${teamLabel} (roster fetch failed)`);
      continue;
    }

    if (!athletes.length) {
      teamsFailed += 1;
      rosterFailures += 1;
      teamsWithNoQualifiedPlayers.push(`${teamLabel} (empty roster)`);
      continue;
    }

    type RowPayload = Record<string, unknown> & { _sortPpg: number };
    const eligiblePlayers: RowPayload[] = [];
    let teamStatsMisses = 0;
    let newAthletesConsidered = 0;

    for (const a of athletes) {
      const athleteName = String(a.fullName || a.displayName || "").trim();
      const externalPlayerId = buildEspnPoolExternalPlayerId({
        seasonYear,
        espnAthleteId: a.id
      });
      const teamNameKey = `${row.id}:${athleteName}`;
      const existingByName = !replace ? existingByTeamNameKey?.get(teamNameKey) ?? null : null;
      if (!replace) {
        if (!athleteName) continue;
        const hasExistingExternal = existingByExternalId?.has(externalPlayerId) ?? false;
        const existingSeasonPpg = hasExistingExternal
          ? (existingByExternalId?.get(externalPlayerId)?.seasonPpg ?? null)
          : (existingByName?.seasonPpg ?? null);
        const existingHasValidPpg =
          existingSeasonPpg != null &&
          Number.isFinite(Number(existingSeasonPpg)) &&
          Number(existingSeasonPpg) >= MIN_POOL_SEASON_PPG;

        const isDebugTarget = a.id === debugTargetAthleteId;
        if (isDebugTarget && debugPaulius.pauliusMurauskas == null) {
          debugPaulius.pauliusMurauskas = {
            athleteId: a.id,
            teamEspnId: espnTeam.id,
            seasonPpg: existingSeasonPpg ?? null,
            existingSeasonPpg,
            existingHadValidPpg: existingHasValidPpg,
            hasExistingExternal,
            uniqueKeyExists: existingByName != null
          };
        }
        if (existingHasValidPpg) continue;
      }

      newAthletesConsidered += 1;

      await new Promise((r) => setTimeout(r, STAT_FETCH_THROTTLE_MS));
      let season_ppg: number | null = null;
      try {
        const ppg = await fetchEspnMbbAthleteSeasonPpg({
          athleteId: a.id,
          teamEspnId: espnTeam.id,
          championshipYear: seasonYear
        });
        if (ppg != null && Number.isFinite(ppg) && ppg >= MIN_POOL_SEASON_PPG) season_ppg = ppg;
        else teamStatsMisses += 1;
      } catch {
        teamStatsMisses += 1;
      }

      if (a.id === debugTargetAthleteId) {
        debugPaulius.pauliusMurauskas = {
          athleteId: a.id,
          teamEspnId: espnTeam.id,
          seasonPpg: season_ppg,
          existingSeasonPpg: debugPaulius.pauliusMurauskas?.existingSeasonPpg ?? null,
          existingHadValidPpg: debugPaulius.pauliusMurauskas?.existingHadValidPpg ?? false,
          hasExistingExternal: debugPaulius.pauliusMurauskas?.hasExistingExternal ?? false,
          uniqueKeyExists: debugPaulius.pauliusMurauskas?.uniqueKeyExists ?? false
        };
      }

      if (season_ppg == null || season_ppg < MIN_POOL_SEASON_PPG) continue;

      const jersey_number = a.jersey ? parseIntOrNull(a.jersey) : null;
      const height_inches = a.heightInches != null ? Math.round(a.heightInches) : null;
      const height = height_inches != null ? String(height_inches) : null;

      // Non-destructive repair path: update existing row matched by (team_id,name,season_year)
      // when external id is missing/mismatched and season_ppg needs fixing.
      if (!replace && existingByName && !(existingByExternalId?.has(externalPlayerId) ?? false)) {
        const payload: Record<string, unknown> = {
          season_ppg,
          season_ppg_source: seasonPpgSource,
          espn_athlete_id: a.id,
          headshot_url: a.headshotHref?.trim() || null,
          position: a.position ?? null,
          jersey_number,
          height,
          height_inches
        };
        if (!existingByName.externalPlayerId) payload.external_player_id = externalPlayerId;
        const { error } = await supabase.from("players").update(payload).eq("id", existingByName.id);
        if (error) throw error;
        playersUpserted += 1;
        seasonPpgPopulated += 1;
        // Update in-memory indexes for subsequent rows in this run.
        const nextRow = {
          ...existingByName,
          seasonPpg: season_ppg,
          externalPlayerId: existingByName.externalPlayerId ?? externalPlayerId
        };
        existingByTeamNameKey?.set(teamNameKey, nextRow);
        existingByExternalId?.set(externalPlayerId, nextRow);
        continue;
      }

      eligiblePlayers.push({
        external_player_id: externalPlayerId,
        team_id: row.id,
        name: athleteName,
        short_name: jersey_number != null ? String(jersey_number) : null,
        position: a.position ?? null,
        jersey_number,
        height,
        height_inches,
        season_year: seasonYear,
        season_ppg,
        season_ppg_source: seasonPpgSource,
        espn_athlete_id: a.id,
        headshot_url: a.headshotHref?.trim() || null,
        _sortPpg: season_ppg
      });
    }

    if (teamStatsMisses > 0 && eligiblePlayers.length === 0) statsFailures += 1;

    eligiblePlayers.sort((a, b) => b._sortPpg - a._sortPpg);
    const cap = maxPlayersForRegionalSeed(row.seed);
    const toInsert = eligiblePlayers.slice(0, cap);

    if (toInsert.length === 0) {
      if (!replace && newAthletesConsidered === 0) {
        // Non-destructive delta run: no new players for this team.
        teamsSuccess += 1;
      } else {
        teamsFailed += 1;
        teamsWithNoQualifiedPlayers.push(
          `${teamLabel} (no roster athletes with season PPG ≥ ${MIN_POOL_SEASON_PPG})`
        );
        await upsertPlayersBatch();
        await new Promise((res) => setTimeout(res, 350));
      }
      continue;
    }

    for (const c of toInsert) {
      const { _sortPpg: _, ...payload } = c;
      playersBatch.push(payload);
    }

    teamsSuccess += 1;
    await upsertPlayersBatch();
    await new Promise((res) => setTimeout(res, 350));
  }

  await upsertPlayersBatch();

  await repairRosterSlotTeamIdsFromPlayers(supabase, seasonYear);

  let warning: string | undefined;
  if (teamsWithNoQualifiedPlayers.length > 0) {
    warning = `${teamsWithNoQualifiedPlayers.length} bracket team(s) produced no qualifying players (ESPN match, roster, or season PPG ≥ ${MIN_POOL_SEASON_PPG}). See teamsWithNoQualifiedPlayers.`;
  }
  if (replace && playersUpserted === 0 && allowedTeams.length > 0) {
    warning =
      warning ??
      `ESPN import wrote 0 players (${teamsFailed}/${allowedTeams.length} teams failed — usually no ESPN team match, empty roster, or no athlete season PPG ≥ ${MIN_POOL_SEASON_PPG}). Season ${seasonYear}.`;
  }

  return {
    seasonYear,
    bracketTeamsExpected: NCAA_BRACKET_TEAM_COUNT,
    bracketTeamsPresent: allowedTeams.length,
    teamsSuccess,
    teamsFailed,
    playersUpserted,
    seasonPpgPopulated,
    rosterFailures,
    statsFailures,
    teamsWithNoQualifiedPlayers,
    ...(warning ? { warning } : {}),
    ...(debugPaulius.stMarys || debugPaulius.pauliusMurauskas ? { debug: debugPaulius } : {})
  };
}
