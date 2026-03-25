"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { IceBoxBadge } from "@/components/stats/IceBoxBadge";
import { InMoneyBadge } from "@/components/stats/InMoneyBadge";
import { LeaderboardOwnerBadgesLegend } from "@/components/stats/LeaderboardOwnerBadgesLegend";
import { PoolResponsiveOwnerNameText } from "@/components/stats/PoolResponsiveDisplayNames";
import { ChevronDown, ChevronUp, Trophy } from "lucide-react";
import { useSubscribePullRefresh } from "@/hooks/useSubscribePullRefresh";
import {
  leaderboardSnapshotKey,
  readStoredSnapshot,
  readStoredLeaderboardShowProbabilityOddsColumns,
  readStoredStatTrackerShowInlineRanks,
  readStoredStatTrackerShowTppgColumns,
  writeStoredActiveLeagueId,
  writeStoredSnapshot,
  writeStoredLeaderboardShowProbabilityOddsColumns,
  writeStoredStatTrackerShowInlineRanks,
  writeStoredStatTrackerShowTppgColumns
} from "@/lib/player-pool-storage";
import {
  buildLeaderboardOwnerCategoryRanks,
  bundleRank,
  computeLeaderboardOwnerWinAndTop3Probabilities,
  playerAdvancedThroughCurrentRound,
  projectedRankByTeamId,
  rosterPlayersToOwnerMetrics
} from "@/lib/leaderboard-owner-metrics";
import {
  americanOddsLabelFromWinProbability,
  fractionalOddsLabelFromWinProbability,
  winProbabilityDecimal
} from "@/lib/betting-odds-from-probability";
import type { LeaderboardApiPayload } from "@/lib/scoring/persist-league-scoreboard";
import {
  formatTournamentOuLine,
  tournamentOuFromProjections,
  tournamentOuTooltip
} from "@/lib/tournament-total-ou";

const LeaderboardAllTournamentTeamTable = dynamic(
  () =>
    import("@/components/stats/LeaderboardAllTournamentTeamTable").then(
      (m) => m.LeaderboardAllTournamentTeamTable
    ),
  { ssr: false, loading: () => null }
);

const LeaderboardBestSelectionByRoundTable = dynamic(
  () =>
    import("@/components/stats/LeaderboardAllTournamentTeamTable").then(
      (m) => m.LeaderboardBestSelectionByRoundTable
    ),
  { ssr: false, loading: () => null }
);

const LeaderboardWorstSelectionByRoundTable = dynamic(
  () =>
    import("@/components/stats/LeaderboardAllTournamentTeamTable").then(
      (m) => m.LeaderboardWorstSelectionByRoundTable
    ),
  { ssr: false, loading: () => null }
);

/** Chicago-style title case (matches StatTracker toolbar labels). */
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

type LeaderboardTeamRow = LeaderboardApiPayload["teams"][number];
type LeaderboardSnapshot = {
  data: LeaderboardApiPayload | null;
  etag: string | null;
};

type LeaderboardSortKey =
  | "standingsRank"
  | "owner"
  | "projRank"
  | "winPct"
  | "winOddsRatio"
  | "winAmericanLine"
  | "moneyPct"
  | "tournamentOu"
  | "remain"
  | "adv"
  | "r1"
  | "r2"
  | "r3"
  | "r4"
  | "r5"
  | "r6"
  | "total"
  | "tqsAdjustment"
  | "adjustedTotal"
  | "behindLeader"
  | "origProj"
  | "liveProj"
  | "plusMinus";

const SORT_HEADER_ARIA: Record<LeaderboardSortKey, string> = {
  standingsRank: "standings rank (#)",
  owner: "owner name",
  projRank: "projected rank",
  winPct: "win percentage",
  winOddsRatio: "win odds ratio",
  winAmericanLine: "American win line",
  moneyPct: "money percentage",
  tournamentOu: "tournament total over under",
  remain: "players remaining (REM)",
  adv: "advanced count",
  r1: "round 1 points",
  r2: "round 2 points",
  r3: "round 3 points",
  r4: "round 4 points",
  r5: "round 5 points",
  r6: "round 6 points",
  total: "total points",
  tqsAdjustment: "TQS quality adjustment points",
  adjustedTotal: "adjusted score (ADJ)",
  behindLeader: "points behind leader",
  origProj: "original projection",
  liveProj: "live projection",
  plusMinus: "projection plus minus"
};

function defaultSortDir(key: LeaderboardSortKey): "asc" | "desc" {
  if (key === "standingsRank" || key === "projRank" || key === "owner" || key === "behindLeader") return "asc";
  return "desc";
}

function compareNullableNumbers(a: number | null, b: number | null, mult: number): number {
  const aBad = a == null || !Number.isFinite(a);
  const bBad = b == null || !Number.isFinite(b);
  if (aBad && bBad) return 0;
  if (aBad) return 1;
  if (bBad) return -1;
  const d = (a - b) * mult;
  return d !== 0 ? d : 0;
}

function tieBreakTeams(a: LeaderboardTeamRow, b: LeaderboardTeamRow): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.ownerName.localeCompare(b.ownerName);
}

