"use client";

import type { ReactNode } from "react";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronDown, ChevronUp, Circle, Radio } from "lucide-react";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import {
  readStoredStatTrackerShowInlineRanks,
  readStoredStatTrackerShowTppgColumns,
  writeStoredActiveLeagueId,
  writeStoredStatTrackerShowInlineRanks,
  writeStoredStatTrackerShowTppgColumns
} from "@/lib/player-pool-storage";
import type { StatTrackerApiResponse } from "@/lib/stat-tracker/build-stat-tracker-response";
import { readJsonResponse } from "@/lib/read-json-response";
import { espnMensCollegeBasketballPlayerProfileUrl } from "@/lib/espn-mbb-directory";
import { PoolResponsiveOwnerNameText } from "@/components/stats/PoolResponsiveDisplayNames";
import { PoolTablePlayerPhotoCell, PoolTableTeamLogoCell } from "@/components/stats/PoolTableMediaCells";
import { HeatBadgeLegend } from "@/components/stats/HeatBadgeLegend";
import { PlayerHeatBadge } from "@/components/stats/PlayerHeatBadge";
import { computeHeatBadgeInfo } from "@/lib/player-heat-badge";
import {
  readCommissionerSecretFromSession,
  readPlayerPoolSession,
  PLAYER_POOL_IDENTITY_CHANGE_EVENT
} from "@/lib/player-pool-session";
import { abbreviateOwnerNameForMobile, abbreviatePlayerNameForMobile } from "@/lib/pool-mobile-display-names";
import { useSubscribePullRefresh } from "@/hooks/useSubscribePullRefresh";

type RoundScores = Record<number, number | null | undefined>;

type TrackerPlayerRow = {
  rosterSlotId?: string;
  playerId: string;
  /** ESPN athlete id when known; used for profile links. */
  espnAthleteId: number | null;
  playerName: string;
  position: string | null;
  teamName: string;
  headshotUrls: string[];
  teamLogoUrl: string | null;
  roundScores: RoundScores;
  seed: number | null;
  /** NCAA overall seed / S-curve rank 1–68. */
  overallSeed: number | null;
  region: string;
  seasonPpg: number;
  total: number;
  projection: number;
  originalProjection: number | null;
  eliminated: boolean;
  eliminatedRound: number | null;
  playingInLiveGame: boolean;
};

type TrackerOwnerCard = {
  ownerId: string;
  ownerName: string;
  draftPosition: number;
  players: TrackerPlayerRow[];
};

function formatMaybeNumber(v: number | null | undefined) {
  if (v === null || v === undefined) return "";
  return v;
}

/** Full bracket region for display (South, West, …); expands legacy abbreviations if needed. */
function StatTrackerPlayerNameLink({
  playerName,
  espnAthleteId
}: {
  playerName: string;
  espnAthleteId: number | null;
}) {
  if (espnAthleteId != null && Number.isFinite(espnAthleteId) && espnAthleteId > 0) {
    return (
      <a
        href={espnMensCollegeBasketballPlayerProfileUrl({ espnAthleteId, playerName })}
        target="_blank"
        rel="noopener noreferrer"
        className="pool-table-player-link"
        title={playerName}
      >
        <span className="hidden lg:inline">{playerName}</span>
        <span className="lg:hidden">{abbreviatePlayerNameForMobile(playerName)}</span>
      </a>
    );
  }
  return (
    <span className="font-semibold" title={playerName}>
      <span className="hidden lg:inline">{playerName}</span>
      <span className="lg:hidden">{abbreviatePlayerNameForMobile(playerName)}</span>
    </span>
  );
}

function displayRegionName(region: string): string {
  const r = region?.trim() || "";
  if (!r) return "—";
  switch (r) {
    case "W":
    case "West":
      return "West";
    case "E":
    case "East":
      return "East";
    case "MW":
    case "Midwest":
      return "Midwest";
    case "S":
    case "South":
      return "South";
    default:
      return r;
  }
}

