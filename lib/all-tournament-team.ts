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
