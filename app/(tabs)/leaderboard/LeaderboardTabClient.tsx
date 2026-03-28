"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { IceBoxBadge } from "@/components/stats/IceBoxBadge";
import { InMoneyBadge } from "@/components/stats/InMoneyBadge";
import { LeaderboardOwnerBadgesLegend } from "@/components/stats/LeaderboardOwnerBadgesLegend";
import { PoolResponsiveOwnerNameText } from "@/components/stats/PoolResponsiveDisplayNames";
import { ChevronDown, ChevronUp, Trophy, RefreshCcw, ShieldCheck } from "lucide-react";
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
import { postStatTrackerLiveSync } from "@/lib/pool-tournament-live-sync-client";
import { subscribeLeagueLiveScoreboard } from "@/lib/pool-live-scoreboard-subscribe";
import { adaptivePoolListPollMs } from "@/lib/pool-refresh-intervals";

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

function MRound({ r }: { r: 1 | 2 | 3 | 4 | 5 | 6 }) {
  return (
    <>
      <span className="md:hidden">{r}</span>
      <span className="hidden md:inline">R{r}</span>
    </>
  );
}

function MTot() {
  return (
    <>
      <span className="md:hidden">TOT</span>
      <span className="hidden md:inline">Total</span>
    </>
  );
}

