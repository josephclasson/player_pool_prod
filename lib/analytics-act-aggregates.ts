import { draftRoundFromPickOverall, resolvedPickOverall } from "@/lib/all-tournament-team";
import { displayCollegeTeamNameForUi } from "@/lib/college-team-display";
import {
  conferenceSeoSlugForDraftedPlayerTeam,
  OTHER_D1_CONFERENCE_SEO
} from "@/lib/mbb-pool-slug-to-conference-seo";
import { rosterPlayersToOwnerMetrics, type LeaderboardOwnerPlayerMetrics } from "@/lib/leaderboard-owner-metrics";
import type { LeaderboardApiPayload } from "@/lib/scoring/persist-league-scoreboard";
import type { LeaderboardRosterPlayerApi } from "@/lib/scoring/leaderboard-roster-detail";

export type AnalyticsActAggregateRow = {
  key: string;
  label: string;
  /** Drafted players in this bucket (school / conference / seed / draft round). */
  tot: number;
  remain: number;
  roundScores: Record<number, number>;
  totalScore: number;
};

export type AnalyticsActAggregateRankedRow = AnalyticsActAggregateRow & { rank: number };

function metricsForPlayer(p: LeaderboardRosterPlayerApi): LeaderboardOwnerPlayerMetrics {
  return rosterPlayersToOwnerMetrics([p])[0]!;
}

function foldMetrics(players: LeaderboardOwnerPlayerMetrics[]): Omit<AnalyticsActAggregateRow, "key" | "label"> {
  const tot = players.length;
  const remain = players.filter((m) => !m.eliminated).length;
  const roundScores: Record<number, number> = {};
  for (let r = 1; r <= 6; r++) {
    let sum = 0;
    let any = false;
    for (const m of players) {
      const trp = m.tournamentRoundPoints ?? {};
      if (Object.prototype.hasOwnProperty.call(trp, r)) {
        any = true;
        sum += trp[r] ?? 0;
      }
    }
    if (any) roundScores[r] = Math.round(sum);
  }
  let totalScore = 0;
  for (let r = 1; r <= 6; r++) {
    if (Object.prototype.hasOwnProperty.call(roundScores, r)) totalScore += roundScores[r]!;
  }
  return { tot, remain, roundScores, totalScore };
}

/** Sort by total (desc), tie-break label; assign standings # 1..n. */
export function assignAnalyticsRanks(rows: AnalyticsActAggregateRow[]): AnalyticsActAggregateRankedRow[] {
  const sorted = [...rows].sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return a.label.localeCompare(b.label);
  });
  return sorted.map((row, i) => ({ ...row, rank: i + 1 }));
}

export function pointsBehindLeaderInTable(totalScore: number, maxTotal: number | null): number | null {
  if (maxTotal == null || !Number.isFinite(maxTotal)) return null;
  if (!Number.isFinite(totalScore)) return null;
  return Math.max(0, Math.round(maxTotal) - Math.round(totalScore));
}

export function maxTotalInRows(rows: Array<{ totalScore: number }>): number | null {
  if (rows.length === 0) return null;
  let max = -Infinity;
  for (const r of rows) {
    if (Number.isFinite(r.totalScore)) max = Math.max(max, r.totalScore);
  }
  return Number.isFinite(max) ? max : null;
}

function allDraftedPlayers(teams: LeaderboardApiPayload["teams"]): LeaderboardRosterPlayerApi[] {
  const out: LeaderboardRosterPlayerApi[] = [];
  for (const t of teams) {
    for (const p of t.players ?? []) out.push(p);
  }
  return out;
}

export function buildSchoolPerformanceRows(teams: LeaderboardApiPayload["teams"]): AnalyticsActAggregateRow[] {
  const buckets = new Map<string, { label: string; players: LeaderboardOwnerPlayerMetrics[] }>();
  for (const p of allDraftedPlayers(teams)) {
    const team = p.team;
    if (!team) continue;
    const fallback = team.name?.trim() || "Unknown";
    const label = displayCollegeTeamNameForUi(
      { id: team.id, name: team.name, short_name: team.shortName },
      fallback
    );
    const key =
      typeof team.id === "number" && team.id > 0 ? `id:${team.id}` : `name:${label.toLowerCase()}`;
    const m = metricsForPlayer(p);
    const cur = buckets.get(key);
    if (cur) cur.players.push(m);
    else buckets.set(key, { label, players: [m] });
  }
  const rows: AnalyticsActAggregateRow[] = [];
  for (const [key, { label, players }] of buckets) {
    const folded = foldMetrics(players);
    rows.push({ key, label, ...folded });
  }
  return rows;
}

