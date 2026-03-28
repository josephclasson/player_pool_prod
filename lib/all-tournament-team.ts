import type { LeaderboardRosterPlayerApi } from "@/lib/scoring/persist-league-scoreboard";

/** Draft order index for “best pick per round” (camelCase API or legacy snake_case). */
function resolvedPickOverall(p: LeaderboardRosterPlayerApi): number | null {
  const camel = p.pickOverall;
  if (camel != null && Number.isFinite(Number(camel)) && Number(camel) >= 1) {
    return Number(camel);
  }
  const snake = (p as { pick_overall?: unknown }).pick_overall;
  const n = typeof snake === "number" ? snake : Number(snake);
  if (Number.isFinite(n) && n >= 1) return n;
  return null;
}

/** Sum fantasy points R1–R6 for one roster row. */
export function sumTournamentPoints(p: LeaderboardRosterPlayerApi): number {
  let s = 0;
  for (let r = 1; r <= 6; r++) {
    if (Object.prototype.hasOwnProperty.call(p.tournamentRoundPoints, r)) {
      s += p.tournamentRoundPoints[r];
    }
  }
  return s;
}

/** Every drafted player in the league (deduped by `playerId`, keeps best tournament total). */
export function allLeagueDraftedPlayers(
  teams: Array<{ players?: LeaderboardRosterPlayerApi[] }>
): LeaderboardRosterPlayerApi[] {
  const map = new Map<number, LeaderboardRosterPlayerApi>();
  for (const t of teams) {
    for (const p of t.players ?? []) {
      const prev = map.get(p.playerId);
      if (!prev || sumTournamentPoints(p) > sumTournamentPoints(prev)) {
        map.set(p.playerId, p);
      }
    }
  }
  return [...map.values()];
}

/** Top `k` players by tournament fantasy points (stable tie-break: lower player id). */
export function topKAllTournamentPlayers(
  players: LeaderboardRosterPlayerApi[],
  k: number
): LeaderboardRosterPlayerApi[] {
  return [...players]
    .sort((a, b) => {
      const tb = sumTournamentPoints(b) - sumTournamentPoints(a);
      if (tb !== 0) return tb;
      return a.playerId - b.playerId;
    })
    .slice(0, k);
}

/** Bottom `k` players by tournament fantasy points (stable tie-break: lower player id). */
export function bottomKAllTournamentPlayers(
  players: LeaderboardRosterPlayerApi[],
  k: number
): LeaderboardRosterPlayerApi[] {
  return [...players]
    .sort((a, b) => {
      const tb = sumTournamentPoints(a) - sumTournamentPoints(b);
      if (tb !== 0) return tb;
      return a.playerId - b.playerId;
    })
    .slice(0, k);
}

/** One roster pick per fantasy owner per draft round (standard pool: 8). */
export const HIGHLIGHT_DRAFT_ROUNDS = 8;

/**
 * Draft round 1..n from overall pick # and league size (snake draft slot order).
 * e.g. 8 teams: picks 1–8 → round 1, 9–16 → round 2, …
 */
export function draftRoundFromPickOverall(pickOverall: number, numTeams: number): number | null {
  if (!Number.isFinite(pickOverall) || pickOverall < 1) return null;
  if (!Number.isFinite(numTeams) || numTeams < 1) return null;
  return Math.floor((pickOverall - 1) / numTeams) + 1;
}

/**
 * For each draft round 1..HIGHLIGHT_DRAFT_ROUNDS, the drafted player with the highest
 * tournament fantasy total so far in that round (tie-break: lower `playerId`).
 * Missing `pickOverall` or empty round → `null` at that index.
 */
export function bestPlayerPerDraftRound(
  players: LeaderboardRosterPlayerApi[],
  numTeams: number
): (LeaderboardRosterPlayerApi | null)[] {
  const byRound = new Map<number, LeaderboardRosterPlayerApi[]>();
  for (const p of players) {
    const po = resolvedPickOverall(p);
    if (po == null) continue;
    const dr = draftRoundFromPickOverall(po, numTeams);
    if (dr == null || dr < 1 || dr > HIGHLIGHT_DRAFT_ROUNDS) continue;
    const arr = byRound.get(dr) ?? [];
    arr.push(p);
    byRound.set(dr, arr);
  }
  const out: (LeaderboardRosterPlayerApi | null)[] = [];
  for (let r = 1; r <= HIGHLIGHT_DRAFT_ROUNDS; r++) {
    const pool = byRound.get(r) ?? [];
    out.push(pool.length === 0 ? null : topKAllTournamentPlayers(pool, 1)[0] ?? null);
  }
  return out;
}

/**
 * For each draft round 1..HIGHLIGHT_DRAFT_ROUNDS, the drafted player with the lowest
 * tournament fantasy total so far in that round (tie-break: lower `playerId`).
 * Missing `pickOverall` or empty round → `null` at that index.
 */