/** e.g. 1 → "1st", 2 → "2nd", 11 → "11th" (standings rank label). */
function ordinalRankLabel(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const abs = Math.abs(n);
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (abs % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function roundPointsNumeric(p: TrackerPlayerRow, displayRound: number): number | null {
  const v = p.roundScores?.[displayRound];
  if (v === null || v === undefined) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function displayRoundScoreCell(p: TrackerPlayerRow, displayRound: number): number | string {
  const er = p.eliminatedRound;
  if (er != null && Number.isFinite(er) && displayRound > er) return "E";
  const v = p.roundScores?.[displayRound];
  if (v !== null && v !== undefined) return v;
  return "";
}

function tournamentPpgNumeric(p: TrackerPlayerRow): number | null {
  let sum = 0;
  let n = 0;
  for (let r = 1; r <= 6; r++) {
    const v = roundPointsNumeric(p, r);
    if (v !== null) {
      sum += v;
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}

function getTppgMinusSeasonInfo(p: TrackerPlayerRow): { text: string; value: number | null } {
  const tournamentPpg = tournamentPpgNumeric(p);
  if (tournamentPpg == null) return { text: "—", value: null };
  const diff = tournamentPpg - p.seasonPpg;
  const sign = diff > 0 ? "+" : "";
  return { text: `${sign}${diff.toFixed(1)}`, value: diff };
}

function getProjectionPlusMinusInfo(
  liveRounded: number | null,
  origRounded: number | null
): { text: string; value: number | null } {
  if (liveRounded == null || origRounded == null) return { text: "—", value: null };
  const diff = liveRounded - origRounded;
  const sign = diff > 0 ? "+" : "";
  return { text: `${sign}${diff}`, value: diff };
}

/** Chicago-style title case: first & last word capitalized; short conjunctions/prepositions lowercased mid-phrase. */
const BOOK_TITLE_MINOR = new Set([
  "a",
  "an",
  "the",
  "and",
  "but",
  "or",
  "nor",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "to",
  "vs",
  "vs."
]);

function toBookTitleCase(phrase: string): string {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return phrase;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return words
    .map((raw, i) => {
      const lower = raw.toLowerCase();
      if (i === 0 || i === words.length - 1) return cap(lower);
      if (BOOK_TITLE_MINOR.has(lower)) return lower;
      return cap(lower);
    })
    .join(" ");
}

function computeDisplayTournamentPpg(p: TrackerPlayerRow) {
  const tournamentPpg = tournamentPpgNumeric(p);
  return tournamentPpg == null ? p.seasonPpg : tournamentPpg;
}

function computeOwnerFromPlayers(players: TrackerPlayerRow[]) {
  const ownerRoundScores: Record<number, number | undefined> = {};
  for (let r = 1; r <= 6; r++) {
    const vals = players
      .map((p) => p.roundScores?.[r])
      .filter((v): v is number => v !== null && v !== undefined);
    ownerRoundScores[r] = vals.length === 0 ? undefined : vals.reduce((a, b) => a + b, 0);
  }

  let total = 0;
  for (let r = 1; r <= 6; r++) {
    total += ownerRoundScores[r] ?? 0;
  }

  const remainingPlayers = players.filter((p) => p.playingInLiveGame).length;

  const allProjectionsKnown = players.every((p) => p.projection != null && Number.isFinite(p.projection));
  const projection = allProjectionsKnown
    ? players.reduce((sum, p) => sum + Math.round(p.projection), 0)
    : null;

  return { ownerRoundScores, total, projection, remainingPlayers };
}

type FooterTotals = {
  roundScores: Record<number, number | undefined>;
  totalPts: number;
  liveProjSum: number | null;
  origProjSum: string;
  tppgDeltaSum: number;
  tppgDeltaHasAny: boolean;
  projDiffSum: number;
  projDiffHasAny: boolean;
  seasonPpgAvg: string;
  tppgAvg: string;
  /** Roster players whose college team is still in the tournament (respects table filters). */
  remainingPlayers: number;
  /** Roster players whose team advanced through the league’s current tournament round (respects filters). */
  advancedCount: number;
  /** Players currently in a live game (respects table filters). */
  livePlayingCount: number;
};

/** Aligns league `currentRound` with advancement logic (pre-tournament → R1). */
function displayTournamentRoundForAdvancement(currentRound: number): number {
  return currentRound <= 0 ? 1 : currentRound;
}

/**
 * True if the player’s team survived the current NCAA display round (lost in a later round
 * or not eliminated yet).
 */
function playerAdvancedThroughCurrentRound(p: TrackerPlayerRow, currentRound: number): boolean {
  const R = displayTournamentRoundForAdvancement(currentRound);
  const er = p.eliminatedRound;
  if (er == null) {
    return !p.eliminated;
  }
  return er > R;
}

/**
 * Heuristic win and “in the money” (top 3) probabilities for a cohort of owners.
 * StatTracker passes the **full league** so Owner-filter visibility does not change these numbers.
 *
 * **Per-owner signal (min–max normalized across the cohort, then blended):**
 * - **Projection** (~52%): summed live projection when every roster player has one; otherwise
 *   current tournament points as a fallback “expected strength” proxy.
 * - **Still alive** (~28%): share of roster whose team is not eliminated (`remaining / roster size`).
 * - **Advanced** (~20%): share of roster that advanced through the league’s current round.
 *
 * **Model:** weights = `0.025 + exp(composite × 2.35)` (strictly positive). **Win %** =
 * `weight_i / Σ weights` (same as first pick under Plackett–Luce). **In the money %** =
 * probability of finishing in the top `min(3, n)` slots under sequential Plackett–Luce
 * sampling (recursive, exact for small n).
 */
function computeOwnerWinAndTop3Probabilities(
  owners: TrackerOwnerCard[],
  currentRound: number
): Map<string, { winPct: number; top3Pct: number }> {
  const out = new Map<string, { winPct: number; top3Pct: number }>();
  const n = owners.length;
  if (n === 0) return out;

  const projOrTotal: number[] = [];
  const fracRem: number[] = [];
  const fracAdv: number[] = [];

  for (const o of owners) {
    const c = computeOwnerFromPlayers(o.players);
    const sz = o.players.length;
    const remN = sz === 0 ? 0 : o.players.filter((p) => !p.eliminated).length;
    const advN =
      sz === 0 ? 0 : o.players.filter((p) => playerAdvancedThroughCurrentRound(p, currentRound)).length;
    const p =
      c.projection != null && Number.isFinite(c.projection) ? c.projection : c.total;
    projOrTotal.push(p);
    fracRem.push(sz === 0 ? 0 : remN / sz);
    fracAdv.push(sz === 0 ? 0 : advN / sz);
  }

  const minMaxNorm = (xs: number[]): number[] => {
    const mn = Math.min(...xs);
    const mx = Math.max(...xs);
    const d = mx - mn || 1;
    return xs.map((x) => (x - mn) / d);
  };

  const nP = minMaxNorm(projOrTotal);
  const nR = minMaxNorm(fracRem);
  const nA = minMaxNorm(fracAdv);

  const W_PROJ = 0.52;
  const W_REM = 0.28;
  const W_ADV = 0.2;
  const EXP_SCALE = 2.35;

  const strengths = owners.map((_, i) => W_PROJ * nP[i] + W_REM * nR[i] + W_ADV * nA[i]);
  const weights = strengths.map((s) => 0.025 + Math.exp(s * EXP_SCALE));
  const sumW = weights.reduce((a, b) => a + b, 0);

  const kMoney = Math.min(3, n);
  const activeAll = owners.map((_, i) => i);

  function probInTopK(targetIndex: number, k: number, active: number[]): number {
    if (k <= 0) return 0;
    if (active.length === 0) return 0;
    if (!active.includes(targetIndex)) return 0;
    const sw = active.reduce((acc, i) => acc + weights[i], 0);
    if (sw <= 0) return 1 / active.length;

    let p = 0;
    for (const j of active) {
      const pickJ = weights[j] / sw;
      if (j === targetIndex) {
        p += pickJ;
      } else {
        p += pickJ * probInTopK(targetIndex, k - 1, active.filter((x) => x !== j));
      }
    }
    return p;
  }

  for (let i = 0; i < n; i++) {
    out.set(owners[i].ownerId, {
      winPct: (weights[i] / sumW) * 100,
      top3Pct: probInTopK(i, kMoney, activeAll) * 100
    });
  }

  return out;
}

function playerRowKey(p: TrackerPlayerRow): string {
  const sid = p.rosterSlotId != null ? String(p.rosterSlotId).trim() : "";
  if (sid) return sid;
  return String(p.playerId);
}

/**
 * Competition ranking among drafted league roster: rank 1 = best (highest value).
 * Ties share the same rank; next rank skips (e.g. 1, 1, 3). Players without a
 * comparable value are omitted from that category’s map.
 */
function ranksHigherIsBetter(
  players: TrackerPlayerRow[],
  getValue: (p: TrackerPlayerRow) => number | null
): Map<string, number> {
  const scored: { key: string; value: number }[] = [];
  for (const p of players) {
    const v = getValue(p);
    if (v != null && Number.isFinite(v)) {
      scored.push({ key: playerRowKey(p), value: v });
    }
  }
  scored.sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const map = new Map<string, number>();
  let i = 0;
  while (i < scored.length) {
    const v = scored[i].value;
    let j = i + 1;
    while (j < scored.length && scored[j].value === v) j++;
    const rank = i + 1;
    for (let k = i; k < j; k++) map.set(scored[k].key, rank);
    i = j;
  }
  return map;
}

/** Lower numeric value ranks better (regional seed, NCAA overall seed). */
function ranksLowerIsBetter(
  players: TrackerPlayerRow[],
  getValue: (p: TrackerPlayerRow) => number | null
): Map<string, number> {
  const scored: { key: string; value: number }[] = [];
  for (const p of players) {
    const v = getValue(p);
    if (v != null && Number.isFinite(v)) {
      scored.push({ key: playerRowKey(p), value: v });
    }
  }
  scored.sort((a, b) => a.value - b.value || a.key.localeCompare(b.key));
  const map = new Map<string, number>();
  let i = 0;
  while (i < scored.length) {
    const v = scored[i].value;
    let j = i + 1;
    while (j < scored.length && scored[j].value === v) j++;
    const rank = i + 1;
    for (let k = i; k < j; k++) map.set(scored[k].key, rank);
    i = j;
  }
  return map;
}

type LeagueStatRanks = {
  draftedCount: number;
  seed: Map<string, number>;
  overallSeed: Map<string, number>;
  tppgDelta: Map<string, number>;
  ppg: Map<string, number>;
  tppg: Map<string, number>;
  r1: Map<string, number>;
  r2: Map<string, number>;
  r3: Map<string, number>;
  r4: Map<string, number>;
  r5: Map<string, number>;
  r6: Map<string, number>;
  total: Map<string, number>;
  origProj: Map<string, number>;
  liveProj: Map<string, number>;
  projPlusMinus: Map<string, number>;
};

function buildLeagueStatRanks(players: TrackerPlayerRow[]): LeagueStatRanks {
  const empty = (): LeagueStatRanks => ({
    draftedCount: 0,
    seed: new Map(),
    overallSeed: new Map(),
    tppgDelta: new Map(),
    ppg: new Map(),
    tppg: new Map(),
    r1: new Map(),
    r2: new Map(),
    r3: new Map(),
    r4: new Map(),
    r5: new Map(),
    r6: new Map(),
    total: new Map(),
    origProj: new Map(),
    liveProj: new Map(),
    projPlusMinus: new Map()
  });
  if (players.length === 0) return empty();
  return {
    draftedCount: players.length,
    seed: ranksLowerIsBetter(players, (p) => (p.seed != null && Number.isFinite(p.seed) ? p.seed : null)),
    overallSeed: ranksLowerIsBetter(players, (p) =>
      p.overallSeed != null && Number.isFinite(p.overallSeed) ? p.overallSeed : null
    ),
    tppgDelta: ranksHigherIsBetter(players, (p) => getTppgMinusSeasonInfo(p).value),
    ppg: ranksHigherIsBetter(players, (p) => p.seasonPpg),
    tppg: ranksHigherIsBetter(players, (p) => computeDisplayTournamentPpg(p)),
    r1: ranksHigherIsBetter(players, (p) => roundPointsNumeric(p, 1)),
    r2: ranksHigherIsBetter(players, (p) => roundPointsNumeric(p, 2)),
    r3: ranksHigherIsBetter(players, (p) => roundPointsNumeric(p, 3)),
    r4: ranksHigherIsBetter(players, (p) => roundPointsNumeric(p, 4)),
    r5: ranksHigherIsBetter(players, (p) => roundPointsNumeric(p, 5)),
    r6: ranksHigherIsBetter(players, (p) => roundPointsNumeric(p, 6)),
    total: ranksHigherIsBetter(players, (p) => p.total),
    origProj: ranksHigherIsBetter(players, (p) =>
      p.originalProjection != null && Number.isFinite(p.originalProjection)
        ? Math.round(p.originalProjection)
        : null
    ),
    liveProj: ranksHigherIsBetter(players, (p) =>
      Number.isFinite(p.projection) ? Math.round(p.projection) : null
    ),
    projPlusMinus: ranksHigherIsBetter(players, (p) => {
      const liveR = Math.round(p.projection);
      const origR =
        p.originalProjection != null && Number.isFinite(p.originalProjection)
          ? Math.round(p.originalProjection)
          : null;
      return getProjectionPlusMinusInfo(liveR, origR).value;
    })
  };
}

/** Gold sub-rank under stat value (databallr-style inline rank cue). */
function InlineLeagueStatRank({
  rank,
  draftedCount,
  context = "player-league"
}: {
  rank: number | undefined;
  draftedCount: number;
  /** `owner-aggregate` = this roster’s total vs other owners (footer row). */
  context?: "player-league" | "owner-aggregate";
}) {
  if (rank == null || draftedCount <= 0) return null;
  const title =
    context === "owner-aggregate"
      ? `Owner rank ${rank} of ${draftedCount} teams (1 = best)`
      : `League rank ${rank} of ${draftedCount} drafted players (1 = best)`;
  return (
    <span
      className="pool-inline-rank block text-[9px] sm:text-[10px] font-bold tabular-nums leading-none mt-0.5 text-[rgb(var(--pool-stats-accent))]"
      title={title}
    >
      {rank}
    </span>
  );
}

function StatCellWithRank({
  children,
  rank,
  draftedCount,
  className,
  showRank = true,
  rankContext = "player-league"
}: {
  children: ReactNode;
  rank: number | undefined;
  draftedCount: number;
  className?: string;
  /** When false, gold league rank subtext is hidden (same idea as hiding projection columns). */
  showRank?: boolean;
  rankContext?: "player-league" | "owner-aggregate";
}) {
  return (
    <div className={className ?? "flex flex-col items-center justify-center"}>
      {children}
      {showRank ? (
        <InlineLeagueStatRank rank={rank} draftedCount={draftedCount} context={rankContext} />
      ) : null}
    </div>
  );
}

function computeFooterTotals(visible: TrackerPlayerRow[], currentRound: number): FooterTotals {
  const roundScores: Record<number, number | undefined> = {};
  for (let r = 1; r <= 6; r++) {
    const vals = visible
      .map((p) => p.roundScores?.[r])
      .filter((v): v is number => v !== null && v !== undefined);
    roundScores[r] = vals.length === 0 ? undefined : vals.reduce((a, b) => a + b, 0);
  }

  const totalPts = visible.reduce((s, p) => s + p.total, 0);
  const remainingPlayers = visible.filter((p) => !p.eliminated).length;
  const advancedCount = visible.filter((p) => playerAdvancedThroughCurrentRound(p, currentRound)).length;
  const livePlayingCount = visible.filter((p) => p.playingInLiveGame).length;

  let liveProjSum: number | null = null;
  if (visible.length > 0 && visible.every((p) => Number.isFinite(p.projection))) {
    liveProjSum = visible.reduce((s, p) => s + Math.round(p.projection), 0);
  }

  let origProjSum = "—";
  if (visible.length > 0 && visible.every((p) => p.originalProjection != null && Number.isFinite(p.originalProjection))) {
    origProjSum = String(visible.reduce((s, p) => s + Math.round(p.originalProjection!), 0));
  }

  let tppgDeltaSum = 0;
  let tppgDeltaHasAny = false;
  for (const p of visible) {
    const pm = getTppgMinusSeasonInfo(p);
    if (pm.value != null) {
      tppgDeltaSum += pm.value;
      tppgDeltaHasAny = true;
    }
  }

  let projDiffSum = 0;
  let projDiffHasAny = false;
  for (const p of visible) {
    const liveR = Math.round(p.projection);
    const o = p.originalProjection;
    if (o != null && Number.isFinite(o)) {
      projDiffSum += liveR - Math.round(o);
      projDiffHasAny = true;
    }
  }

  const seasonPpgAvg =
    visible.length > 0 ? (visible.reduce((s, p) => s + p.seasonPpg, 0) / visible.length).toFixed(1) : "—";

  let tppgSum = 0;
  let tppgN = 0;
  for (const p of visible) {
    const t = tournamentPpgNumeric(p);
    if (t != null) {
      tppgSum += t;
      tppgN += 1;
    }
  }
  const tppgAvg = tppgN > 0 ? (tppgSum / tppgN).toFixed(1) : "—";

  return {
    roundScores,
    totalPts,
    liveProjSum,
    origProjSum,
    tppgDeltaSum,
    tppgDeltaHasAny,
    projDiffSum,
    projDiffHasAny,
    seasonPpgAvg,
    tppgAvg,
    remainingPlayers,
    advancedCount,
    livePlayingCount
  };
}

/** Numeric owner-roster totals for the same filters as the table (for owner-vs-owner ranks). */
type OwnerFooterNumeric = {
  remainingPlayers: number | null;
  advancedCount: number | null;
  livePlayingCount: number | null;
  seedSum: number | null;
  overallSeedSum: number | null;
  tppgDeltaSum: number | null;
  seasonPpgAvg: number | null;
  tppgAvg: number | null;
  r1: number | null;
  r2: number | null;
  r3: number | null;
  r4: number | null;
  r5: number | null;
  r6: number | null;
  totalPts: number | null;
  origProjSum: number | null;
  liveProjSum: number | null;
  projDiffSum: number | null;
};

function getOwnerVisiblePlayers(
  owner: TrackerOwnerCard,
  showOnlyActivePlayers: boolean,
  selectedCollegeTeams: string[],
  teamSet: Set<string>
): TrackerPlayerRow[] {
  const base = showOnlyActivePlayers ? owner.players.filter((p) => p.playingInLiveGame) : owner.players;
  if (selectedCollegeTeams.length === 0) return [];
  return base.filter((p) => teamSet.has(p.teamName));
}

function computeOwnerFooterNumericMetrics(visible: TrackerPlayerRow[], currentRound: number): OwnerFooterNumeric {
  if (visible.length === 0) {
    return {
      remainingPlayers: null,
      advancedCount: null,
      livePlayingCount: null,
      seedSum: null,
      overallSeedSum: null,
      tppgDeltaSum: null,
      seasonPpgAvg: null,
      tppgAvg: null,
      r1: null,
      r2: null,
      r3: null,
      r4: null,
      r5: null,
      r6: null,
      totalPts: null,
      origProjSum: null,
      liveProjSum: null,
      projDiffSum: null
    };
  }

  const footer = computeFooterTotals(visible, currentRound);
  const hasAnySeed = visible.some((p) => p.seed != null);
  const seedSum = hasAnySeed ? visible.reduce((s, p) => s + (p.seed ?? 0), 0) : null;
  const hasAnyOverallSeed = visible.some((p) => p.overallSeed != null);
  const overallSeedSum = hasAnyOverallSeed
    ? visible.reduce((s, p) => s + (p.overallSeed ?? 0), 0)
    : null;

  const seasonPpgAvg =
    footer.seasonPpgAvg === "—" ? null : Number.parseFloat(footer.seasonPpgAvg);
  const seasonOk = seasonPpgAvg != null && Number.isFinite(seasonPpgAvg) ? seasonPpgAvg : null;

  const tppgAvgParsed = footer.tppgAvg === "—" ? null : Number.parseFloat(footer.tppgAvg);
  const tppgOk = tppgAvgParsed != null && Number.isFinite(tppgAvgParsed) ? tppgAvgParsed : null;

  const origProjSum =
    footer.origProjSum !== "—" ? Number.parseInt(footer.origProjSum, 10) : null;
  const origOk = origProjSum != null && Number.isFinite(origProjSum) ? origProjSum : null;

  return {
    remainingPlayers: footer.remainingPlayers,
    advancedCount: footer.advancedCount,
    livePlayingCount: footer.livePlayingCount,
    seedSum,
    overallSeedSum,
    tppgDeltaSum: footer.tppgDeltaHasAny ? footer.tppgDeltaSum : null,
    seasonPpgAvg: seasonOk,
    tppgAvg: tppgOk,
    r1: footer.roundScores[1] ?? null,
    r2: footer.roundScores[2] ?? null,
    r3: footer.roundScores[3] ?? null,
    r4: footer.roundScores[4] ?? null,
    r5: footer.roundScores[5] ?? null,
    r6: footer.roundScores[6] ?? null,
    totalPts: footer.totalPts,
    origProjSum: origOk,
    liveProjSum: footer.liveProjSum,
    projDiffSum: footer.projDiffHasAny ? footer.projDiffSum : null
  };
}

type OwnerRankBundle = { rank: number | undefined; pool: number };

type OwnerVsOwnerFooterRanks = {
  byOwnerId: Map<
    string,
    {
      remainingPlayers: OwnerRankBundle;
      advanced: OwnerRankBundle;
      livePlaying: OwnerRankBundle;
      seed: OwnerRankBundle;
      overallSeedSum: OwnerRankBundle;
      tppgDelta: OwnerRankBundle;
      seasonPpg: OwnerRankBundle;
      tppg: OwnerRankBundle;
      r1: OwnerRankBundle;
      r2: OwnerRankBundle;
      r3: OwnerRankBundle;
      r4: OwnerRankBundle;
      r5: OwnerRankBundle;
      r6: OwnerRankBundle;
      total: OwnerRankBundle;
      origProj: OwnerRankBundle;
      liveProj: OwnerRankBundle;
      projPlusMinus: OwnerRankBundle;
    }
  >;
};

function rankAmongOwners(
  entries: { ownerId: string; value: number | null }[],
  mode: "higher" | "lower"
): Map<string, { rank: number; pool: number }> {
  const eligible = entries.filter(
    (e): e is { ownerId: string; value: number } =>
      e.value != null && Number.isFinite(e.value)
  );
  eligible.sort((a, b) => {
    const cmp =
      mode === "higher"
        ? b.value - a.value || a.ownerId.localeCompare(b.ownerId)
        : a.value - b.value || a.ownerId.localeCompare(b.ownerId);
    return cmp;
  });
  const out = new Map<string, { rank: number; pool: number }>();
  const pool = eligible.length;
  let i = 0;
  while (i < eligible.length) {
    const v = eligible[i].value;
    let j = i + 1;
    while (j < eligible.length && eligible[j].value === v) j++;
    const rank = i + 1;
    for (let k = i; k < j; k++) out.set(eligible[k].ownerId, { rank, pool });
    i = j;
  }
  return out;
}

function bundle(
  map: Map<string, { rank: number; pool: number }>,
  ownerId: string
): OwnerRankBundle {
  const hit = map.get(ownerId);
  return { rank: hit?.rank, pool: hit?.pool ?? 0 };
}

function buildOwnerVsOwnerFooterRanks(
  owners: TrackerOwnerCard[],
  showOnlyActivePlayers: boolean,
  selectedCollegeTeams: string[],
  teamSet: Set<string>,
  currentRound: number
): OwnerVsOwnerFooterRanks {
  const metricsByOwner = owners.map((o) => ({
    ownerId: o.ownerId,
    m: computeOwnerFooterNumericMetrics(
      getOwnerVisiblePlayers(o, showOnlyActivePlayers, selectedCollegeTeams, teamSet),
      currentRound
    )
  }));

  const seedR = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.seedSum })),
    "lower"
  );
  const overallSeedSumR = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.overallSeedSum })),
    "lower"
  );
  const remainingR = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.remainingPlayers })),
    "higher"
  );
  const advancedR = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.advancedCount })),
    "higher"
  );
  const livePlayingR = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.livePlayingCount })),
    "higher"
  );
  const tppgDR = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.tppgDeltaSum })),
    "higher"
  );
  const seasonR = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.seasonPpgAvg })),
    "higher"
  );
  const tppgR = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.tppgAvg })),
    "higher"
  );
  const r1 = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.r1 })),
    "higher"
  );
  const r2 = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.r2 })),
    "higher"
  );
  const r3 = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.r3 })),
    "higher"
  );
  const r4 = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.r4 })),
    "higher"
  );
  const r5 = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.r5 })),
    "higher"
  );
  const r6 = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.r6 })),
    "higher"
  );
  const totalR = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.totalPts })),
    "higher"
  );
  const origR = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.origProjSum })),
    "higher"
  );
  const liveR = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.liveProjSum })),
    "higher"
  );
  const pmR = rankAmongOwners(
    metricsByOwner.map(({ ownerId, m }) => ({ ownerId, value: m.projDiffSum })),
    "higher"
  );

  const byOwnerId = new Map<
    string,
    {
      remainingPlayers: OwnerRankBundle;
      advanced: OwnerRankBundle;
      livePlaying: OwnerRankBundle;
      seed: OwnerRankBundle;
      overallSeedSum: OwnerRankBundle;
      tppgDelta: OwnerRankBundle;
      seasonPpg: OwnerRankBundle;
      tppg: OwnerRankBundle;
      r1: OwnerRankBundle;
      r2: OwnerRankBundle;
      r3: OwnerRankBundle;
      r4: OwnerRankBundle;
      r5: OwnerRankBundle;
      r6: OwnerRankBundle;
      total: OwnerRankBundle;
      origProj: OwnerRankBundle;
      liveProj: OwnerRankBundle;
      projPlusMinus: OwnerRankBundle;
    }
  >();

  for (const { ownerId } of metricsByOwner) {
    byOwnerId.set(ownerId, {
      remainingPlayers: bundle(remainingR, ownerId),
      advanced: bundle(advancedR, ownerId),
      livePlaying: bundle(livePlayingR, ownerId),
      seed: bundle(seedR, ownerId),
      overallSeedSum: bundle(overallSeedSumR, ownerId),
      tppgDelta: bundle(tppgDR, ownerId),
      seasonPpg: bundle(seasonR, ownerId),
      tppg: bundle(tppgR, ownerId),
      r1: bundle(r1, ownerId),
      r2: bundle(r2, ownerId),
      r3: bundle(r3, ownerId),
      r4: bundle(r4, ownerId),
      r5: bundle(r5, ownerId),
      r6: bundle(r6, ownerId),
      total: bundle(totalR, ownerId),
      origProj: bundle(origR, ownerId),
      liveProj: bundle(liveR, ownerId),
      projPlusMinus: bundle(pmR, ownerId)
    });
  }

  return { byOwnerId };
}

