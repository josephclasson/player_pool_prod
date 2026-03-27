import type { SupabaseClient } from "@supabase/supabase-js";
import { externalTeamIdToSeo, normalizePlayerNameForMatch } from "@/lib/espn-mbb-directory";
import { claimHenrygdBoxscorePlayerForCanonicalRow } from "@/lib/henrygd";

type PlayerRosterRow = {
  id: number;
  name: string;
  team_id: number;
  henrygd_boxscore_player_id: string | null;
};

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

function safeNum(x: unknown): number | null {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

function normalizeGamesRoundForR1ToR6(roundValue: unknown): number | null {
  const r = safeNum(roundValue);
  if (r == null) return null;

  // Expected schema: 0..6 where 0=First Four, 1..6 = R1..R6.
  if (r >= 0 && r <= 6) return r;

  // If some prod data accidentally stored bracketPositionId-like values (e.g. 101, 201, ...),
  // convert back: floor(pos/100) - 1 => 0..6.
  if (r >= 100 && r <= 800) {
    const bucket = Math.floor(r / 100) - 1;
    if (bucket >= 0 && bucket <= 6) return bucket;
  }

  return null;
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

export type PlayerBoxscoreBackfillResult = {
  gamesAttempted: number;
  gamesWithPlayerStatsRows: number;
  playersTouched: number;
  playerGameStatsRowsUpserted: number;
  /** First issues only (HTTP, DB, exceptions). */
  errors: string[];
};

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

function gamesStatusesNeedsDeltaSync(statusRaw: unknown): "live" | "scheduled" | "final" | "other" {
  const s = String(statusRaw ?? "")
    .trim()
    .toLowerCase();
  if (s === "live") return "live";
  if (s === "scheduled") return "scheduled";
  if (s === "final") return "final";
  return "other";
}

/**
 * Fetches henrygd box scores for every R1–R6 row already in `games` and upserts `player_game_stats`.
 * Use when daily scoreboard sync created `games` but never filled per-player stats (empty table).
 *
 * @param deltaOnly When true, only hits **live** / **scheduled** games plus **final** games that still
 * have no `player_game_stats` rows (incremental refresh). When false, processes all R1–R6 games (heavy).
 */
export async function syncPlayerBoxscoresForSeasonGamesInDb(opts: {
  supabase: SupabaseClient;
  seasonYear: number;
  deltaOnly?: boolean;
}): Promise<PlayerBoxscoreBackfillResult> {
  const { supabase, seasonYear } = opts;
  const deltaOnly = opts.deltaOnly === true;

  const { data: teamRows } = await supabase
    .from("teams")
    .select("id, external_team_id")
    .ilike("external_team_id", `%-${seasonYear}`);

  const teamIdByExternal = new Map<string, number>();
  const teamIdBySeo = new Map<string, number>();
  for (const t of teamRows ?? []) {
    const ext = String(t.external_team_id ?? "");
    const id = safeNum(t.id);
    if (ext && id != null && id > 0) {
      teamIdByExternal.set(ext, id);
      const seo = externalTeamIdToSeo(ext, seasonYear);
      if (seo) {
        if (!teamIdBySeo.has(seo)) teamIdBySeo.set(seo, id);
        const base = seoBase(seo);
        if (base && !teamIdBySeo.has(base)) teamIdBySeo.set(base, id);
      }
    }
  }

  const allRounds: { id: number; external_game_id: string; statusBucket: ReturnType<
    typeof gamesStatusesNeedsDeltaSync
  > }[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data: chunk, error } = await supabase
      .from("games")
      .select("id, external_game_id, round, status")
      .not("external_game_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) break;
    const rows = chunk ?? [];
    for (const g of rows) {
      const id = safeNum((g as { id: unknown }).id);
      const ext = String((g as { external_game_id: unknown }).external_game_id ?? "");
      const bucket = normalizeGamesRoundForR1ToR6((g as { round?: unknown }).round);
      if (bucket == null) continue;
      if (bucket < 1 || bucket > 6) continue;
      if (id != null && id > 0 && ext) {
        allRounds.push({
          id,
          external_game_id: ext,
          statusBucket: gamesStatusesNeedsDeltaSync((g as { status?: unknown }).status)
        });
      }
    }
    if (rows.length < pageSize) break;
  }

  let gameRows: { id: number; external_game_id: string }[];

  if (!deltaOnly) {
    gameRows = allRounds.map((r) => ({ id: r.id, external_game_id: r.external_game_id }));
  } else {
    const liveSched = allRounds.filter(
      (r) => r.statusBucket === "live" || r.statusBucket === "scheduled"
    );
    const finalCandidates = allRounds.filter((r) => r.statusBucket === "final");
    let missingFinals: typeof allRounds = [];
    if (finalCandidates.length > 0) {
      const withStats = new Set<number>();
      const ids = finalCandidates.map((c) => c.id);
      const statPage = 300;
      for (let i = 0; i < ids.length; i += statPage) {
        const slice = ids.slice(i, i + statPage);
        const { data: statRows } = await supabase.from("player_game_stats").select("game_id").in("game_id", slice);
        for (const row of statRows ?? []) {
          const gid = safeNum((row as { game_id: unknown }).game_id);
          if (gid != null && gid > 0) withStats.add(gid);
        }
      }
      missingFinals = finalCandidates.filter((c) => !withStats.has(c.id));
    }
    const merged = [...liveSched, ...missingFinals];
    const seen = new Set<number>();
    gameRows = [];
    for (const r of merged) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      gameRows.push({ id: r.id, external_game_id: r.external_game_id });
    }
  }

  let playersTouched = 0;
  let playerGameStatsRowsUpserted = 0;
  let gamesWithPlayerStatsRows = 0;
  const errors: string[] = [];
  const maxErrors = 25;

  const parallelGames = 3;
  const pauseBetweenBatchesMs = 20;
  for (let i = 0; i < gameRows.length; i += parallelGames) {
    const batch = gameRows.slice(i, i + parallelGames);
    const results = await Promise.all(
      batch.map((g) =>
        ingestHenrygdBoxscoreForOneGame({
          supabase,
          seasonYear,
          gameInternalId: g.id,
          externalGameId: g.external_game_id,
          teamIdByExternal,
          teamIdBySeo
        }).then((one) => ({ g, one }))
      )
    );
    for (const { g, one } of results) {
      playersTouched += one.playersTouched;
      playerGameStatsRowsUpserted += one.playerGameStatsRowsUpserted;
      if (one.playerGameStatsRowsUpserted > 0) gamesWithPlayerStatsRows += 1;
      if (one.error && errors.length < maxErrors) errors.push(`${g.external_game_id}: ${one.error}`);
    }
    if (i + parallelGames < gameRows.length) {
      await new Promise((r) => setTimeout(r, pauseBetweenBatchesMs));
    }
  }

  return {
    gamesAttempted: gameRows.length,
    gamesWithPlayerStatsRows,
    playersTouched,
    playerGameStatsRowsUpserted,
    errors
  };
}

async function ingestHenrygdBoxscoreForOneGame(opts: {
  supabase: SupabaseClient;
  seasonYear: number;
  gameInternalId: number;
  externalGameId: string;
  teamIdByExternal: Map<string, number>;
  teamIdBySeo: Map<string, number>;
}): Promise<{
  playersTouched: number;
  playerGameStatsRowsUpserted: number;
  error?: string;
}> {
  const { supabase, seasonYear, gameInternalId, externalGameId, teamIdByExternal, teamIdBySeo } = opts;
  let playersTouched = 0;

  const boxUrl = `https://ncaa-api.henrygd.me/game/${encodeURIComponent(externalGameId)}/boxscore`;

  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20_000);
    const resp = await fetch(boxUrl, {
      signal: ac.signal,
      headers: { Accept: "application/json", "User-Agent": "player-pool/boxscore-sync" }
    });
    clearTimeout(t);
    if (!resp.ok) {
      return { playersTouched: 0, playerGameStatsRowsUpserted: 0, error: `boxscore HTTP ${resp.status}` };
    }

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

    const statsUpserts: { game_id: number; player_id: number; points: number }[] = [];

    for (const tb of teamBox) {
      const teamIdNum = safeNum(tb.teamId);
      const seoname = teamIdToSeoname.get(teamIdNum ?? 0) ?? "";
      if (!seoname) continue;

      const teamInternalId = resolveTeamInternalIdFromSeo(seoname, seasonYear, teamIdByExternal, teamIdBySeo);
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
            playersTouched += 1;
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
            playersTouched += 1;
          } else {
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
              playersTouched += 1;
            }
          }
        }

        if (internalPlayerId != null && internalPlayerId > 0) {
          statsUpserts.push({
            game_id: gameInternalId,
            player_id: internalPlayerId,
            points: points ?? 0
          });
        }
      }
    }

    if (statsUpserts.length === 0) {
      return { playersTouched, playerGameStatsRowsUpserted: 0 };
    }

    const { error: pgsErr } = await supabase.from("player_game_stats").upsert(statsUpserts, {
      onConflict: "game_id,player_id"
    });
    if (pgsErr) {
      return { playersTouched, playerGameStatsRowsUpserted: 0, error: pgsErr.message };
    }

    return { playersTouched, playerGameStatsRowsUpserted: statsUpserts.length };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { playersTouched: 0, playerGameStatsRowsUpserted: 0, error: msg };
  }
}