function roundSortValue(roundScores: Record<number, number> | undefined, r: number): number | null {
  if (!roundScores || !Object.prototype.hasOwnProperty.call(roundScores, r)) return null;
  const v = roundScores[r];
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

function liveProjSortValue(team: LeaderboardTeamRow): number | null {
  if (team.projection != null && Number.isFinite(Number(team.projection))) return Math.round(Number(team.projection));
  return null;
}

/** O/U column: sort by posted line (nearest ½, whole → x.5), not integer-rounded live projection. */
function tournamentOuLineSortValue(team: LeaderboardTeamRow): number | null {
  const ou = tournamentOuFromProjections(team.projectionOriginal, team.projection);
  return ou?.line ?? null;
}

function origProjSortValue(team: LeaderboardTeamRow): number | null {
  if (team.projectionOriginal != null && Number.isFinite(Number(team.projectionOriginal)))
    return Math.round(Number(team.projectionOriginal));
  return null;
}

function totalSortValue(team: LeaderboardTeamRow): number | null {
  const t = team.totalScore;
  if (!Number.isFinite(t)) return null;
  return Math.round(t);
}

function tqsAdjustmentSortValue(team: LeaderboardTeamRow): number | null {
  const n = team.tqsAdjustment;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return n;
}

function adjustedTotalSortValue(team: LeaderboardTeamRow): number | null {
  const n = team.adjustedTotalScore;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.round(n);
}

function formatTqsAdjustmentCell(team: LeaderboardTeamRow): ReactNode {
  const n = team.tqsAdjustment;
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const r = Math.round(n * 10) / 10;
  if (r === 0) return "0";
  const sign = r > 0 ? "+" : "";
  const cls = r > 0 ? "text-success" : "text-danger";
  return <span className={cls}>{`${sign}${r}`}</span>;
}

/** Non-negative gap vs league max total (rounded); 0 = tied for first. */
function pointsBehindLeaderValue(team: LeaderboardTeamRow, leagueMaxTotal: number | null): number | null {
  if (leagueMaxTotal == null || !Number.isFinite(leagueMaxTotal)) return null;
  const t = team.totalScore;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round(leagueMaxTotal) - Math.round(t));
}

function remainAdvSortValues(
  team: LeaderboardTeamRow,
  currentRound: number
): { remain: number | null; adv: number | null } {
  const pl = rosterPlayersToOwnerMetrics(team.players);
  if (pl.length === 0) return { remain: null, adv: null };
  return {
    remain: pl.filter((p) => !p.eliminated).length,
    adv: pl.filter((p) => playerAdvancedThroughCurrentRound(p, currentRound)).length
  };
}