function StatTrackerTabPageInner() {
  const sp = useSearchParams();
  const leagueId = useMemo(() => sp.get("leagueId")?.trim() || undefined, [sp]);

  useEffect(() => {
    if (leagueId) writeStoredActiveLeagueId(leagueId);
  }, [leagueId]);

  const [api, setApi] = useState<StatTrackerApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [authHint, setAuthHint] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!leagueId) return;
    setError(null);
    try {
      const res = await fetch(`/api/stat-tracker/${encodeURIComponent(leagueId)}`, {
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      const json = await readJsonResponse<StatTrackerApiResponse & { error?: string }>(res, "StatTracker");
      if (!res.ok) throw new Error(json.error ?? `Failed: ${res.status}`);
      setApi(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, [leagueId]);

  const pullLiveIfAuthed = useCallback(async (): Promise<boolean> => {
    if (!leagueId) return false;
    const sb = createBrowserSupabaseClient();
    const { data: sess } =
      sb != null ? await sb.auth.getSession() : { data: { session: null as null } };
    const token = sess?.session?.access_token;
    if (!token) return false;

    const res = await fetch(`/api/stat-tracker/${encodeURIComponent(leagueId)}/live-sync`, {
      method: "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    const json = await readJsonResponse<StatTrackerApiResponse & { error?: string }>(res, "StatTracker live-sync");
    if (!res.ok) throw new Error(json.error ?? `Refresh failed: ${res.status}`);
    setApi(json);
    setAuthHint(null);
    return true;
  }, [leagueId]);

  const tick = useCallback(async () => {
    if (!leagueId) return;
    try {
      const pulled = await pullLiveIfAuthed();
      if (!pulled) await loadData();
    } catch {
      await loadData();
    }
  }, [leagueId, loadData, pullLiveIfAuthed]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!leagueId) return;
    const sb = createBrowserSupabaseClient();
    if (!sb) return;
    const ch = sb
      .channel(`stat_lb:${leagueId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "league_live_scoreboard",
          filter: `league_id=eq.${leagueId}`
        },
        () => void loadData()
      )
      .subscribe();
    return () => {
      void sb.removeChannel(ch);
    };
  }, [leagueId, loadData]);

  const pollMs = api?.anyLiveGames ? 20_000 : 45_000;
  useEffect(() => {
    if (!leagueId) return;
    const id = window.setInterval(() => void tick(), pollMs);
    return () => window.clearInterval(id);
  }, [leagueId, pollMs, tick]);

  const owners: TrackerOwnerCard[] = useMemo(() => {
    if (!api) return [];
    return api.owners.map((o) => ({
      ownerId: o.leagueTeamId,
      ownerName: o.ownerName,
      draftPosition: o.draftPosition,
      players: o.players.map((p) => ({
        rosterSlotId: p.rosterSlotId,
        playerId: String(p.playerId),
        espnAthleteId: p.espnAthleteId ?? null,
        playerName: p.playerName,
        position: p.position ?? null,
        teamName: p.teamName,
        headshotUrls: p.headshotUrls ?? [],
        teamLogoUrl: p.teamLogoUrl ?? null,
        roundScores: p.roundScores,
        seed: p.seed,
        overallSeed: p.overallSeed ?? null,
        region: p.region ?? "",
        seasonPpg: p.seasonPpg,
        total: p.total,
        projection: p.projection,
        originalProjection: p.originalProjection,
        eliminated: p.eliminated,
        eliminatedRound: p.eliminatedRound ?? null,
        playingInLiveGame: p.playingInLiveGame
      }))
    }));
  }, [api]);

  const ownersSorted = useMemo(() => [...owners].sort((a, b) => a.draftPosition - b.draftPosition), [owners]);

  const leagueDraftedPlayers = useMemo(
    () => ownersSorted.flatMap((o) => o.players),
    [ownersSorted]
  );

  const leagueStatRanks = useMemo(
    () => buildLeagueStatRanks(leagueDraftedPlayers),
    [leagueDraftedPlayers]
  );

  const [openByOwnerId, setOpenByOwnerId] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setOpenByOwnerId((prev) => {
      const next = { ...prev };
      for (const o of ownersSorted) {
        if (next[o.ownerId] === undefined) next[o.ownerId] = true;
      }
      return next;
    });
  }, [ownersSorted]);

  const allOwnersCollapsed = useMemo(
    () =>
      ownersSorted.length > 0 &&
      ownersSorted.every((o) => !(openByOwnerId[o.ownerId] ?? true)),
    [ownersSorted, openByOwnerId]
  );

  const setAllOwnersCollapsed = useCallback((collapsed: boolean) => {
    setOpenByOwnerId((prev) => {
      const next = { ...prev };
      for (const o of ownersSorted) {
        next[o.ownerId] = !collapsed;
      }
      return next;
    });
  }, [ownersSorted]);

  const [selectedOwnerIds, setSelectedOwnerIds] = useState<string[]>([]);
  useEffect(() => {
    if (ownersSorted.length === 0) return;
    setSelectedOwnerIds((prev) => (prev.length === 0 ? ownersSorted.map((o) => o.ownerId) : prev));
  }, [ownersSorted]);

  const selectedOwnerIdSet = useMemo(() => new Set(selectedOwnerIds), [selectedOwnerIds]);
  const selectedOwners = useMemo(
    () => ownersSorted.filter((o) => selectedOwnerIdSet.has(o.ownerId)),
    [ownersSorted, selectedOwnerIdSet]
  );

  const [sessionTeamId, setSessionTeamId] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => setSessionTeamId(readPlayerPoolSession()?.leagueTeamId ?? null);
    sync();
    window.addEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, sync);
    return () => window.removeEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, sync);
  }, []);

  /** Mobile: signed-in owner’s block first for quicker access. */
  const orderedSelectedOwners = useMemo(() => {
    const list = [...selectedOwners];
    if (!sessionTeamId) return list;
    const mine = list.find((o) => o.ownerId === sessionTeamId);
    if (!mine) return list;
    return [mine, ...list.filter((o) => o.ownerId !== sessionTeamId)];
  }, [selectedOwners, sessionTeamId]);

  const [showOnlyActivePlayers, setShowOnlyActivePlayers] = useState(false);

  const collegeTeamOptions = useMemo(() => {
    const set = new Set<string>();
    for (const o of ownersSorted) {
      for (const p of o.players) set.add(p.teamName);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [ownersSorted]);

  const [teamPickerOpen, setTeamPickerOpen] = useState(false);
  const [selectedCollegeTeams, setSelectedCollegeTeams] = useState<string[]>([]);
  const selectedCollegeTeamsSet = useMemo(
    () => new Set(selectedCollegeTeams),
    [selectedCollegeTeams]
  );

  const ownerVsOwnerFooterRanks = useMemo(
    () =>
      buildOwnerVsOwnerFooterRanks(
        ownersSorted,
        showOnlyActivePlayers,
        selectedCollegeTeams,
        selectedCollegeTeamsSet,
        api?.currentRound ?? 0
      ),
    [ownersSorted, showOnlyActivePlayers, selectedCollegeTeams, selectedCollegeTeamsSet, api?.currentRound]
  );

  const allTeamsSelected = useMemo(
    () => collegeTeamOptions.length > 0 && selectedCollegeTeams.length === collegeTeamOptions.length,
    [collegeTeamOptions.length, selectedCollegeTeams.length]
  );

  const didInitTeamsRef = useRef(false);
  useEffect(() => {
    if (didInitTeamsRef.current) return;
    if (collegeTeamOptions.length === 0) return;
    setSelectedCollegeTeams(collegeTeamOptions);
    didInitTeamsRef.current = true;
  }, [collegeTeamOptions]);

  const teamButtonRef = useRef<HTMLButtonElement | null>(null);
  const [teamPickerPos, setTeamPickerPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  function openTeamPicker() {
    const rect = teamButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTeamPickerPos({
      top: rect.bottom + 8,
      left: rect.left,
      width: rect.width
    });
    setTeamPickerOpen(true);
  }

  function closeTeamPicker() {
    setTeamPickerOpen(false);
  }

  function toggleTeamPicker() {
    if (teamPickerOpen) closeTeamPicker();
    else openTeamPicker();
  }

  const ownerButtonRef = useRef<HTMLButtonElement | null>(null);
  const [ownerPickerOpen, setOwnerPickerOpen] = useState(false);
  const [ownerPickerPos, setOwnerPickerPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  function openOwnerPicker() {
    const rect = ownerButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setOwnerPickerPos({
      top: rect.bottom + 8,
      left: rect.left,
      width: rect.width
    });
    setOwnerPickerOpen(true);
  }

  function closeOwnerPicker() {
    setOwnerPickerOpen(false);
  }

  function toggleOwnerPicker() {
    if (ownerPickerOpen) closeOwnerPicker();
    else openOwnerPicker();
  }

  const ownerComputedByOwnerId = useMemo(() => {
    const m = new Map<string, ReturnType<typeof computeOwnerFromPlayers>>();
    for (const o of ownersSorted) m.set(o.ownerId, computeOwnerFromPlayers(o.players));
    return m;
  }, [ownersSorted]);

  const rankByOwnerId = useMemo(() => {
    const list = selectedOwners.map((o) => {
      const c = ownerComputedByOwnerId.get(o.ownerId);
      return { ownerId: o.ownerId, ownerName: o.ownerName, total: c?.total ?? 0 };
    });

    list.sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return a.ownerName.localeCompare(b.ownerName);
    });

    const m = new Map<string, number>();
    list.forEach((it, idx) => m.set(it.ownerId, idx + 1));
    return m;
  }, [selectedOwners, ownerComputedByOwnerId]);

  /** Among selected owners, by summed live projections (full roster; requires all players to have a projection). */
  const projectedRankByOwnerId = useMemo(() => {
    const list = selectedOwners.map((o) => {
      const c = ownerComputedByOwnerId.get(o.ownerId);
      return { ownerId: o.ownerId, ownerName: o.ownerName, proj: c?.projection ?? null };
    });
    const eligible = list.filter(
      (x): x is { ownerId: string; ownerName: string; proj: number } =>
        x.proj != null && Number.isFinite(x.proj)
    );
    eligible.sort((a, b) => {
      if (b.proj !== a.proj) return b.proj - a.proj;
      return a.ownerName.localeCompare(b.ownerName);
    });
    const m = new Map<string, number>();
    eligible.forEach((it, idx) => m.set(it.ownerId, idx + 1));
    return m;
  }, [selectedOwners, ownerComputedByOwnerId]);

  /** Win % / In the money % always use the full league — not the Owner filter subset. */
  const ownerOutcomeProbsByOwnerId = useMemo(
    () => computeOwnerWinAndTop3Probabilities(ownersSorted, api?.currentRound ?? 0),
    [ownersSorted, api?.currentRound]
  );

  /** Ranks for Win % / Money % among all league owners (same full-league cohort as the model). */
  const outcomeProbRanksByOwnerId = useMemo(() => {
    const winEntries = ownersSorted.map((o) => {
      const prob = ownerOutcomeProbsByOwnerId.get(o.ownerId);
      return { ownerId: o.ownerId, value: prob != null ? prob.winPct : null };
    });
    const moneyEntries = ownersSorted.map((o) => {
      const prob = ownerOutcomeProbsByOwnerId.get(o.ownerId);
      return { ownerId: o.ownerId, value: prob != null ? prob.top3Pct : null };
    });
    const winR = rankAmongOwners(winEntries, "higher");
    const moneyR = rankAmongOwners(moneyEntries, "higher");
    const m = new Map<string, { winPct: OwnerRankBundle; moneyPct: OwnerRankBundle }>();
    for (const o of ownersSorted) {
      m.set(o.ownerId, {
        winPct: bundle(winR, o.ownerId),
        moneyPct: bundle(moneyR, o.ownerId)
      });
    }
    return m;
  }, [ownersSorted, ownerOutcomeProbsByOwnerId]);

  const collapsedOwnerRowMeasureRef = useRef<HTMLDivElement | null>(null);
  const [collapsedOwnerStripWidthPx, setCollapsedOwnerStripWidthPx] = useState(0);

  useLayoutEffect(() => {
    const wrap = collapsedOwnerRowMeasureRef.current;
    if (!wrap || selectedOwners.length === 0) {
      setCollapsedOwnerStripWidthPx(0);
      return;
    }
    const rankSlot = wrap.querySelector("[data-measure-rank]");
    const nameSlot = wrap.querySelector("[data-measure-name]");
    if (!rankSlot || !nameSlot) return;
    /** Match expanded header name cap (~14rem); same full name for every strip. */
    const MAX_OWNER_STRIP_PX = 224;
    let max = 0;
    const mobile =
      typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
    for (const o of selectedOwners) {
      const r = rankByOwnerId.get(o.ownerId) ?? 0;
      rankSlot.textContent = ordinalRankLabel(r);
      nameSlot.textContent = mobile ? abbreviateOwnerNameForMobile(o.ownerName) : o.ownerName;
      max = Math.max(max, wrap.offsetWidth);
    }
    setCollapsedOwnerStripWidthPx(Math.min(Math.ceil(max), MAX_OWNER_STRIP_PX));
  }, [selectedOwners, rankByOwnerId]);

  const [showTppgColumns, setShowTppgColumns] = useState(true);
  const [showInlineRanks, setShowInlineRanks] = useState(true);

  const [commissionerSession, setCommissionerSession] = useState(false);
  useEffect(() => {
    const sync = () => setCommissionerSession(readCommissionerSecretFromSession().length > 0);
    sync();
    window.addEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, sync);
    return () => window.removeEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, sync);
  }, []);

  useEffect(() => {
    setShowTppgColumns(readStoredStatTrackerShowTppgColumns());
    setShowInlineRanks(readStoredStatTrackerShowInlineRanks());
  }, []);

  useEffect(() => {
    writeStoredStatTrackerShowTppgColumns(showTppgColumns);
  }, [showTppgColumns]);

  useEffect(() => {
    writeStoredStatTrackerShowInlineRanks(showInlineRanks);
  }, [showInlineRanks]);

  /**
   * UI toggle labeled "Show projections".
   * Historically it only controlled the TPPG columns; it now also controls the projection block at the end:
   * Orig / Live / +/−.
   */
  const showProjectionColumns = showTppgColumns;

  const TABLE_COLS = showProjectionColumns ? 18 : 13;
  const projBlockDivider = showProjectionColumns ? " pool-table-col-total-divider" : "";

  async function onManualRefresh() {
    setRefreshBusy(true);
    setError(null);
    try {
      const pulled = await pullLiveIfAuthed();
      if (!pulled) {
        setAuthHint("Sign in to pull live NCAA scores. Showing cached pool data.");
        await loadData();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Refresh failed");
      await loadData();
    } finally {
      setRefreshBusy(false);
    }
  }

  useSubscribePullRefresh(() => void onManualRefresh(), Boolean(leagueId));

  const [heroPulse, setHeroPulse] = useState(false);
  const lastSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    const at = api?.lastSyncedAt ?? null;
    if (!at || at === lastSyncedRef.current) return;
    lastSyncedRef.current = at;
    setHeroPulse(true);
    const t = window.setTimeout(() => setHeroPulse(false), 700);
    return () => window.clearTimeout(t);
  }, [api?.lastSyncedAt]);

  const collapsedOwnerStripWidthStyle =
    collapsedOwnerStripWidthPx > 0
      ? ({ width: collapsedOwnerStripWidthPx, maxWidth: collapsedOwnerStripWidthPx } as const)
      : ({ minWidth: "min(8.5rem, 36vw)", maxWidth: "min(8.5rem, 36vw)" } as const);

  return (
    <div className="pool-page-stack pool-page-stack-tight">
      <div
        ref={collapsedOwnerRowMeasureRef}
        className="pointer-events-none fixed left-0 top-0 -z-[999] flex items-center gap-1 whitespace-nowrap px-2 opacity-0"
        aria-hidden
      >
        <span
          data-measure-rank
          className="pool-owner-rank min-w-[2.25rem] shrink-0 text-left text-xs font-semibold tabular-nums"
        />
        <span data-measure-name className="pool-owner-name shrink-0 text-sm font-semibold" />
      </div>
      <div className="pool-hero pool-hero-databallr">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-3">
          <div className="flex items-center gap-2.5 md:gap-3 min-w-0">
            <div
              className="h-9 w-9 shrink-0 rounded-md bg-accent/15 border border-accent/40 flex items-center justify-center"
              aria-hidden
            >
              <Radio className="h-4 w-4 text-accent" />
            </div>
            <div className="min-w-0">
              <h1 className="stat-tracker-page-title">StatTracker</h1>
              {api?.lastSyncedAt ? (
                <>
                  <div
                    className={[
                      "text-[10px] tabular-nums text-foreground/50 mt-0.5 hidden md:block",
                      heroPulse ? "motion-safe:animate-pulse" : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    Synced {new Date(api.lastSyncedAt).toLocaleString()}
                    {api.anyLiveGames ? (
                      <span className="ml-1.5 text-emerald-500 font-semibold">· Live ×{api.liveGamesCount}</span>
                    ) : null}
                  </div>
                  <div
                    className={[
                      "md:hidden mt-0.5 flex items-center gap-1 text-[9px] font-semibold text-emerald-500/90",
                      heroPulse ? "motion-safe:animate-pulse" : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {api.anyLiveGames ? (
                      <>
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                        </span>
                        <span>Live</span>
                      </>
                    ) : (
                      <span className="text-foreground/40 font-normal">Pull down to refresh</span>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-[10px] text-foreground/45 mt-0.5 hidden md:block">
                  Live R1–R6 scoring &amp; projections
                </div>
              )}
            </div>
          </div>
          <div className="hidden md:flex flex-wrap items-center gap-1.5 shrink-0">
            <button
              type="button"
              className="pool-btn-outline-cta pool-btn-outline-cta--sm"
              disabled={!leagueId || refreshBusy}
              onClick={() => void onManualRefresh()}
            >
              {refreshBusy ? "…" : "Refresh Data"}
            </button>
          </div>
        </div>
        {commissionerSession && (
          <div
            className="mt-1.5 pt-2 border-t border-border/25 text-[10px] text-foreground/55 whitespace-nowrap overflow-hidden text-ellipsis hidden md:block"
            title="R1–R6 from player box scores after each NCAA sync. While games are live, signed-in users trigger refresh about every 20s (rate-limited per league)."
          >
            <strong className="text-foreground/80 font-bold">Commissioner Note:</strong>{" "}
            Box scores post-sync; ~20s live refresh when signed in (per-league cap).
          </div>
        )}
      </div>

      {!leagueId && (
        <div className="pool-alert pool-alert-compact">
          Add <code className="text-[10px]">?leagueId=…</code> from Draft to load scores.
        </div>
      )}

      {error && <div className="pool-alert-danger pool-alert-compact">{error}</div>}

      {authHint && <div className="pool-alert pool-alert-compact">{authHint}</div>}

      {api?.partialDataWarning && (
        <div className="rounded-md border border-warning/45 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning leading-snug">
          <strong>Stale sync</strong>{" "}
          <span className="md:hidden">— pull down to refresh (signed in) or wait for auto-refresh.</span>
          <span className="hidden md:inline">— use Refresh Data (signed in) or wait for auto-refresh.</span>
        </div>
      )}

      {leagueId && api && owners.length === 0 && (
        <div className="pool-alert pool-alert-compact">
          No roster yet.{" "}
          <Link href={`/draft?leagueId=${encodeURIComponent(leagueId)}`} className="pool-link">
            Open Draft
          </Link>
        </div>
      )}

      <div className="pool-panel pool-panel-compact min-w-0">
        <div className="pool-filter-toolbar">
          <label className="pool-filter-chip">
            <input
              type="checkbox"
              checked={showOnlyActivePlayers}
              onChange={() => setShowOnlyActivePlayers((v) => !v)}
            />
            <span>Active Only</span>
          </label>
          <label
            className="pool-filter-chip"
            title="Checked: show projection-related columns (TPPG, TPPG−PPG, Orig, Live, and projection +/−). Unchecked: hide them for a more compact table."
          >
            <input
              type="checkbox"
              checked={showTppgColumns}
              onChange={(e) => setShowTppgColumns(e.target.checked)}
            />
            <span>{toBookTitleCase("show projections")}</span>
          </label>
          <label
            className="pool-filter-chip"
            title="Checked: gold league ranks under stat values and owner-aggregate footer ranks. Seed and Overall never use inline ranks."
          >
            <input
              type="checkbox"
              checked={showInlineRanks}
              onChange={(e) => setShowInlineRanks(e.target.checked)}
            />
            <span>{toBookTitleCase("show inline ranks")}</span>
          </label>
          {ownersSorted.length > 0 ? (
            <label
              className="pool-filter-chip"
              title="Checked: every owner shows the compact summary row only. Unchecked: full roster tables."
            >
              <input
                type="checkbox"
                checked={allOwnersCollapsed}
                onChange={(e) => setAllOwnersCollapsed(e.target.checked)}
              />
              <span>{toBookTitleCase("collapse all")}</span>
            </label>
          ) : null}
          <div className="pool-filter-select">
            <span className="pool-filter-label">Owner</span>
            <button
              ref={ownerButtonRef}
              type="button"
              onClick={toggleOwnerPicker}
              className={
                selectedOwnerIds.length > 0 && selectedOwnerIds.length === ownersSorted.length
                  ? "pool-filter-select-trigger pool-filter-select-trigger--all"
                  : "pool-filter-select-trigger"
              }
            >
              <span className="pool-filter-select-trigger-text">
                {selectedOwnerIds.length === 0 ? (
                  toBookTitleCase("none")
                ) : selectedOwnerIds.length === ownersSorted.length ? (
                  toBookTitleCase("all")
                ) : selectedOwnerIds.length === 1 ? (
                  (() => {
                    const nm = ownersSorted.find((o) => o.ownerId === selectedOwnerIds[0])?.ownerName;
                    return nm ? <PoolResponsiveOwnerNameText full={nm} /> : `1 ${toBookTitleCase("selected")}`;
                  })()
                ) : (
                  `${selectedOwnerIds.length} ${toBookTitleCase("selected")}`
                )}
              </span>
              <ChevronDown className="size-3 shrink-0 opacity-45" strokeWidth={2.25} aria-hidden />
            </button>
          </div>
          <div className="pool-filter-select">
            <span className="pool-filter-label">Team</span>
            <button
              ref={teamButtonRef}
              type="button"
              onClick={toggleTeamPicker}
              className={
                selectedCollegeTeams.length > 0 && allTeamsSelected
                  ? "pool-filter-select-trigger pool-filter-select-trigger--all"
                  : "pool-filter-select-trigger"
              }
            >
              <span className="pool-filter-select-trigger-text">
                {selectedCollegeTeams.length === 0
                  ? toBookTitleCase("none")
                  : allTeamsSelected
                    ? toBookTitleCase("all")
                    : selectedCollegeTeams.length === 1
                      ? selectedCollegeTeams[0]
                      : `${selectedCollegeTeams.length} ${toBookTitleCase("selected")}`}
              </span>
              <ChevronDown className="size-3 shrink-0 opacity-45" strokeWidth={2.25} aria-hidden />
            </button>
            {teamPickerOpen && teamPickerPos && (
              <>
                <div className="pool-modal-overlay" onClick={closeTeamPicker} />
                <div
                  className="pool-modal-sheet max-h-[360px] overflow-y-auto"
                  style={{
                    top: teamPickerPos.top,
                    left: teamPickerPos.left,
                    width: Math.max(220, Math.min(360, teamPickerPos.width))
                  }}
                >
                  <div className="flex gap-2 mb-2">
                    <button
                      type="button"
                      onClick={() => setSelectedCollegeTeams(collegeTeamOptions)}
                      disabled={allTeamsSelected}
                      className="pool-btn-ghost flex-1"
                    >
                      {toBookTitleCase("all")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedCollegeTeams([])}
                      disabled={selectedCollegeTeams.length === 0}
                      className="pool-btn-ghost flex-1"
                    >
                      {toBookTitleCase("none")}
                    </button>
                  </div>
                  <div>
                    {collegeTeamOptions.map((t) => {
                      const checked = selectedCollegeTeamsSet.has(t);
                      return (
                        <label key={t} className="pool-picker-row w-full">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setSelectedCollegeTeams((prev) =>
                                prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
                              )
                            }
                          />
                          <span className="truncate">{t}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
          {ownerPickerOpen && ownerPickerPos && (
            <>
              <div className="pool-modal-overlay" onClick={closeOwnerPicker} />
              <div
                className="pool-modal-sheet max-h-[360px] overflow-y-auto"
                style={{
                  top: ownerPickerPos.top,
                  left: ownerPickerPos.left,
                  width: Math.max(220, Math.min(360, ownerPickerPos.width))
                }}
              >
                <div className="flex gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => setSelectedOwnerIds(ownersSorted.map((o) => o.ownerId))}
                    className="pool-btn-ghost flex-1"
                  >
                    {toBookTitleCase("all")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedOwnerIds([])}
                    className="pool-btn-ghost flex-1"
                  >
                    {toBookTitleCase("none")}
                  </button>
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {ownersSorted.map((o) => {
                    const checked = selectedOwnerIdSet.has(o.ownerId);
                    return (
                      <label key={o.ownerId} className="pool-picker-row w-full">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setSelectedOwnerIds((prev) =>
                              prev.includes(o.ownerId)
                                ? prev.filter((id) => id !== o.ownerId)
                                : [...prev, o.ownerId]
                            )
                          }
                        />
                        <span className="truncate">
                          <PoolResponsiveOwnerNameText full={o.ownerName} />
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </>
          )}
          <HeatBadgeLegend className="ml-auto" />
        </div>
      </div>

      <div className="min-w-0">
      {orderedSelectedOwners.map((owner) => {
        const isOpen = openByOwnerId[owner.ownerId] ?? true;
        const rank = rankByOwnerId.get(owner.ownerId) ?? 0;
        const projectedRank = projectedRankByOwnerId.get(owner.ownerId);
        const outcomeProb = ownerOutcomeProbsByOwnerId.get(owner.ownerId);
        const visiblePlayers = showOnlyActivePlayers
          ? owner.players.filter((p) => p.playingInLiveGame)
          : owner.players;

        const visiblePlayersAfterTeamFilter =
          selectedCollegeTeams.length === 0
            ? []
            : visiblePlayers.filter((p) => selectedCollegeTeamsSet.has(p.teamName));

        const footer = computeFooterTotals(visiblePlayersAfterTeamFilter, api?.currentRound ?? 0);

        const seedSum = visiblePlayersAfterTeamFilter.reduce((sum, p) => sum + (p.seed ?? 0), 0);
        const overallSum = visiblePlayersAfterTeamFilter.reduce((sum, p) => sum + (p.overallSeed ?? 0), 0);
        const hasAnySeed = visiblePlayersAfterTeamFilter.some((p) => p.seed != null);
        const hasAnyOverall = visiblePlayersAfterTeamFilter.some((p) => p.overallSeed != null);
        const seedFooterOnly: ReactNode =
          visiblePlayersAfterTeamFilter.length === 0 || !hasAnySeed ? (
            "—"
          ) : (
            <span className="tabular-nums font-semibold">{seedSum}</span>
          );
        const overallFooterOnly: ReactNode =
          visiblePlayersAfterTeamFilter.length === 0 || !hasAnyOverall ? (
            "—"
          ) : (
            <span className="tabular-nums font-semibold">{overallSum}</span>
          );

        const tppgFooterText =
          footer.tppgDeltaHasAny
            ? `${footer.tppgDeltaSum > 0 ? "+" : ""}${footer.tppgDeltaSum.toFixed(1)}`
            : "—";
        const tppgFooterClass =
          footer.tppgDeltaHasAny && footer.tppgDeltaSum !== 0
            ? footer.tppgDeltaSum > 0
              ? "text-success"
              : "text-danger"
            : "";

        const projFooterText =
          footer.projDiffHasAny
            ? `${footer.projDiffSum > 0 ? "+" : ""}${footer.projDiffSum}`
            : "—";
        const projFooterClass =
          footer.projDiffHasAny && footer.projDiffSum !== 0
            ? footer.projDiffSum > 0
              ? "text-success"
              : "text-danger"
            : "";

        const fo = ownerVsOwnerFooterRanks.byOwnerId.get(owner.ownerId)!;
        const outcomeProbRanks = outcomeProbRanksByOwnerId.get(owner.ownerId);

        const ownerToggle = () => setOpenByOwnerId((prev) => ({ ...prev, [owner.ownerId]: !isOpen }));

        const collapsedSummaryTable = (
          <div className="pool-collapsed-summary-table-wrap min-w-0 flex-1 max-w-full">
            <table className="pool-table pool-table-flush pool-table-collapsed-summary w-full">
              <thead>
                <tr>
                  <th className="text-center" title="Roster players whose team is still in the tournament">
                    Remain
                  </th>
                  <th
                    className="text-center pool-table-col-group-end"
                    title="Players whose team advanced through the league’s current tournament round (survived that round)"
                  >
                    Adv
                  </th>
                  <th className="text-center">R1</th>
                  <th className="text-center">R2</th>
                  <th className="text-center">R3</th>
                  <th className="text-center">R4</th>
                  <th className="text-center">R5</th>
                  <th className="text-center">R6</th>
                  <th className="text-center pool-table-col-primary">Total</th>
                  <th
                    className="text-center"
                    title="Standings rank among selected owners by summed live projections when every roster player has a projection"
                  >
                    Rank
                  </th>
                  {showProjectionColumns ? <th className="text-center">Orig</th> : null}
                  {showProjectionColumns ? <th className="text-center">Live</th> : null}
                  {showProjectionColumns ? <th className="text-center pool-table-col-group-end">+/−</th> : null}
                  <th
                    className="text-center"
                    title="Model over all league owners: Plackett–Luce weights from live projection (or points fallback), roster share still alive, and share advanced through current round — not affected by Owner filter"
                  >
                    Win %
                  </th>
                  <th
                    className="text-center"
                    title="Estimated chance to finish in the top 3 among all league owners (top min(3,n) if fewer than 3 teams in the league) — not affected by Owner filter"
                  >
                    Money %
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr className="pool-table-row">
                  <td className="px-1 py-1 text-center font-semibold text-foreground align-middle">
                    <StatCellWithRank
                      showRank={showInlineRanks}
                      rank={fo.remainingPlayers.rank}
                      draftedCount={fo.remainingPlayers.pool}
                      rankContext="owner-aggregate"
                    >
                      {footer.remainingPlayers}
                    </StatCellWithRank>
                  </td>
                  <td className="px-1 py-1 text-center font-semibold text-foreground align-middle pool-table-col-group-end">
                    <StatCellWithRank
                      showRank={showInlineRanks}
                      rank={fo.advanced.rank}
                      draftedCount={fo.advanced.pool}
                      rankContext="owner-aggregate"
                    >
                      {footer.advancedCount}
                    </StatCellWithRank>
                  </td>
                  <td className="px-1 py-1 text-center font-semibold text-foreground sleeper-score-font align-middle">
                    <StatCellWithRank
                      showRank={showInlineRanks}
                      rank={fo.r1.rank}
                      draftedCount={fo.r1.pool}
                      rankContext="owner-aggregate"
                    >
                      {formatMaybeNumber(footer.roundScores[1])}
                    </StatCellWithRank>
                  </td>
                  <td className="px-1 py-1 text-center font-semibold text-foreground sleeper-score-font align-middle">
                    <StatCellWithRank
                      showRank={showInlineRanks}
                      rank={fo.r2.rank}
                      draftedCount={fo.r2.pool}
                      rankContext="owner-aggregate"
                    >
                      {formatMaybeNumber(footer.roundScores[2])}
                    </StatCellWithRank>
                  </td>
                  <td className="px-1 py-1 text-center font-semibold text-foreground sleeper-score-font align-middle">
                    <StatCellWithRank
                      showRank={showInlineRanks}
                      rank={fo.r3.rank}
                      draftedCount={fo.r3.pool}
                      rankContext="owner-aggregate"
                    >
                      {formatMaybeNumber(footer.roundScores[3])}
                    </StatCellWithRank>
                  </td>
                  <td className="px-1 py-1 text-center font-semibold text-foreground sleeper-score-font align-middle">
                    <StatCellWithRank
                      showRank={showInlineRanks}
                      rank={fo.r4.rank}
                      draftedCount={fo.r4.pool}
                      rankContext="owner-aggregate"
                    >
                      {formatMaybeNumber(footer.roundScores[4])}
                    </StatCellWithRank>
                  </td>
                  <td className="px-1 py-1 text-center font-semibold text-foreground sleeper-score-font align-middle">
                    <StatCellWithRank
                      showRank={showInlineRanks}
                      rank={fo.r5.rank}
                      draftedCount={fo.r5.pool}
                      rankContext="owner-aggregate"
                    >
                      {formatMaybeNumber(footer.roundScores[5])}
                    </StatCellWithRank>
                  </td>
                  <td className="px-1 py-1 text-center font-semibold text-foreground sleeper-score-font align-middle">
                    <StatCellWithRank
                      showRank={showInlineRanks}
                      rank={fo.r6.rank}
                      draftedCount={fo.r6.pool}
                      rankContext="owner-aggregate"
                    >
                      {formatMaybeNumber(footer.roundScores[6])}
                    </StatCellWithRank>
                  </td>
                  <td
                    className={`px-1 py-1 text-center font-semibold sleeper-score-font pool-table-col-primary align-middle${projBlockDivider}`}
                  >
                    <StatCellWithRank
                      showRank={showInlineRanks}
                      rank={fo.total.rank}
                      draftedCount={fo.total.pool}
                      rankContext="owner-aggregate"
                    >
                      {footer.totalPts}
                    </StatCellWithRank>
                  </td>
                  <td className="px-1 py-1 text-center font-semibold text-foreground tabular-nums align-middle">
                    {projectedRank != null ? ordinalRankLabel(projectedRank) : "—"}
                  </td>
                  {showProjectionColumns ? (
                    <td className="px-1 py-1 text-center font-semibold sleeper-score-font align-middle">
                      <StatCellWithRank
                        showRank={showInlineRanks}
                        rank={fo.origProj.rank}
                        draftedCount={fo.origProj.pool}
                        rankContext="owner-aggregate"
                      >
                        {footer.origProjSum}
                      </StatCellWithRank>
                    </td>
                  ) : null}
                  {showProjectionColumns ? (
                    <td className="px-1 py-1 text-center font-semibold sleeper-score-font align-middle">
                      <StatCellWithRank
                        showRank={showInlineRanks}
                        rank={fo.liveProj.rank}
                        draftedCount={fo.liveProj.pool}
                        rankContext="owner-aggregate"
                      >
                        {footer.liveProjSum != null ? String(footer.liveProjSum) : "—"}
                      </StatCellWithRank>
                    </td>
                  ) : null}
                  {showProjectionColumns ? (
                    <td className="px-1 py-1 text-center font-semibold sleeper-score-font align-middle pool-table-col-group-end">
                      <StatCellWithRank
                        showRank={showInlineRanks}
                        rank={fo.projPlusMinus.rank}
                        draftedCount={fo.projPlusMinus.pool}
                        rankContext="owner-aggregate"
                      >
                        <span className={projFooterClass}>{projFooterText}</span>
                      </StatCellWithRank>
                    </td>
                  ) : null}
                  <td className="px-1 py-1 text-center font-semibold text-foreground tabular-nums align-middle">
                    <StatCellWithRank
                      showRank={showInlineRanks}
                      rank={outcomeProbRanks?.winPct.rank}
                      draftedCount={outcomeProbRanks?.winPct.pool ?? 0}
                      rankContext="owner-aggregate"
                    >
                      {outcomeProb != null ? `${outcomeProb.winPct.toFixed(1)}%` : "—"}
                    </StatCellWithRank>
                  </td>
                  <td className="px-1 py-1 text-center font-semibold text-foreground tabular-nums align-middle">
                    <StatCellWithRank
                      showRank={showInlineRanks}
                      rank={outcomeProbRanks?.moneyPct.rank}
                      draftedCount={outcomeProbRanks?.moneyPct.pool ?? 0}
                      rankContext="owner-aggregate"
                    >
                      {outcomeProb != null ? `${outcomeProb.top3Pct.toFixed(1)}%` : "—"}
                    </StatCellWithRank>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        );

        return (
          <div key={owner.ownerId} id={`stat-tracker-owner-${owner.ownerId}`} className="pool-card pool-card-compact">
            {isOpen ? (
              <>
                <button
                  type="button"
                  onClick={ownerToggle}
                  className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md pool-card-header pool-owner-header"
                >
                  <div className="flex min-w-0 items-center gap-1 shrink-0">
                    <div className="text-xs pool-owner-rank min-w-[2.25rem] shrink-0 text-left tabular-nums">
                      {ordinalRankLabel(rank)}
                    </div>
                    <div
                      className="text-sm font-semibold pool-owner-name min-w-0 truncate max-w-[min(100%,14rem)] sm:max-w-[18rem]"
                      title={owner.ownerName}
                    >
                      <PoolResponsiveOwnerNameText full={owner.ownerName} />
                    </div>
                  </div>
                  <div className="pool-owner-header-stat-meta hidden md:flex min-w-0 flex-1 flex-wrap items-baseline justify-end gap-x-1.5 gap-y-0.5 text-right text-[10px] sm:text-[11px] font-normal tabular-nums">
                    {projectedRank != null ? (
                      <span>
                        Projected Rank: {ordinalRankLabel(projectedRank)}
                      </span>
                    ) : null}
                    {projectedRank != null && outcomeProb != null ? (
                      <span className="pool-owner-header-stat-meta-sep select-none" aria-hidden>
                        ·
                      </span>
                    ) : null}
                    {outcomeProb != null ? (
                      <span>Win Probability: {outcomeProb.winPct.toFixed(1)}%</span>
                    ) : null}
                    {outcomeProb != null ? (
                      <span className="pool-owner-header-stat-meta-sep select-none" aria-hidden>
                        ·
                      </span>
                    ) : null}
                    {outcomeProb != null ? (
                      <span>In the Money: {outcomeProb.top3Pct.toFixed(1)}%</span>
                    ) : null}
                  </div>

                  <div className="text-xs flex items-center gap-2 pool-owner-chevron shrink-0">
                    <ChevronUp className="h-4 w-4" />
                  </div>
                </button>

                <div className="mt-1.5 overflow-x-hidden md:overflow-x-auto">
                <table className="pool-table w-full text-xs">
                  <thead>
                    <tr>
                      <th className="w-10 max-md:hidden p-1 text-center" scope="col">
                        <span className="sr-only">Team logo</span>
                      </th>
                      <th className="w-10 p-1 text-center" scope="col">
                        <span className="sr-only">Player photo</span>
                      </th>
                      <th className="text-left min-w-[9rem]" title="Name and position; under — college team and regional bracket">
                        Player
                      </th>
                      <th className="text-center" title="Regional pod seed (1–16 within the bracket)">
                        SEED
                      </th>
                      <th
                        className="text-center pool-table-col-group-end"
                        title="NCAA tournament overall seed (S-curve) 1–68 from the selection committee"
                      >
                        Overall
                      </th>
                      <th className="text-center" title="Season points per game">
                        PPG
                      </th>
                      {showTppgColumns ? (
                        <th
                          className="text-center"
                          title="Tournament Points per Game — average fantasy points per R1–R6 round that has box score data"
                        >
                          TPPG
                        </th>
                      ) : null}
                      {showTppgColumns ? (
                        <th className="text-center" title="Tournament PPG minus season PPG (TPPG − PPG)">
                          +/−
                        </th>
                      ) : null}
                      <th className="text-center">R1</th>
                      <th className="text-center">R2</th>
                      <th className="text-center">R3</th>
                      <th className="text-center">R4</th>
                      <th className="text-center">R5</th>
                      <th className="text-center">R6</th>
                      <th className="text-center pool-table-col-primary">Total</th>
                      {showProjectionColumns ? (
                        <th className="text-center" title="Pre-tournament: season PPG × full chalk expected games">
                          Orig
                        </th>
                      ) : null}
                      {showProjectionColumns ? (
                        <th
                          className="text-center"
                          title="Actual tournament points + season PPG × remaining expected chalk games"
                        >
                          Live
                        </th>
                      ) : null}
                      {showProjectionColumns ? (
                        <th className="text-center w-11" title="Live projection − original projection">
                          +/−
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePlayersAfterTeamFilter.map((p) => {
                      const liveR = Math.round(p.projection);
                      const origR =
                        p.originalProjection != null && Number.isFinite(p.originalProjection)
                          ? Math.round(p.originalProjection)
                          : null;
                      const projPm = getProjectionPlusMinusInfo(liveR, origR);
                      const tppgPm = getTppgMinusSeasonInfo(p);
                      const rowKey = playerRowKey(p);
                      const dc = leagueStatRanks.draftedCount;
                      const heatInfo = computeHeatBadgeInfo(p.roundScores, p.seasonPpg);
                      return (
                        <tr
                          key={p.rosterSlotId ?? p.playerId}
                          className={`cursor-pointer group pool-table-row ${p.eliminated ? "pool-table-row-eliminated" : ""}`}
                        >
                          <PoolTableTeamLogoCell url={p.teamLogoUrl} teamName={p.teamName} />
                          <PoolTablePlayerPhotoCell urls={p.headshotUrls} playerName={p.playerName} />
                          <td className="px-1 py-2 transition-colors text-left align-top">
                            <span className="inline-flex items-baseline gap-1 flex-wrap min-w-0">
                              {p.playingInLiveGame ? (
                                <Circle
                                  className="h-2 w-2 shrink-0 fill-emerald-500 text-emerald-500 self-center"
                                  aria-label="Playing live"
                                />
                              ) : null}
                              <StatTrackerPlayerNameLink
                                playerName={p.playerName}
                                espnAthleteId={p.espnAthleteId}
                              />
                              {p.position ? (
                                <span className="hidden text-[10px] sm:text-[11px] text-foreground/65 font-normal tabular-nums shrink-0 md:inline">
                                  {p.position}
                                </span>
                              ) : null}
                              {heatInfo ? (
                                <PlayerHeatBadge info={heatInfo} seasonPpg={p.seasonPpg} className="shrink-0" />
                              ) : null}
                            </span>
                            <div className="text-[10px] sm:text-[11px] text-foreground/65 mt-1 leading-snug font-normal flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                              <span className="text-foreground/75 font-medium line-clamp-2 min-w-0">{p.teamName}</span>
                              <span className="text-foreground/35" aria-hidden>
                                ·
                              </span>
                              <span className="text-foreground/80">{displayRegionName(p.region)}</span>
                            </div>
                          </td>
                          <td
                            className="px-1 py-2 text-center transition-colors"
                            title={p.seed != null ? `Regional pod seed ${p.seed}` : undefined}
                          >
                            <StatCellWithRank showRank={false} rank={leagueStatRanks.seed.get(rowKey)} draftedCount={dc}>
                              {p.seed != null ? String(p.seed) : "—"}
                            </StatCellWithRank>
                          </td>
                          <td
                            className="px-1 py-2 text-center transition-colors pool-table-col-group-end"
                            title={
                              p.overallSeed != null
                                ? `NCAA overall seed ${p.overallSeed} of 68 (lower is better)`
                                : undefined
                            }
                          >
                            <StatCellWithRank
                              showRank={false}
                              rank={leagueStatRanks.overallSeed.get(rowKey)}
                              draftedCount={dc}
                            >
                              {p.overallSeed != null ? String(p.overallSeed) : "—"}
                            </StatCellWithRank>
                          </td>
                          <td className="px-1 py-2 text-center transition-colors">
                            <StatCellWithRank showRank={showInlineRanks} rank={leagueStatRanks.ppg.get(rowKey)} draftedCount={dc}>
                              {p.seasonPpg.toFixed(1)}
                            </StatCellWithRank>
                          </td>
                          {showTppgColumns ? (
                            <td className="px-1 py-2 text-center text-foreground/80 transition-colors">
                              <StatCellWithRank showRank={showInlineRanks} rank={leagueStatRanks.tppg.get(rowKey)} draftedCount={dc}>
                                {computeDisplayTournamentPpg(p).toFixed(1)}
                              </StatCellWithRank>
                            </td>
                          ) : null}
                          {showTppgColumns ? (
                            <td className="px-1 py-2 text-center transition-colors">
                              <StatCellWithRank
                                showRank={showInlineRanks}
                                rank={leagueStatRanks.tppgDelta.get(rowKey)}
                                draftedCount={dc}
                              >
                                {tppgPm.value == null ? (
                                  tppgPm.text
                                ) : (
                                  <span className={tppgPm.value >= 0 ? "text-success" : "text-danger"}>
                                    {tppgPm.text}
                                  </span>
                                )}
                              </StatCellWithRank>
                            </td>
                          ) : null}
                          <td className="px-1 py-2 text-center transition-colors sleeper-score-font">
                            <StatCellWithRank showRank={showInlineRanks} rank={leagueStatRanks.r1.get(rowKey)} draftedCount={dc}>
                              {displayRoundScoreCell(p, 1)}
                            </StatCellWithRank>
                          </td>
                          <td className="px-1 py-2 text-center transition-colors sleeper-score-font">
                            <StatCellWithRank showRank={showInlineRanks} rank={leagueStatRanks.r2.get(rowKey)} draftedCount={dc}>
                              {displayRoundScoreCell(p, 2)}
                            </StatCellWithRank>
                          </td>
                          <td className="px-1 py-2 text-center transition-colors sleeper-score-font">
                            <StatCellWithRank showRank={showInlineRanks} rank={leagueStatRanks.r3.get(rowKey)} draftedCount={dc}>
                              {displayRoundScoreCell(p, 3)}
                            </StatCellWithRank>
                          </td>
                          <td className="px-1 py-2 text-center transition-colors sleeper-score-font">
                            <StatCellWithRank showRank={showInlineRanks} rank={leagueStatRanks.r4.get(rowKey)} draftedCount={dc}>
                              {displayRoundScoreCell(p, 4)}
                            </StatCellWithRank>
                          </td>
                          <td className="px-1 py-2 text-center transition-colors sleeper-score-font">
                            <StatCellWithRank showRank={showInlineRanks} rank={leagueStatRanks.r5.get(rowKey)} draftedCount={dc}>
                              {displayRoundScoreCell(p, 5)}
                            </StatCellWithRank>
                          </td>
                          <td className="px-1 py-2 text-center transition-colors sleeper-score-font">
                            <StatCellWithRank showRank={showInlineRanks} rank={leagueStatRanks.r6.get(rowKey)} draftedCount={dc}>
                              {displayRoundScoreCell(p, 6)}
                            </StatCellWithRank>
                          </td>
                          <td
                            className={`px-1 py-2 text-center transition-colors sleeper-score-font pool-table-col-primary${projBlockDivider}`}
                          >
                            <StatCellWithRank showRank={showInlineRanks} rank={leagueStatRanks.total.get(rowKey)} draftedCount={dc}>
                              {p.total}
                            </StatCellWithRank>
                          </td>
                          {showProjectionColumns ? (
                            <td className="px-1 py-2 text-center transition-colors sleeper-score-font">
                              <StatCellWithRank
                                showRank={showInlineRanks}
                                rank={leagueStatRanks.origProj.get(rowKey)}
                                draftedCount={dc}
                              >
                                {origR != null ? String(origR) : "—"}
                              </StatCellWithRank>
                            </td>
                          ) : null}
                          {showProjectionColumns ? (
                            <td className="px-1 py-2 text-center transition-colors sleeper-score-font">
                              <StatCellWithRank
                                showRank={showInlineRanks}
                                rank={leagueStatRanks.liveProj.get(rowKey)}
                                draftedCount={dc}
                              >
                                {String(liveR)}
                              </StatCellWithRank>
                            </td>
                          ) : null}
                          {showProjectionColumns ? (
                            <td className="px-1 py-2 text-center transition-colors sleeper-score-font">
                              <StatCellWithRank
                                showRank={showInlineRanks}
                                rank={leagueStatRanks.projPlusMinus.get(rowKey)}
                                draftedCount={dc}
                              >
                                {projPm.value == null ? (
                                  projPm.text
                                ) : (
                                  <span className={projPm.value >= 0 ? "text-success" : "text-danger"}>
                                    {projPm.text}
                                  </span>
                                )}
                              </StatCellWithRank>
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                    {visiblePlayersAfterTeamFilter.length === 0 && (
                      <tr className="pool-table-empty">
                        <td colSpan={TABLE_COLS} className="py-4 text-[11px]">
                          No players match current filters.
                        </td>
                      </tr>
                    )}
                    <tr className="pool-table-footer-row">
                      <td colSpan={2} className="w-10 p-1 px-1 py-2 text-center text-[11px] font-semibold align-middle">
                        TOTALS
                      </td>
                      <td className="px-1 py-2 text-left text-[11px] font-normal tabular-nums opacity-90 align-middle leading-tight">
                        {footer.remainingPlayers} remaining {footer.remainingPlayers === 1 ? "player" : "players"}
                      </td>
                      <td className="px-1 py-2 text-center font-semibold">
                        <StatCellWithRank
                          showRank={false}
                          rank={fo.seed.rank}
                          draftedCount={fo.seed.pool}
                          rankContext="owner-aggregate"
                        >
                          {seedFooterOnly}
                        </StatCellWithRank>
                      </td>
                      <td className="px-1 py-2 text-center font-semibold pool-table-col-group-end">
                        <StatCellWithRank
                          showRank={false}
                          rank={fo.overallSeedSum.rank}
                          draftedCount={fo.overallSeedSum.pool}
                          rankContext="owner-aggregate"
                        >
                          {overallFooterOnly}
                        </StatCellWithRank>
                      </td>
                      <td className="px-1 py-2 text-center font-semibold">
                        <StatCellWithRank
                          showRank={showInlineRanks}
                          rank={fo.seasonPpg.rank}
                          draftedCount={fo.seasonPpg.pool}
                          rankContext="owner-aggregate"
                        >
                          {footer.seasonPpgAvg}
                        </StatCellWithRank>
                      </td>
                      {showTppgColumns ? (
                        <td className="px-1 py-2 text-center font-semibold">
                          <StatCellWithRank
                            showRank={showInlineRanks}
                            rank={fo.tppg.rank}
                            draftedCount={fo.tppg.pool}
                            rankContext="owner-aggregate"
                          >
                            {footer.tppgAvg}
                          </StatCellWithRank>
                        </td>
                      ) : null}
                      {showTppgColumns ? (
                        <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                          <StatCellWithRank
                            showRank={showInlineRanks}
                            rank={fo.tppgDelta.rank}
                            draftedCount={fo.tppgDelta.pool}
                            rankContext="owner-aggregate"
                          >
                            <span className={tppgFooterClass}>{tppgFooterText}</span>
                          </StatCellWithRank>
                        </td>
                      ) : null}
                      <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                        <StatCellWithRank
                          showRank={showInlineRanks}
                          rank={fo.r1.rank}
                          draftedCount={fo.r1.pool}
                          rankContext="owner-aggregate"
                        >
                          {formatMaybeNumber(footer.roundScores[1])}
                        </StatCellWithRank>
                      </td>
                      <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                        <StatCellWithRank
                          showRank={showInlineRanks}
                          rank={fo.r2.rank}
                          draftedCount={fo.r2.pool}
                          rankContext="owner-aggregate"
                        >
                          {formatMaybeNumber(footer.roundScores[2])}
                        </StatCellWithRank>
                      </td>
                      <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                        <StatCellWithRank
                          showRank={showInlineRanks}
                          rank={fo.r3.rank}
                          draftedCount={fo.r3.pool}
                          rankContext="owner-aggregate"
                        >
                          {formatMaybeNumber(footer.roundScores[3])}
                        </StatCellWithRank>
                      </td>
                      <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                        <StatCellWithRank
                          showRank={showInlineRanks}
                          rank={fo.r4.rank}
                          draftedCount={fo.r4.pool}
                          rankContext="owner-aggregate"
                        >
                          {formatMaybeNumber(footer.roundScores[4])}
                        </StatCellWithRank>
                      </td>
                      <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                        <StatCellWithRank
                          showRank={showInlineRanks}
                          rank={fo.r5.rank}
                          draftedCount={fo.r5.pool}
                          rankContext="owner-aggregate"
                        >
                          {formatMaybeNumber(footer.roundScores[5])}
                        </StatCellWithRank>
                      </td>
                      <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                        <StatCellWithRank
                          showRank={showInlineRanks}
                          rank={fo.r6.rank}
                          draftedCount={fo.r6.pool}
                          rankContext="owner-aggregate"
                        >
                          {formatMaybeNumber(footer.roundScores[6])}
                        </StatCellWithRank>
                      </td>
                      <td
                        className={`px-1 py-2 text-center font-semibold sleeper-score-font pool-table-col-primary${projBlockDivider}`}
                      >
                        <StatCellWithRank
                          showRank={showInlineRanks}
                          rank={fo.total.rank}
                          draftedCount={fo.total.pool}
                          rankContext="owner-aggregate"
                        >
                          {footer.totalPts}
                        </StatCellWithRank>
                      </td>
                      {showProjectionColumns ? (
                        <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                          <StatCellWithRank
                            showRank={showInlineRanks}
                            rank={fo.origProj.rank}
                            draftedCount={fo.origProj.pool}
                            rankContext="owner-aggregate"
                          >
                            {footer.origProjSum}
                          </StatCellWithRank>
                        </td>
                      ) : null}
                      {showProjectionColumns ? (
                        <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                          <StatCellWithRank
                            showRank={showInlineRanks}
                            rank={fo.liveProj.rank}
                            draftedCount={fo.liveProj.pool}
                            rankContext="owner-aggregate"
                          >
                            {footer.liveProjSum != null ? String(footer.liveProjSum) : "—"}
                          </StatCellWithRank>
                        </td>
                      ) : null}
                      {showProjectionColumns ? (
                        <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                          <StatCellWithRank
                            showRank={showInlineRanks}
                            rank={fo.projPlusMinus.rank}
                            draftedCount={fo.projPlusMinus.pool}
                            rankContext="owner-aggregate"
                          >
                            <span className={projFooterClass}>{projFooterText}</span>
                          </StatCellWithRank>
                        </td>
                      ) : null}
                    </tr>
                  </tbody>
                </table>
              </div>
              </>
            ) : (
              <div
                role="button"
                tabIndex={0}
                aria-expanded="false"
                aria-label={`Expand roster for ${owner.ownerName}`}
                className="pool-collapsed-owner-strip"
                onClick={ownerToggle}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    ownerToggle();
                  }
                }}
              >
                <div className="pool-collapsed-owner-strip-owner" style={collapsedOwnerStripWidthStyle}>
                  <span className="pool-owner-rank min-w-[2.25rem] shrink-0 text-left text-xs font-semibold tabular-nums">
                    {ordinalRankLabel(rank)}
                  </span>
                  <span
                    className="pool-owner-name min-w-0 flex-1 truncate text-left text-sm font-semibold max-w-[min(100%,14rem)] sm:max-w-[18rem]"
                    title={owner.ownerName}
                  >
                    <PoolResponsiveOwnerNameText full={owner.ownerName} />
                  </span>
                </div>
                {collapsedSummaryTable}
                <div className="pool-collapsed-owner-strip-chevron" aria-hidden>
                  <ChevronDown className="h-4 w-4 shrink-0" />
                </div>
              </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}

export default function StatTrackerTabPage() {
  return (
    <Suspense fallback={null}>
      <StatTrackerTabPageInner />
    </Suspense>
  );
}