export function worstPlayerPerDraftRound(
  players: LeaderboardRosterPlayerApi[],
  numTeams: number
): (LeaderboardRosterPlayerApi | null)[] {
  const byRound = new Map<number, LeaderboardRosterPlayerApi[]>();
  for (const p of players) {
    const po = resolvedPickOverall(p);
    if (po == null) continue;
    const dr = draftRoundFromPickOverall(po, numTeams);
    if (dr == null || dr < 1 || dr > HIGHLIGHT_DRAFT_ROUNDS) continue;
    const arr = byRound.get(dr) ?? [];
    arr.push(p);
    byRound.set(dr, arr);
  }
  const out: (LeaderboardRosterPlayerApi | null)[] = [];
  for (let r = 1; r <= HIGHLIGHT_DRAFT_ROUNDS; r++) {
    const pool = byRound.get(r) ?? [];
    out.push(pool.length === 0 ? null : bottomKAllTournamentPlayers(pool, 1)[0] ?? null);
  }
  return out;
}

function safePoolNum(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Map a row from `GET /api/players/pool?leagueId=…` into {@link LeaderboardRosterPlayerApi}
 * so highlight tables can reuse the same rendering as drafted roster rows.
 */
export function poolApiRowToLeaderboardRosterPlayerApi(row: Record<string, unknown>): LeaderboardRosterPlayerApi {
  const pid = safePoolNum(row.id);
  const headshotUrls = Array.isArray(row.headshotUrls)
    ? (row.headshotUrls as unknown[]).map((u) => String(u)).filter((s) => s.length > 0)
    : [];

  const teamRaw = row.team;
  let team: LeaderboardRosterPlayerApi["team"] = null;
  let overallSeed: number | null = null;
  if (teamRaw != null && typeof teamRaw === "object") {
    const t = teamRaw as Record<string, unknown>;
    const tid = safePoolNum(t.id);
    const nm = t.name != null ? String(t.name).trim() : "";
    const seedRaw = t.seed != null ? safePoolNum(t.seed) : 0;
    const seed = seedRaw > 0 ? seedRaw : null;
    const osRaw = t.overallSeed != null ? safePoolNum(t.overallSeed) : 0;
    if (osRaw >= 1 && osRaw <= 68) overallSeed = Math.trunc(osRaw);
    if (tid > 0) {
      team = {
        id: tid,
        name: nm || `Team #${tid}`,
        shortName: t.shortName != null ? String(t.shortName) : null,
        seed,
        region: t.region != null ? String(t.region) : null,
        logoUrl: t.logoUrl != null ? String(t.logoUrl) : null
      };
    }
  }

  const trp: Record<number, number> = {};
  const rawTrp = row.tournamentRoundPoints;
  if (rawTrp != null && typeof rawTrp === "object") {
    for (const [k, v] of Object.entries(rawTrp as Record<string, unknown>)) {
      const r = Number(k);
      if (!Number.isInteger(r) || r < 1 || r > 6) continue;
      if (typeof v === "number" && Number.isFinite(v)) trp[r] = v;
    }
  }

  const sp = row.season_ppg != null ? Number(row.season_ppg) : null;
  const seasonPpg = sp != null && Number.isFinite(sp) ? sp : null;

  const espnRaw = row.espn_athlete_id != null ? safePoolNum(row.espn_athlete_id) : 0;
  const espnAthleteId = espnRaw > 0 ? Math.trunc(espnRaw) : null;

  const projRaw = row.projection != null ? Number(row.projection) : 0;
  const liveRounded = Number.isFinite(projRaw) ? Math.round(projRaw) : 0;
  const origRaw = row.originalProjection != null ? Number(row.originalProjection) : null;
  const origRounded =
    origRaw != null && Number.isFinite(origRaw) ? Math.round(origRaw) : null;

  const name =
    row.name != null && String(row.name).trim() !== "" ? String(row.name).trim() : `Player ${pid}`;

  return {
    playerId: pid,
    rosterSlotId: `undrafted-pool-${pid}`,
    ownerName: "Undrafted",
    name,
    shortName: row.short_name != null ? String(row.short_name) : null,
    position:
      row.position != null && String(row.position).trim() !== "" ? String(row.position).trim() : null,
    seasonPpg,
    headshotUrls,
    espnAthleteId,
    overallSeed,
    team,
    tournamentRoundPoints: trp,
    projection: liveRounded,
    originalProjection: origRounded,
    plusMinus: origRounded != null ? liveRounded - origRounded : null,
    eliminated: false,
    eliminatedRound: null,
    pickOverall: null
  };
}

/**
 * Pool rows that are not on any league roster (`ownerTeamName` null) and not in `draftedPlayerIds`.
 */
export function undraftedPoolPlayersForAllTournamentTeam(
  poolRows: Record<string, unknown>[],
  draftedPlayerIds: Set<number>
): LeaderboardRosterPlayerApi[] {
  const out: LeaderboardRosterPlayerApi[] = [];
  for (const row of poolRows) {
    const pid = safePoolNum(row.id);
    if (pid <= 0) continue;
    if (draftedPlayerIds.has(pid)) continue;
    const own = row.ownerTeamName;
    if (own != null && String(own).trim() !== "") continue;
    out.push(poolApiRowToLeaderboardRosterPlayerApi(row));
  }
  return out;
}