/** Known `teams.conference` SEO slugs → display names (Big Ten, SEC, …). */
const CONFERENCE_SLUG_LABELS: Record<string, string> = {
  "big-ten": "Big Ten",
  "big-12": "Big 12",
  sec: "SEC",
  acc: "ACC",
  "pac-12": "Pac-12",
  american: "American",
  usa: "C-USA",
  "big-east": "Big East",
  "mountain-west": "Mountain West",
  "west-coast": "WCC",
  wcc: "WCC",
  ivy: "Ivy",
  "ivy-league": "Ivy",
  "a-10": "A-10",
  "sun-belt": "Sun Belt",
  mac: "MAC",
  mvc: "MVC",
  maac: "MAAC",
  caa: "CAA",
  asun: "ASUN",
  "big-sky": "Big Sky",
  "big-south": "Big South",
  "big-west": "Big West",
  cusa: "C-USA",
  horizon: "Horizon",
  "missouri-valley": "MVC",
  "ohio-valley": "OVC",
  ovc: "OVC",
  "patriot-league": "Patriot",
  southern: "Southern",
  "southland": "Southland",
  "summit-league": "Summit",
  "swac": "SWAC",
  "wac": "WAC"
};

function displayConferenceLabelForUi(slug: string): string {
  const raw = slug.trim();
  if (!raw) return "—";
  const lower = raw.toLowerCase();
  if (CONFERENCE_SLUG_LABELS[lower]) return CONFERENCE_SLUG_LABELS[lower];
  return lower
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function buildConferencePerformanceRows(
  teams: LeaderboardApiPayload["teams"]
): AnalyticsActAggregateRow[] {
  const buckets = new Map<string, { label: string; players: LeaderboardOwnerPlayerMetrics[] }>();
  for (const p of allDraftedPlayers(teams)) {
    const team = p.team;
    if (!team) continue;
    const slug = conferenceSeoSlugForDraftedPlayerTeam(team);
    const key = `conf:${slug}`;
    const label = displayConferenceLabelForUi(slug);
    const m = metricsForPlayer(p);
    const cur = buckets.get(key);
    if (cur) cur.players.push(m);
    else buckets.set(key, { label, players: [m] });
  }
  const rows: AnalyticsActAggregateRow[] = [];
  for (const [key, { label, players }] of buckets) {
    const folded = foldMetrics(players);
    rows.push({ key, label, ...folded });
  }
  return rows;
}

export function buildSeedPerformanceRows(teams: LeaderboardApiPayload["teams"]): AnalyticsActAggregateRow[] {
  const buckets = new Map<number, LeaderboardOwnerPlayerMetrics[]>();
  for (const p of allDraftedPlayers(teams)) {
    const seed = p.team?.seed;
    if (seed == null || !Number.isFinite(Number(seed))) continue;
    const n = Math.trunc(Number(seed));
    if (n < 1) continue;
    const m = metricsForPlayer(p);
    const list = buckets.get(n) ?? [];
    list.push(m);
    buckets.set(n, list);
  }
  const rows: AnalyticsActAggregateRow[] = [];
  for (const [seed, players] of buckets) {
    const folded = foldMetrics(players);
    rows.push({
      key: `seed:${seed}`,
      label: `${seed} Seeds`,
      ...folded
    });
  }
  return rows;
}

export function buildRoundPerformanceRows(
  teams: LeaderboardApiPayload["teams"],
  numTeams: number
): AnalyticsActAggregateRow[] {
  const buckets = new Map<number, LeaderboardOwnerPlayerMetrics[]>();
  for (const p of allDraftedPlayers(teams)) {
    const po = resolvedPickOverall(p);
    if (po == null) continue;
    const dr = draftRoundFromPickOverall(po, numTeams);
    if (dr == null || dr < 1) continue;
    const m = metricsForPlayer(p);
    const list = buckets.get(dr) ?? [];
    list.push(m);
    buckets.set(dr, list);
  }
  const rows: AnalyticsActAggregateRow[] = [];
  const sortedRounds = [...buckets.keys()].sort((a, b) => a - b);
  for (const r of sortedRounds) {
    const players = buckets.get(r)!;
    const folded = foldMetrics(players);
    rows.push({
      key: `draftRound:${r}`,
      label: `Round ${r}`,
      ...folded
    });
  }
  return rows;
}