function MAct() {
  return <span>ACT</span>;
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
        className={`inline-flex items-center ${justify} gap-0.5 font-inherit text-inherit bg-transparent border-0 p-0 m-0 cursor-pointer select-none hover:text-[rgb(var(--pool-stats-accent))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgb(var(--pool-stats-accent)/0.55)]`}
        aria-label={`Sort by ${SORT_HEADER_ARIA[columnKey]}`}
      >
        <span className="whitespace-nowrap">{children}</span>
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
      className="pool-inline-rank hidden md:block text-[9px] sm:text-[10px] font-bold tabular-nums leading-none mt-0.5 text-[rgb(var(--pool-stats-accent))]"
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
  const router = useRouter();
  type LeaderboardViewMode = "base" | "proj" | "betting";
  const [data, setData] = useState<LeaderboardApiPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [sortKey, setSortKey] = useState<LeaderboardSortKey>("standingsRank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [showTppgColumns, setShowTppgColumns] = useState(false);
  const [showProbabilityOddsColumns, setShowProbabilityOddsColumns] = useState(false);
  const [showInlineRanks, setShowInlineRanks] = useState(true);
  const [leaderboardViewMode, setLeaderboardViewMode] = useState<LeaderboardViewMode>("base");
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
  const lastLoadedAtRef = useRef(0);
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
    setShowInlineRanks(readStoredStatTrackerShowInlineRanks());
  }, []);

  useEffect(() => {
    // Map view mode to the original toggles so other leaderboard sub-tables
    // can reuse the same `showTppgColumns` behavior.
    setShowTppgColumns(leaderboardViewMode !== "base");
    setShowProbabilityOddsColumns(leaderboardViewMode === "betting");

    // Default sort per view (like BASE sorting by #).
    if (leaderboardViewMode === "proj") {
      setSortKey("projRank");
      setSortDir("asc");
    } else {
      setSortKey("standingsRank");
      setSortDir("asc");
    }
  }, [leaderboardViewMode]);

  useEffect(() => {
    // When switching views, ensure the current sort key is visible.
    const allowedKeys =
      leaderboardViewMode === "base"
        ? new Set<LeaderboardSortKey>([
            "standingsRank",
            "owner",
            "remain",
            "adv",
            "r1",
            "r2",
            "r3",
            "r4",
            "r5",
            "r6",
            "total",
            "behindLeader"
          ])
        : leaderboardViewMode === "proj"
          ? new Set<LeaderboardSortKey>([
              "standingsRank",
              "owner",
              "projRank",
              "total",
              "origProj",
              "liveProj",
              "plusMinus",
              "tqsAdjustment",
              "adjustedTotal"
            ])
          : new Set<LeaderboardSortKey>([
              "standingsRank",
              "owner",
              "winPct",
              "moneyPct",
              "winOddsRatio",
              "winAmericanLine",
              "tournamentOu"
            ]);

    if (!allowedKeys.has(sortKey)) {
      setSortKey("standingsRank");
      setSortDir("asc");
    }
  }, [leaderboardViewMode, sortKey]);

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
    const force = opts?.force === true;
    if (inFlightRef.current) {
      if (!force) return;
      loadControllerRef.current?.abort();
    }
    if (!force && Date.now() - lastLoadedAtRef.current < 2500) return;
    const controller = new AbortController();
    loadControllerRef.current = controller;
    inFlightRef.current = true;
    if (opts?.manual) setError(null);
    try {
      const params = new URLSearchParams();
      if (force) params.set("refresh", "1");
      const qs = params.toString();
      const headers: Record<string, string> = {};
      if (!force && etagRef.current) headers["If-None-Match"] = etagRef.current;
      const res = await fetch(`/api/leaderboard/${encodeURIComponent(leagueId)}${qs ? `?${qs}` : ""}`, {
        signal: controller.signal,
        headers
      });
      if (res.status === 304) {
        setUnchangedRefreshStreak((n) => n + 1);
        lastLoadedAtRef.current = Date.now();
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
      lastLoadedAtRef.current = Date.now();
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
    return subscribeLeagueLiveScoreboard(leagueId, () => void load({ silent: true, force: true }), {
      channelPrefix: "leaderboard_lb"
    });
  }, [leagueId, load]);

  useEffect(() => {
    return () => {
      loadControllerRef.current?.abort();
    };
  }, []);

  const pollMs = useMemo(
    () =>
      adaptivePoolListPollMs({
        hasLiveGames: Boolean(data?.anyLiveGames),
        unchangedRefreshStreak
      }),
    [data?.anyLiveGames, unchangedRefreshStreak]
  );

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
      try {
        await postStatTrackerLiveSync(leagueId, { force: true });
      } catch {
        /* henrygd sync is best-effort; leaderboard GET still recomputes from DB */
      }
      await load({ manual: true, force: true });
    } finally {
      setRefreshBusy(false);
    }
  }

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

  const isBaseView = leaderboardViewMode === "base";
  const isProjView = leaderboardViewMode === "proj";
  const isBettingView = leaderboardViewMode === "betting";
  const tableColumnCount = isBaseView ? 12 : isProjView ? 9 : 7;

  const roundLiveLabel = data?.currentRound
    ? data.currentRound === 0
      ? "1"
      : String(data.currentRound)
    : null;

  return (
    <div className="pool-page-stack pool-page-stack-tight pool-leaderboard-page">
      <div className="pool-hero pool-hero-databallr">
        <div className="grid grid-cols-[5rem_1fr_5rem] items-center gap-2 md:grid-cols-[auto_1fr_auto]">
          <div className="flex items-center justify-start md:justify-start">
            <div
              className="h-9 w-9 shrink-0 rounded-md bg-accent/15 border border-accent/40 flex items-center justify-center"
              aria-hidden
            >
              <Trophy className="h-4 w-4 text-accent" />
            </div>
          </div>
          <div className="min-w-0 text-center md:text-center">
            <h1 className="stat-tracker-page-title text-center md:text-center">Leaderboard</h1>
              {data?.lastSyncedAt ? (
                <div
                  className={`text-[10px] tabular-nums text-foreground/50 mt-0.5 hidden md:block text-center ${
                    heroPulse ? "motion-safe:animate-pulse" : ""
                  }`}
                >
                  Synced {new Date(data.lastSyncedAt).toLocaleString()}
                  {data.anyLiveGames ? (
                    <span className="ml-1.5 text-emerald-500 font-semibold">· Live ×{data.liveGamesCount}</span>
                  ) : null}
                </div>
              ) : (
                <div className="text-[10px] text-foreground/45 mt-0.5 hidden md:block text-center">
                  Live leaderboard status
                </div>
              )}
          </div>
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              className="pool-top-icon-btn pool-btn-outline-cta pool-btn-outline-cta--sm shrink-0 !p-1 !w-9 !h-9 flex items-center justify-center"
              disabled={!leagueId || refreshBusy}
              onClick={() => void onManualRefresh()}
              aria-label="Refresh Data"
              aria-busy={refreshBusy}
            >
              <RefreshCcw className={`h-4 w-4 ${refreshBusy ? "animate-spin" : ""}`} aria-hidden />
              <span className="sr-only">{refreshBusy ? "Refreshing…" : "Refresh Data"}</span>
            </button>
            <button
              type="button"
              className="pool-top-icon-btn pool-btn-outline-cta pool-btn-outline-cta--sm shrink-0 !p-1 !w-9 !h-9 flex items-center justify-center"
              onClick={() => {
                const href = leagueId ? `/commissioner?leagueId=${encodeURIComponent(leagueId)}` : "/commissioner";
                router.push(href);
              }}
              aria-label="Commissioner login"
            >
              <ShieldCheck className="h-4 w-4" aria-hidden />
              <span className="sr-only">Commissioner login</span>
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
            — scores may lag during live games. Ask your commissioner to run <strong>Sync games now</strong>.
          </span>
          <span className="hidden md:inline">
            — scores may be behind while games are live. Ask your commissioner to run <strong>Sync games now</strong> (or use Refresh
            Data).
          </span>
        </div>
      )}

      {!leagueId && (
        <div className="pool-alert pool-alert-compact">
          Add <code className="text-[10px]">?leagueId=…</code> from Draft
          <span className="hidden md:inline"> or set your league in the top bar</span>
          <span className="md:hidden"> or ask your commissioner for a league link</span>.
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
          <div className="pool-panel pool-panel-compact min-w-0 pool-mobile-hidden md:block">
            <div className="pool-filter-toolbar">
              <label
                className="pool-filter-chip pool-mobile-hidden md:inline-flex"
                title="Checked: gold owner ranks under each stat (vs all teams in the league). Saved with StatTracker."
              >
                <input
                  type="checkbox"
                  checked={showInlineRanks}
                  onChange={(e) => setShowInlineRanks(e.target.checked)}
                />
                <span>{toBookTitleCase("show inline ranks")}</span>
              </label>
              <div className="pool-filter-select pool-mobile-hidden md:inline-flex">
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
                  <div className="pool-modal-overlay hidden md:block" onClick={closeOwnerPicker} />
                  <div
                    className="pool-modal-sheet hidden md:block max-h-[360px] overflow-y-auto"
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
              <LeaderboardOwnerBadgesLegend className="ml-auto pool-mobile-hidden md:flex" />
            </div>
          </div>

          <div className="pool-card pool-card-compact min-w-0">
            <button
              type="button"
              onClick={() => setLeaderboardTableOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-1 px-1.5 py-0 md:gap-2 md:px-2 md:py-1.5 rounded-md pool-card-header pool-owner-header pool-owner-header--leaderboard text-left"
              aria-expanded={leaderboardTableOpen}
            >
              <div className="flex min-w-0 items-center gap-1 shrink-0">
                <span className="text-sm font-semibold pool-owner-name leading-none">Leaderboard</span>
              </div>
              <div className="pool-owner-header-stat-meta flex min-w-0 flex-1 flex-nowrap md:flex-wrap items-center justify-end gap-x-2 gap-y-0 text-right text-[10px] sm:text-[11px] font-normal tabular-nums md:gap-y-0.5 leading-none mr-2 md:mr-0">
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLeaderboardViewMode("base");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      setLeaderboardViewMode("base");
                    }
                  }}
                  className={[
                    "pool-view-tab inline-flex items-center bg-transparent border-0 p-0 m-0 cursor-pointer select-none font-semibold whitespace-nowrap leading-none",
                    leaderboardViewMode === "base"
                      ? "text-white border-b border-white"
                      : "text-white/55 hover:text-white"
                  ].join(" ")}
                  aria-pressed={leaderboardViewMode === "base"}
                >
                  ACT
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLeaderboardViewMode("proj");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      setLeaderboardViewMode("proj");
                    }
                  }}
                  className={[
                    "pool-view-tab inline-flex items-center bg-transparent border-0 p-0 m-0 cursor-pointer select-none font-semibold whitespace-nowrap leading-none",
                    leaderboardViewMode === "proj"
                      ? "text-white border-b border-white"
                      : "text-white/55 hover:text-white"
                  ].join(" ")}
                  aria-pressed={leaderboardViewMode === "proj"}
                >
                  PROJ
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLeaderboardViewMode("betting");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      setLeaderboardViewMode("betting");
                    }
                  }}
                  className={[
                    "pool-view-tab inline-flex items-center bg-transparent border-0 p-0 m-0 cursor-pointer select-none font-semibold whitespace-nowrap leading-none",
                    leaderboardViewMode === "betting"
                      ? "text-white border-b border-white"
                      : "text-white/55 hover:text-white"
                  ].join(" ")}
                  aria-pressed={leaderboardViewMode === "betting"}
                >
                  ODDS
                </span>
              </div>
              <div className="text-xs flex items-center gap-1 pool-owner-chevron shrink-0 md:gap-2">
                {leaderboardTableOpen ? (
                  <ChevronUp className="h-4 w-4" aria-hidden />
                ) : (
                  <ChevronDown className="h-4 w-4" aria-hidden />
                )}
              </div>
            </button>

            {leaderboardTableOpen ? (
            <div className="pool-table-viewport mt-1.5 min-w-0 overflow-x-auto md:overflow-x-auto">
              <table className="pool-table text-xs min-w-0">
                <thead>
                  <tr>
                    <SortableTh
                      columnKey="standingsRank"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="left"
                      className="text-left tabular-nums"
                      title="Player pool rank"
                    >
                      #
                    </SortableTh>
                    <SortableTh
                      columnKey="owner"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSortClick}
                      align="left"
                      className="text-left whitespace-nowrap"
                      title="Pool owner"
                    >
                      OWNER
                    </SortableTh>
                    {isBaseView ? (
                      <>
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
                        {([1, 2, 3, 4, 5, 6] as const).map((r) => (
                          <SortableTh
                            key={r}
                            columnKey={`r${r}` as LeaderboardSortKey}
                            sortKey={sortKey}
                            sortDir={sortDir}
                            onSort={handleSortClick}
                            align="center"
                          >
                            <MRound r={r} />
                          </SortableTh>
                        ))}
                        <SortableTh
                          columnKey="total"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center pool-table-col-primary"
                        >
                          <MTot />
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
                      </>
                    ) : null}

                    {isProjView ? (
                      <>
                        <SortableTh
                          columnKey="projRank"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          title="Projected rank among owners"
                        >
                          RANK
                        </SortableTh>
                        <SortableTh
                          columnKey="total"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center"
                          title="Actual total points"
                        >
                          <MAct />
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
                          ORIG
                        </SortableTh>
                        <SortableTh
                          columnKey="liveProj"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center pool-table-col-primary"
                          title="Live projection"
                        >
                          LIVE
                        </SortableTh>
                        <SortableTh
                          columnKey="plusMinus"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="w-11 text-center"
                          title="Live projection − original projection"
                        >
                          +/-
                        </SortableTh>
                        <SortableTh
                          columnKey="tqsAdjustment"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="min-w-[2.5rem] text-center tabular-nums"
                          title="Team quality adjustment"
                        >
                          TQS
                        </SortableTh>
                        <SortableTh
                          columnKey="adjustedTotal"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="min-w-[2.5rem] text-center tabular-nums"
                          title="Total fantasy points after TQS adjustment"
                        >
                          ADJ
                        </SortableTh>
                      </>
                    ) : null}

                    {isBettingView ? (
                      <>
                        <SortableTh
                          columnKey="winPct"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center tabular-nums"
                          title="Win %"
                        >
                          WIN%
                        </SortableTh>
                        <SortableTh
                          columnKey="moneyPct"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center tabular-nums"
                          title="Money %"
                        >
                          <span className="md:hidden">TOP3%</span>
                          <span className="hidden md:inline">MONEY%</span>
                        </SortableTh>
                        <SortableTh
                          columnKey="winOddsRatio"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center tabular-nums"
                          title="Odds"
                        >
                          ODDS
                        </SortableTh>
                        <SortableTh
                          columnKey="winAmericanLine"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center tabular-nums"
                          title="American line"
                        >
                          LINE
                        </SortableTh>
                        <SortableTh
                          columnKey="tournamentOu"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSortClick}
                          align="center"
                          className="text-center"
                          title="Tournament O/U"
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
                          <td className="px-1 py-2 font-semibold text-left align-middle whitespace-nowrap min-w-0 pool-table-col-group-end">
                            <span className="inline-flex items-baseline gap-1 whitespace-nowrap" title={team.ownerName}>
                              <span className="whitespace-nowrap">
                                <PoolResponsiveOwnerNameText full={team.ownerName} />
                              </span>
                              {inTheMoney ? (
                                <InMoneyBadge
                                  kMoney={kMoney}
                                  leagueSize={teamsSorted.length}
                                  className="hidden shrink-0 md:inline-flex"
                                />
                              ) : null}
                              {inLastPlace ? (
                                <IceBoxBadge
                                  leagueSize={teamsSorted.length}
                                  className="hidden shrink-0 md:inline-flex"
                                />
                              ) : null}
                            </span>
                          </td>
                          {isBaseView ? (
                            <>
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
                            </>
                          ) : null}

                          {isProjView ? (
                            <>
                              <td className="px-1 py-2 text-center font-semibold text-foreground align-middle tabular-nums">
                                {projectedRank != null ? ordinalRankLabel(projectedRank) : "—"}
                              </td>
                              <td className="px-1 py-2 text-center font-semibold sleeper-score-font align-middle">
                                <StatCellWithOwnerRank showRank={showInlineRanks} {...bundleRank(fo.total, bid)}>
                                  {String(Math.round(team.totalScore))}
                                </StatCellWithOwnerRank>
                              </td>
                        <td className="px-1 py-2 text-center font-semibold sleeper-score-font align-middle">
                          <StatCellWithOwnerRank showRank={showInlineRanks} {...bundleRank(fo.origProj, bid)}>
                            {origR != null ? String(origR) : "—"}
                          </StatCellWithOwnerRank>
                        </td>
                              <td className="px-1 py-2 text-center font-semibold sleeper-score-font align-middle pool-table-col-primary">
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
                            </>
                          ) : null}

                          {isBettingView ? (
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
                              <td className="px-1 py-2 text-center font-semibold text-foreground align-middle">
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
                                        <span className="inline-flex items-baseline whitespace-nowrap tabular-nums sleeper-score-font text-xs font-semibold leading-none">
                                          {formatTournamentOuLine(ou.line)}
                                          <span className="ml-0.5 text-[9px] md:text-[10px] font-medium text-foreground/70 leading-none">
                                            ({ou.overAmerican})
                                          </span>
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