function SortableTh({
  columnKey,
  sortKey,
  sortDir,
  onSort,
  align,
  className,
  title,
  children
}: {
  columnKey: LeaderboardSortKey;
  sortKey: LeaderboardSortKey;
  sortDir: "asc" | "desc";
  onSort: (k: LeaderboardSortKey) => void;
  align: "left" | "center";
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const active = sortKey === columnKey;
  const justify = align === "left" ? "justify-start" : "justify-center";
  const mergedTh = [align === "center" ? "text-center" : "text-left", className].filter(Boolean).join(" ");
  return (
    <th
      scope="col"
      className={mergedTh || undefined}
      title={title}
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(columnKey)}
        className={`inline-flex items-center ${justify} gap-0.5 w-full min-w-0 font-inherit text-inherit bg-transparent border-0 p-0 m-0 cursor-pointer select-none hover:text-[rgb(var(--pool-stats-accent))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgb(var(--pool-stats-accent)/0.55)]`}
        aria-label={`Sort by ${SORT_HEADER_ARIA[columnKey]}`}
      >
        <span className="min-w-0">{children}</span>
        {active ? (
          sortDir === "asc" ? (
            <ChevronUp className="h-3 w-3 shrink-0 opacity-80" strokeWidth={2.5} aria-hidden />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0 opacity-80" strokeWidth={2.5} aria-hidden />
          )
        ) : null}
      </button>
    </th>
  );
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

function teamRoundCell(roundScores: Record<number, number> | undefined, r: number): string {
  const rs = roundScores ?? {};
  if (!Object.prototype.hasOwnProperty.call(rs, r)) return "—";
  const v = rs[r];
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return String(Math.round(n));
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

function InlineOwnerAggregateRank({
  rank,
  pool
}: {
  rank: number | undefined;
  pool: number;
}) {
  if (rank == null || pool <= 0) return null;
  return (
    <span
      className="pool-inline-rank block text-[9px] sm:text-[10px] font-bold tabular-nums leading-none mt-0.5 text-[rgb(var(--pool-stats-accent))]"
      title={`Owner rank ${rank} of ${pool} teams (1 = best)`}
    >
      {rank}
    </span>
  );
}

function StatCellWithOwnerRank({
  children,
  rank,
  pool,
  className,
  showRank = true
}: {
  children: ReactNode;
  rank: number | undefined;
  pool: number;
  className?: string;
  /** When false, gold owner-vs-owner sub-ranks are hidden (“Show Inline Ranks” off). */
  showRank?: boolean;
}) {
  return (
    <div className={className ?? "flex flex-col items-center justify-center"}>
      {children}
      {showRank ? <InlineOwnerAggregateRank rank={rank} pool={pool} /> : null}
    </div>
  );
}

export function LeaderboardTabClient({ leagueId }: { leagueId?: string }) {
  const [data, setData] = useState<LeaderboardApiPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [sortKey, setSortKey] = useState<LeaderboardSortKey>("standingsRank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [showTppgColumns, setShowTppgColumns] = useState(true);
  const [showProbabilityOddsColumns, setShowProbabilityOddsColumns] = useState(true);
  const [showInlineRanks, setShowInlineRanks] = useState(true);
  const [selectedLeagueTeamIds, setSelectedLeagueTeamIds] = useState<string[]>([]);
  const [leaderboardTableOpen, setLeaderboardTableOpen] = useState(true);
  const ownerButtonRef = useRef<HTMLButtonElement | null>(null);
  const [ownerPickerOpen, setOwnerPickerOpen] = useState(false);
  const [ownerPickerPos, setOwnerPickerPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const inFlightRef = useRef(false);
  const loadControllerRef = useRef<AbortController | null>(null);
  const etagRef = useRef<string | null>(null);
  const [unchangedRefreshStreak, setUnchangedRefreshStreak] = useState(0);
  const cacheKey = useMemo(() => (leagueId ? leaderboardSnapshotKey({ leagueId }) : null), [leagueId]);

  useEffect(() => {
    if (leagueId) writeStoredActiveLeagueId(leagueId);
  }, [leagueId]);

  useEffect(() => {
    if (!cacheKey) return;
    const snap = readStoredSnapshot<LeaderboardSnapshot>(cacheKey, 1000 * 60 * 20);
    if (!snap) return;
    if (snap.data) setData(snap.data);
    etagRef.current = snap.etag ?? null;
  }, [cacheKey]);

  useEffect(() => {
    setSortKey("standingsRank");
    setSortDir("asc");
  }, [leagueId]);

  useEffect(() => {
    setSelectedLeagueTeamIds([]);
  }, [leagueId]);

  useEffect(() => {
    setShowTppgColumns(readStoredStatTrackerShowTppgColumns());
    setShowProbabilityOddsColumns(readStoredLeaderboardShowProbabilityOddsColumns());
    setShowInlineRanks(readStoredStatTrackerShowInlineRanks());
  }, []);

  useEffect(() => {
    writeStoredStatTrackerShowTppgColumns(showTppgColumns);
  }, [showTppgColumns]);

  useEffect(() => {
    writeStoredStatTrackerShowInlineRanks(showInlineRanks);
  }, [showInlineRanks]);

  useEffect(() => {
    writeStoredLeaderboardShowProbabilityOddsColumns(showProbabilityOddsColumns);
  }, [showProbabilityOddsColumns]);

  useEffect(() => {
    if (
      !showTppgColumns &&
      (sortKey === "projRank" ||
        sortKey === "origProj" ||
        sortKey === "liveProj" ||
        sortKey === "plusMinus")
    ) {
      setSortKey("standingsRank");
      setSortDir("asc");
    }
  }, [showTppgColumns, sortKey]);

  useEffect(() => {
    if (
      !showProbabilityOddsColumns &&
      (sortKey === "winPct" ||
        sortKey === "winOddsRatio" ||
        sortKey === "winAmericanLine" ||
        sortKey === "moneyPct" ||
        sortKey === "tournamentOu")
    ) {
      setSortKey("standingsRank");
      setSortDir("asc");
    }
  }, [showProbabilityOddsColumns, sortKey]);

  const selectedLeagueTeamIdSet = useMemo(
    () => new Set(selectedLeagueTeamIds),
    [selectedLeagueTeamIds]
  );

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

  const load = useCallback(async (opts?: { manual?: boolean; force?: boolean; silent?: boolean }) => {
    if (!leagueId) return;
    if (inFlightRef.current) {
      // Replace stale in-flight requests to avoid missed initial loads on remounts.
      loadControllerRef.current?.abort();
    }
    const controller = new AbortController();
    loadControllerRef.current = controller;
    inFlightRef.current = true;
    if (opts?.manual) setError(null);
    try {
      const params = new URLSearchParams();
      if (opts?.force) params.set("refresh", "1");
      const qs = params.toString();
      const headers: Record<string, string> = {};
      if (!opts?.force && etagRef.current) headers["If-None-Match"] = etagRef.current;
      const res = await fetch(`/api/leaderboard/${encodeURIComponent(leagueId)}${qs ? `?${qs}` : ""}`, {
        signal: controller.signal,
        headers
      });
      if (res.status === 304) {
        setUnchangedRefreshStreak((n) => n + 1);
        return;
      }
      const json = (await res.json()) as LeaderboardApiPayload & { error?: string };
      if (!res.ok) {
        throw new Error((json as { error?: string })?.error ?? `Failed: ${res.status}`);
      }
      etagRef.current = res.headers.get("etag");
      setUnchangedRefreshStreak(0);
      setData(json);
      if (cacheKey) {
        writeStoredSnapshot<LeaderboardSnapshot>(cacheKey, {
          data: json,
          etag: etagRef.current
        });
      }
    } catch (e: unknown) {
      if ((e as Error)?.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      inFlightRef.current = false;
    }
  }, [leagueId, cacheKey]);

  useEffect(() => {
    if (!leagueId) return;
    void load();
  }, [leagueId, load]);

  useEffect(() => {
    return () => {
      loadControllerRef.current?.abort();
    };
  }, []);

  const pollMs = useMemo(() => {
    const hasLive = Boolean(data?.anyLiveGames);
    if (hasLive) return unchangedRefreshStreak >= 3 ? 30_000 : 15_000;
    return unchangedRefreshStreak >= 2 ? 60_000 : 30_000;
  }, [data?.anyLiveGames, unchangedRefreshStreak]);

  useEffect(() => {
    if (!leagueId) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load({ silent: true });
    }, pollMs);
    return () => window.clearInterval(id);
  }, [leagueId, pollMs, load]);

  async function onManualRefresh() {
    if (!leagueId) return;
    setRefreshBusy(true);
    setError(null);
    try {
      await load({ manual: true, force: true });
    } finally {
      setRefreshBusy(false);
    }
  }

  useSubscribePullRefresh(() => void onManualRefresh(), Boolean(leagueId));

  const [heroPulse, setHeroPulse] = useState(false);
  const lastLbSyncRef = useRef<string | null>(null);
  useEffect(() => {
    const at = data?.lastSyncedAt ?? null;
    if (!at || at === lastLbSyncRef.current) return;
    lastLbSyncRef.current = at;
    setHeroPulse(true);
    const t = window.setTimeout(() => setHeroPulse(false), 700);
    return () => window.clearTimeout(t);
  }, [data?.lastSyncedAt]);

  const teamsSorted = useMemo(() => {
    const list = data?.teams ?? [];
    return [...list].sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.ownerName.localeCompare(b.ownerName);
    });
  }, [data?.teams]);

  useEffect(() => {
    if (teamsSorted.length === 0) return;
    setSelectedLeagueTeamIds((prev) =>
      prev.length === 0 ? teamsSorted.map((t) => t.leagueTeamId) : prev
    );
  }, [teamsSorted]);

  const leaderboardDerived = useMemo(() => {
    if (teamsSorted.length === 0) return null;
    const currentRound = data?.currentRound ?? 0;
    const ownersForProb = teamsSorted.map((t) => ({
      leagueTeamId: t.leagueTeamId,
      players: rosterPlayersToOwnerMetrics(t.players)
    }));
    const outcomeProb = computeLeaderboardOwnerWinAndTop3Probabilities(ownersForProb, currentRound);
    const rowInputs = teamsSorted.map((t) => ({
      leagueTeamId: t.leagueTeamId,
      ownerName: t.ownerName,
      roundScores: t.roundScores,
      totalScore: t.totalScore,
      projection: t.projection,
      projectionOriginal: t.projectionOriginal ?? null,
      players: rosterPlayersToOwnerMetrics(t.players),
      tqsAdjustment: t.tqsAdjustment,
      adjustedTotalScore: t.adjustedTotalScore
    }));
    const categoryRanks = buildLeaderboardOwnerCategoryRanks(rowInputs, currentRound, outcomeProb);
    const projRankByTeamId = projectedRankByTeamId(teamsSorted);
    return { outcomeProb, categoryRanks, projRankByTeamId, currentRound };
  }, [teamsSorted, data?.currentRound]);

  function handleSortClick(key: LeaderboardSortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(defaultSortDir(key));
    }
  }

  const leagueMaxTotalPoints = useMemo(() => {
    if (teamsSorted.length === 0) return null;
    let max = -Infinity;
    for (const t of teamsSorted) {
      if (Number.isFinite(t.totalScore)) max = Math.max(max, t.totalScore);
    }
    return max === -Infinity ? null : max;
  }, [teamsSorted]);

  const displayTeams = useMemo(() => {
    if (teamsSorted.length === 0) return [];
    if (!leaderboardDerived) return teamsSorted;

    const { projRankByTeamId, outcomeProb, currentRound } = leaderboardDerived;
    const mult = sortDir === "asc" ? 1 : -1;

    return [...teamsSorted].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "standingsRank":
          cmp = (a.rank - b.rank) * mult;
          break;
        case "owner":
          cmp = a.ownerName.localeCompare(b.ownerName) * mult;
          break;
        case "projRank":
          cmp = compareNullableNumbers(
            projRankByTeamId.get(a.leagueTeamId) ?? null,
            projRankByTeamId.get(b.leagueTeamId) ?? null,
            mult
          );
          break;
        case "winPct":
        case "winOddsRatio":
        case "winAmericanLine":
          cmp = compareNullableNumbers(
            outcomeProb.get(a.leagueTeamId)?.winPct ?? null,
            outcomeProb.get(b.leagueTeamId)?.winPct ?? null,
            mult
          );
          break;
        case "moneyPct":
          cmp = compareNullableNumbers(
            outcomeProb.get(a.leagueTeamId)?.top3Pct ?? null,
            outcomeProb.get(b.leagueTeamId)?.top3Pct ?? null,
            mult
          );
          break;
        case "tournamentOu":
          cmp = compareNullableNumbers(tournamentOuLineSortValue(a), tournamentOuLineSortValue(b), mult);
          break;
        case "remain": {
          const ra = remainAdvSortValues(a, currentRound);
          const rb = remainAdvSortValues(b, currentRound);
          cmp = compareNullableNumbers(ra.remain, rb.remain, mult);
          break;
        }
        case "adv": {
          const ra = remainAdvSortValues(a, currentRound);
          const rb = remainAdvSortValues(b, currentRound);
          cmp = compareNullableNumbers(ra.adv, rb.adv, mult);
          break;
        }
        case "r1":
          cmp = compareNullableNumbers(roundSortValue(a.roundScores, 1), roundSortValue(b.roundScores, 1), mult);
          break;
        case "r2":
          cmp = compareNullableNumbers(roundSortValue(a.roundScores, 2), roundSortValue(b.roundScores, 2), mult);
          break;
        case "r3":
          cmp = compareNullableNumbers(roundSortValue(a.roundScores, 3), roundSortValue(b.roundScores, 3), mult);
          break;
        case "r4":
          cmp = compareNullableNumbers(roundSortValue(a.roundScores, 4), roundSortValue(b.roundScores, 4), mult);
          break;
        case "r5":
          cmp = compareNullableNumbers(roundSortValue(a.roundScores, 5), roundSortValue(b.roundScores, 5), mult);
          break;
        case "r6":
          cmp = compareNullableNumbers(roundSortValue(a.roundScores, 6), roundSortValue(b.roundScores, 6), mult);
          break;
        case "total":
          cmp = compareNullableNumbers(totalSortValue(a), totalSortValue(b), mult);
          break;
        case "tqsAdjustment":
          cmp = compareNullableNumbers(tqsAdjustmentSortValue(a), tqsAdjustmentSortValue(b), mult);
          break;
        case "adjustedTotal":
          cmp = compareNullableNumbers(adjustedTotalSortValue(a), adjustedTotalSortValue(b), mult);
          break;
        case "behindLeader":
          cmp = compareNullableNumbers(
            pointsBehindLeaderValue(a, leagueMaxTotalPoints),
            pointsBehindLeaderValue(b, leagueMaxTotalPoints),
            mult
          );
          break;
        case "origProj":
          cmp = compareNullableNumbers(origProjSortValue(a), origProjSortValue(b), mult);
          break;
        case "liveProj":
          cmp = compareNullableNumbers(liveProjSortValue(a), liveProjSortValue(b), mult);
          break;
        case "plusMinus": {
          const pa = getProjectionPlusMinusInfo(liveProjSortValue(a), origProjSortValue(a)).value;
          const pb = getProjectionPlusMinusInfo(liveProjSortValue(b), origProjSortValue(b)).value;
          cmp = compareNullableNumbers(pa, pb, mult);
          break;
        }
        default:
          break;
      }
      if (cmp !== 0) return cmp;
      return tieBreakTeams(a, b);
    });
  }, [teamsSorted, leaderboardDerived, sortKey, sortDir, leagueMaxTotalPoints]);

  const visibleTeams = useMemo(
    () => displayTeams.filter((t) => selectedLeagueTeamIdSet.has(t.leagueTeamId)),
    [displayTeams, selectedLeagueTeamIdSet]
  );

  const tableColumnCount =
    2 + 2 + 6 + 2 + (showTppgColumns ? 4 : 0) + 2 + (showProbabilityOddsColumns ? 5 : 0);

  const roundLiveLabel = data?.currentRound
    ? data.currentRound === 0
      ? "1"
      : String(data.currentRound)
    : null;

  return (
    <div className="pool-page-stack pool-page-stack-tight">
      <div className="pool-hero pool-hero-databallr">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-3">
          <div className="flex items-center gap-2.5 md:gap-3 min-w-0">
            <div
              className="h-9 w-9 shrink-0 rounded-md bg-accent/15 border border-accent/40 flex items-center justify-center"
              aria-hidden
            >
              <Trophy className="h-4 w-4 text-accent" />
            </div>
            <div className="min-w-0">
              <h1 className="stat-tracker-page-title">Leaderboard</h1>
              {data?.lastSyncedAt ? (
                <>
                  <div className={`text-[10px] tabular-nums text-foreground/50 mt-0.5 hidden md:block ${heroPulse ? "motion-safe:animate-pulse" : ""}`}>
                    Synced {new Date(data.lastSyncedAt).toLocaleString()}
                    {data.anyLiveGames ? (
                      <span className="ml-1.5 text-emerald-500 font-semibold">· Live ×{data.liveGamesCount}</span>
                    ) : null}
                  </div>
                  <div
                    className={`md:hidden mt-0.5 flex items-center gap-1 text-[9px] font-semibold text-emerald-500/90 ${heroPulse ? "motion-safe:animate-pulse" : ""}`}
                  >
                    {data.anyLiveGames ? (
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
                <div className="text-[10px] text-foreground/45 mt-0.5 hidden md:block">Live leaderboard status</div>
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
        <div className="mt-1.5 pt-2 border-t border-border/25 text-[10px] text-foreground/45 hidden md:block">
          Owner standings, round-by-round scoring, projections, and win/money probabilities.
          {roundLiveLabel != null ? (
            <span className="ml-1.5 tabular-nums">· Round live R{roundLiveLabel}</span>
          ) : null}
        </div>
      </div>

      {data?.partialDataWarning && (
        <div className="rounded-md border border-warning/45 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning leading-snug">
          <strong>Stale sync</strong>{" "}
          <span className="md:hidden">
            — scores may lag during live games. Pull down to refresh or ask your commissioner to run <strong>Sync games now</strong>.
          </span>
          <span className="hidden md:inline">
            — scores may be behind while games are live. Ask your commissioner to run <strong>Sync games now</strong> (or use Refresh
            Data).
          </span>
        </div>
      )}

      {!leagueId && (
        <div className="pool-alert pool-alert-compact">
          Add <code className="text-[10px]">?leagueId=…</code> from Draft or set your league in the top bar.
        </div>
      )}

      {leagueId && error && <div className="pool-alert-danger pool-alert-compact">{error}</div>}

      {leagueId && data && teamsSorted.length === 0 && (
        <div className="pool-alert pool-alert-compact">
          No scoring data yet. Sync games from Commissioner Tools when the tournament starts.
        </div>
      )}

      {leagueId && teamsSorted.length > 0 && leaderboardDerived && (
        <>
          <div className="pool-panel pool-panel-compact min-w-0">
            <div className="pool-filter-toolbar">
              <label
                className="pool-filter-chip"
                title="Checked: Leaderboard shows Rank, Orig, Live, and +/− projection columns; StatTracker shows TPPG and TPPG−PPG +/−. Same saved setting in both tabs."
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
                title="Checked: gold owner ranks under each stat (vs all teams in the league). Saved with StatTracker."
              >
                <input
                  type="checkbox"
                  checked={showInlineRanks}
                  onChange={(e) => setShowInlineRanks(e.target.checked)}
                />
                <span>{toBookTitleCase("show inline ranks")}</span>
              </label>
              <label
                className="pool-filter-chip"
                title="Checked: Win %, Odds, Line, Money %, and O/U on Leaderboard. Saved on this device."
              >
                <input
                  type="checkbox"
                  checked={showProbabilityOddsColumns}
                  onChange={(e) => setShowProbabilityOddsColumns(e.target.checked)}
                />
                <span>{toBookTitleCase("show probability & odds")}</span>
              </label>
              <div className="pool-filter-select">
                <span className="pool-filter-label">Owner</span>
                <button
                  ref={ownerButtonRef}
                  type="button"
                  onClick={toggleOwnerPicker}
                  className={
                    selectedLeagueTeamIds.length > 0 &&
                    selectedLeagueTeamIds.length === teamsSorted.length
                      ? "pool-filter-select-trigger pool-filter-select-trigger--all"
                      : "pool-filter-select-trigger"
                  }
                >
                  <span className="pool-filter-select-trigger-text">
                    {selectedLeagueTeamIds.length === 0 ? (
                      toBookTitleCase("none")
                    ) : selectedLeagueTeamIds.length === teamsSorted.length ? (
                      toBookTitleCase("all")
                    ) : selectedLeagueTeamIds.length === 1 ? (
                      (() => {
                        const nm = teamsSorted.find((t) => t.leagueTeamId === selectedLeagueTeamIds[0])?.ownerName;
                        return nm ? (
                          <PoolResponsiveOwnerNameText full={nm} />
                        ) : (
                          `1 ${toBookTitleCase("selected")}`
                        );
                      })()
                    ) : (
                      `${selectedLeagueTeamIds.length} ${toBookTitleCase("selected")}`
                    )}
                  </span>
                  <ChevronDown className="size-3 shrink-0 opacity-45" strokeWidth={2.25} aria-hidden />
                </button>
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
                        onClick={() => setSelectedLeagueTeamIds(teamsSorted.map((t) => t.leagueTeamId))}
                        className="pool-btn-ghost flex-1"
                      >
                        {toBookTitleCase("all")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedLeagueTeamIds([])}
                        className="pool-btn-ghost flex-1"
                      >
                        {toBookTitleCase("none")}
                      </button>
                    </div>
                    <div className="max-h-56 overflow-y-auto">
                      {teamsSorted.map((t) => {
                        const checked = selectedLeagueTeamIdSet.has(t.leagueTeamId);
                        return (
                          <label key={t.leagueTeamId} className="pool-picker-row w-full">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setSelectedLeagueTeamIds((prev) =>
                                  prev.includes(t.leagueTeamId)
                                    ? prev.filter((id) => id !== t.leagueTeamId)
                                    : [...prev, t.leagueTeamId]
                                )
                              }
                            />
                            <span className="truncate">
                              <PoolResponsiveOwnerNameText full={t.ownerName} />
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
              <LeaderboardOwnerBadgesLegend className="ml-auto" />
            </div>
          </div>

          <div className="pool-card pool-card-compact min-w-0">
            <button
              type="button"
              onClick={() => setLeaderboardTableOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md pool-card-header pool-owner-header text-left"
              aria-expanded={leaderboardTableOpen}
            >
              <div className="flex min-w-0 items-center gap-1 shrink-0">
                <span className="text-sm font-semibold pool-owner-name">Leaderboard</span>
              </div>
              <div className="pool-owner-header-stat-meta hidden md:flex min-w-0 flex-1 flex-wrap items-baseline justify-end gap-x-1.5 gap-y-0.5 text-right text-[10px] sm:text-[11px] font-normal tabular-nums">
                <span>
                  {visibleTeams.length} of {teamsSorted.length}{" "}
                  {teamsSorted.length === 1 ? "team" : "teams"}
                </span>
              </div>
              <div className="text-xs flex items-center gap-2 pool-owner-chevron shrink-0">
                {leaderboardTableOpen ? (
                  <ChevronUp className="h-4 w-4" aria-hidden />
                ) : (
                  <ChevronDown className="h-4 w-4" aria-hidden />
                )}
              </div>
            </button>

            {leaderboardTableOpen ? (
            <div className="mt-1.5 min-w-0 overflow-x-auto md:overflow-x-auto">
              <table className="pool-table w-full text-xs min-w-[58rem]">
                <thead>
                  <tr>
                    <SortableTh
                      columnKey="standingsRank"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="left"
                      className="text-left min-w-[2.25rem] tabular-nums"
                    >
                      #
                    </SortableTh>
                    <SortableTh
                      columnKey="owner"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="left"
                      className="text-left min-w-[5.5rem] max-w-[9rem] w-[9rem]"
                      title="Pool owner"
                    >
                      Owner
                    </SortableTh>
                    <SortableTh
                      columnKey="remain"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="center"
                      title="Roster players whose team is still in the tournament"
                    >
                      REM
                    </SortableTh>
                    <SortableTh
                      columnKey="adv"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="center"
                      title="Players whose team advanced through the league’s current tournament round"
                    >
                      ADV
                    </SortableTh>
                    <SortableTh
                      columnKey="r1"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="center"
                    >
                      R1
                    </SortableTh>
                    <SortableTh
                      columnKey="r2"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="center"
                    >
                      R2
                    </SortableTh>
                    <SortableTh
                      columnKey="r3"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="center"
                    >
                      R3
                    </SortableTh>
                    <SortableTh
                      columnKey="r4"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="center"
                    >
                      R4
                    </SortableTh>
                    <SortableTh
                      columnKey="r5"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="center"
                    >
                      R5
                    </SortableTh>
                    <SortableTh
                      columnKey="r6"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="center"
                    >
                      R6
                    </SortableTh>
                    <SortableTh
                      columnKey="total"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="center"
                      className="text-center pool-table-col-primary min-w-[2.75rem]"
                    >
                      Total
                    </SortableTh>
                    <SortableTh
                      columnKey="behindLeader"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="center"
                      className="text-center w-11 tabular-nums"
                      title="Points behind the league leader (highest actual total in the pool); 0 if tied for first"
                    >
                      -X
                    </SortableTh>
                    {showTppgColumns ? (
                      <>
                        <SortableTh
                          columnKey="projRank"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center tabular-nums"
                          title="Standings rank among owners by summed live projections when every roster player has a projection"
                        >
                          Rank
                        </SortableTh>
                        <SortableTh
                          columnKey="origProj"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center"
                          title="Pre-tournament chalk projection"
                        >
                          Orig
                        </SortableTh>
                        <SortableTh
                          columnKey="liveProj"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center"
                          title="Live projection"
                        >
                          Live
                        </SortableTh>
                        <SortableTh
                          columnKey="plusMinus"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center w-11"
                          title="Live projection − original projection"
                        >
                          +/−
                        </SortableTh>
                      </>
                    ) : null}
                    <SortableTh
                      columnKey="tqsAdjustment"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="center"
                      className="text-center min-w-[2.5rem] tabular-nums"
                      title="Team quality adjustment: k × (league average roster TQS − your roster TQS). Stronger drafted teams (better overall rank + seed) get fewer/negative points."
                    >
                      TQS
                    </SortableTh>
                    <SortableTh
                      columnKey="adjustedTotal"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="center"
                      className="text-center min-w-[2.5rem] tabular-nums"
                      title="Total fantasy points after TQS adjustment (raw total + TQS)"
                    >
                      ADJ
                    </SortableTh>
                    {showProbabilityOddsColumns ? (
                      <>
                        <SortableTh
                          columnKey="winPct"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          title="Model over all league owners: Plackett–Luce weights from live projection (or points fallback), roster share still alive, and share advanced through current round"
                        >
                          Win %
                        </SortableTh>
                        <SortableTh
                          columnKey="moneyPct"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          title="Estimated chance to finish in the top 3 among all league owners (top min(3,n) if fewer than 3 teams)"
                        >
                          Money %
                        </SortableTh>
                        <SortableTh
                          columnKey="winOddsRatio"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center tabular-nums min-w-[2.75rem]"
                          title="Approx. book-style win odds (e.g. 8:1), fair line implied by model win %"
                        >
                          Odds
                        </SortableTh>
                        <SortableTh
                          columnKey="winAmericanLine"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center tabular-nums min-w-[2.5rem]"
                          title="American moneyline for winning the pool (fair line from model win %; negative favorite, positive underdog)"
                        >
                          Line
                        </SortableTh>
                        <SortableTh
                          columnKey="tournamentOu"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center min-w-[4.75rem] whitespace-nowrap"
                          title="Tournament fantasy total O/U: live projected total to nearest ½ (whole numbers post as x.5), one decimal; typical −110 on Over and Under; hover for current score and lean vs opening"
                        >
                          O/U
                        </SortableTh>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {visibleTeams.length === 0 ? (
                    <tr className="pool-table-row">
                      <td
                        colSpan={tableColumnCount}
                        className="px-2 py-4 text-center text-[11px] pool-text-muted align-middle"
                      >
                        {toBookTitleCase("no owners selected")}.{" "}
                        {toBookTitleCase("use the owner filter to choose at least one team")}.
                      </td>
                    </tr>
                  ) : (
                    visibleTeams.map((team) => {
                      const kMoney = Math.min(3, teamsSorted.length);
                      const inTheMoney = teamsSorted.length > 0 && team.rank <= kMoney;
                      const ranks = teamsSorted.map((t) => t.rank);
                      const bestRank = ranks.length > 0 ? Math.min(...ranks) : 0;
                      const worstRank = ranks.length > 0 ? Math.max(...ranks) : 0;
                      const inLastPlace =
                        teamsSorted.length > 1 &&
                        bestRank < worstRank &&
                        team.rank === worstRank;

                      const liveR =
                        team.projection != null && Number.isFinite(Number(team.projection))
                          ? Math.round(Number(team.projection))
                          : null;
                      const origR =
                        team.projectionOriginal != null && Number.isFinite(Number(team.projectionOriginal))
                          ? Math.round(Number(team.projectionOriginal))
                          : null;
                      const pm = getProjectionPlusMinusInfo(liveR, origR);

                      const fo = leaderboardDerived.categoryRanks;
                      const roundRankByR = [fo.r1, fo.r2, fo.r3, fo.r4, fo.r5, fo.r6] as const;
                      const bid = team.leagueTeamId;
                      const outcomeProb = leaderboardDerived.outcomeProb.get(bid);
                      const projectedRank = leaderboardDerived.projRankByTeamId.get(bid);
                      const pl = rosterPlayersToOwnerMetrics(team.players);
                      const remainCount =
                        pl.length === 0 ? null : pl.filter((p) => !p.eliminated).length;
                      const advCount =
                        pl.length === 0
                          ? null
                          : pl.filter((p) =>
                              playerAdvancedThroughCurrentRound(p, leaderboardDerived.currentRound)
                            ).length;

                      const projFooterClass =
                        pm.value != null && pm.value !== 0
                          ? pm.value > 0
                            ? "text-success"
                            : "text-danger"
                          : "";

                      return (
                        <tr key={team.leagueTeamId} className="pool-table-row">
                          <td className="px-1 py-2 text-left tabular-nums text-foreground/80 align-middle">
                            {ordinalRankLabel(team.rank)}
                          </td>
                          <td className="px-1 py-2 font-semibold text-left align-middle min-w-0 max-w-[9rem] pool-table-col-group-end">
                            <span className="inline-flex items-baseline gap-1 min-w-0 max-w-full">
                              <span className="truncate min-w-0" title={team.ownerName}>
                                <PoolResponsiveOwnerNameText full={team.ownerName} />
                              </span>
                              {inTheMoney ? (
                                <InMoneyBadge
                                  kMoney={kMoney}
                                  leagueSize={teamsSorted.length}
                                  className="shrink-0"
                                />
                              ) : null}
                              {inLastPlace ? (
                                <IceBoxBadge leagueSize={teamsSorted.length} className="shrink-0" />
                              ) : null}
                            </span>
                          </td>
                          <td className="px-1 py-2 text-center font-semibold text-foreground align-middle">
                            <StatCellWithOwnerRank showRank={showInlineRanks} {...bundleRank(fo.remaining, bid)}>
                              {remainCount != null ? remainCount : "—"}
                            </StatCellWithOwnerRank>
                          </td>
                          <td className="px-1 py-2 text-center font-semibold text-foreground align-middle pool-table-col-group-end">
                            <StatCellWithOwnerRank showRank={showInlineRanks} {...bundleRank(fo.advanced, bid)}>
                              {advCount != null ? advCount : "—"}
                            </StatCellWithOwnerRank>
                          </td>
                          {([1, 2, 3, 4, 5, 6] as const).map((r) => (
                            <td
                              key={r}
                              className="px-1 py-2 text-center font-semibold text-foreground sleeper-score-font align-middle"
                              title={`R${r} pool fantasy points`}
                            >
                              <StatCellWithOwnerRank
                                showRank={showInlineRanks}
                                {...bundleRank(roundRankByR[r - 1], bid)}
                              >
                                {teamRoundCell(team.roundScores, r)}
                              </StatCellWithOwnerRank>
                            </td>
                          ))}
                          <td className="px-1 py-2 text-center font-semibold sleeper-score-font pool-table-col-primary align-middle">
                            <StatCellWithOwnerRank showRank={showInlineRanks} {...bundleRank(fo.total, bid)}>
                              {String(Math.round(team.totalScore))}
                            </StatCellWithOwnerRank>
                          </td>
                          <td className="px-1 py-2 text-center font-semibold sleeper-score-font align-middle tabular-nums pool-table-col-group-end">
                            {(() => {
                              const behind = pointsBehindLeaderValue(team, leagueMaxTotalPoints);
                              if (behind == null) return "—";
                              const cls = behind === 0 ? "text-success" : "text-danger";
                              const text = behind === 0 ? "0" : `-${behind}`;
                              return <span className={cls}>{text}</span>;
                            })()}
                          </td>
                          {showTppgColumns ? (
                            <>
                              <td className="px-1 py-2 text-center font-semibold text-foreground tabular-nums align-middle">
                                {projectedRank != null ? ordinalRankLabel(projectedRank) : "—"}
                              </td>
                              <td className="px-1 py-2 text-center font-semibold sleeper-score-font align-middle">
                                <StatCellWithOwnerRank showRank={showInlineRanks} {...bundleRank(fo.origProj, bid)}>
                                  {origR != null ? String(origR) : "—"}
                                </StatCellWithOwnerRank>
                              </td>
                              <td className="px-1 py-2 text-center font-semibold sleeper-score-font align-middle">
                                <StatCellWithOwnerRank showRank={showInlineRanks} {...bundleRank(fo.liveProj, bid)}>
                                  {liveR != null ? String(liveR) : "—"}
                                </StatCellWithOwnerRank>
                              </td>
                              <td className="px-1 py-2 text-center font-semibold sleeper-score-font align-middle">
                                <StatCellWithOwnerRank
                                  showRank={showInlineRanks}
                                  {...bundleRank(fo.projPlusMinus, bid)}
                                >
                                  {pm.value == null ? (
                                    pm.text
                                  ) : (
                                    <span className={projFooterClass}>{pm.text}</span>
                                  )}
                                </StatCellWithOwnerRank>
                              </td>
                            </>
                          ) : null}
                          <td className="px-1 py-2 text-center font-semibold text-foreground sleeper-score-font align-middle tabular-nums">
                            <StatCellWithOwnerRank showRank={showInlineRanks} {...bundleRank(fo.tqsAdjustment, bid)}>
                              {formatTqsAdjustmentCell(team)}
                            </StatCellWithOwnerRank>
                          </td>
                          <td className="px-1 py-2 text-center font-semibold text-foreground sleeper-score-font align-middle tabular-nums pool-table-col-group-end">
                            <StatCellWithOwnerRank showRank={showInlineRanks} {...bundleRank(fo.adjustedTotal, bid)}>
                              {typeof team.adjustedTotalScore === "number" && Number.isFinite(team.adjustedTotalScore) ? (
                                String(Math.round(team.adjustedTotalScore))
                              ) : (
                                "—"
                              )}
                            </StatCellWithOwnerRank>
                          </td>
                          {showProbabilityOddsColumns ? (
                            <>
                              <td className="px-1 py-2 text-center font-semibold text-foreground tabular-nums align-middle">
                                <StatCellWithOwnerRank showRank={false} {...bundleRank(fo.winPct, bid)}>
                                  {outcomeProb != null ? `${outcomeProb.winPct.toFixed(1)}%` : "—"}
                                </StatCellWithOwnerRank>
                              </td>
                              <td className="px-1 py-2 text-center font-semibold text-foreground tabular-nums align-middle">
                                <StatCellWithOwnerRank showRank={false} {...bundleRank(fo.moneyPct, bid)}>
                                  {outcomeProb != null ? `${outcomeProb.top3Pct.toFixed(1)}%` : "—"}
                                </StatCellWithOwnerRank>
                              </td>
                              <td className="px-1 py-2 text-center font-semibold text-foreground tabular-nums align-middle">
                                <StatCellWithOwnerRank showRank={false} {...bundleRank(fo.winPct, bid)}>
                                  {(() => {
                                    const p = winProbabilityDecimal(outcomeProb?.winPct);
                                    const s = p != null ? fractionalOddsLabelFromWinProbability(p) : null;
                                    return s ?? "—";
                                  })()}
                                </StatCellWithOwnerRank>
                              </td>
                              <td className="px-1 py-2 text-center font-semibold text-foreground tabular-nums align-middle">
                                <StatCellWithOwnerRank showRank={false} {...bundleRank(fo.winPct, bid)}>
                                  {(() => {
                                    const p = winProbabilityDecimal(outcomeProb?.winPct);
                                    const s = p != null ? americanOddsLabelFromWinProbability(p) : null;
                                    return s ?? "—";
                                  })()}
                                </StatCellWithOwnerRank>
                              </td>
                              <td className="px-1 py-2 text-center font-semibold text-foreground align-middle min-w-[4.75rem]">
                                <StatCellWithOwnerRank
                                  showRank={false}
                                  {...bundleRank(fo.tournamentOu, bid)}
                                  className="flex flex-col items-center justify-center gap-0 w-max max-w-full mx-auto"
                                >
                                  {(() => {
                                    const liveOu =
                                      team.projection != null && Number.isFinite(Number(team.projection))
                                        ? Number(team.projection)
                                        : null;
                                    const origOu =
                                      team.projectionOriginal != null &&
                                      Number.isFinite(Number(team.projectionOriginal))
                                        ? Number(team.projectionOriginal)
                                        : null;
                                    const ou = tournamentOuFromProjections(origOu, liveOu);
                                    if (!ou) return "—";
                                    const tip = tournamentOuTooltip(
                                      ou,
                                      Math.round(team.totalScore),
                                      origOu != null
                                    );
                                    return (
                                      <div
                                        className="flex flex-col items-center shrink-0 leading-none"
                                        title={tip}
                                      >
                                        <span className="block whitespace-nowrap tabular-nums sleeper-score-font text-xs font-semibold">
                                          {formatTournamentOuLine(ou.line)}
                                        </span>
                                        <span className="block whitespace-nowrap text-[9px] sm:text-[10px] text-foreground/70 tabular-nums font-medium mt-0.5">
                                          {`O ${ou.overAmerican} · U ${ou.underAmerican}`}
                                        </span>
                                      </div>
                                    );
                                  })()}
                                </StatCellWithOwnerRank>
                              </td>
                            </>
                          ) : null}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            ) : null}
          </div>

          <LeaderboardAllTournamentTeamTable
            teams={teamsSorted}
            currentRound={leaderboardDerived.currentRound}
            showTppgColumns={showTppgColumns}
            showInlineRanks={showInlineRanks}
          />
          <LeaderboardBestSelectionByRoundTable
            teams={teamsSorted}
            currentRound={leaderboardDerived.currentRound}
            showTppgColumns={showTppgColumns}
            showInlineRanks={showInlineRanks}
          />
          <LeaderboardWorstSelectionByRoundTable
            teams={teamsSorted}
            currentRound={leaderboardDerived.currentRound}
            showTppgColumns={showTppgColumns}
            showInlineRanks={showInlineRanks}
          />
        </>
      )}

    </div>
  );
}
