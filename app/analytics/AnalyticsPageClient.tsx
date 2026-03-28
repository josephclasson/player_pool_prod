"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { BarChart3, ChevronDown, ChevronUp, RefreshCcw, ShieldCheck } from "lucide-react";
import {
  assignAnalyticsRanks,
  maxTotalInRows,
  pointsBehindLeaderInTable,
  buildSchoolPerformanceRows,
  buildConferencePerformanceRows,
  buildSeedPerformanceRows,
  buildRoundPerformanceRows,
  type AnalyticsActAggregateRankedRow
} from "@/lib/analytics-act-aggregates";
import { postStatTrackerLiveSync } from "@/lib/pool-tournament-live-sync-client";
import { subscribeLeagueLiveScoreboard } from "@/lib/pool-live-scoreboard-subscribe";
import { adaptivePoolListPollMs } from "@/lib/pool-refresh-intervals";
import {
  leaderboardSnapshotKey,
  readStoredSnapshot,
  writeStoredActiveLeagueId,
  writeStoredSnapshot
} from "@/lib/player-pool-storage";
import type { LeaderboardApiPayload } from "@/lib/scoring/persist-league-scoreboard";

type LeaderboardSnapshot = {
  data: LeaderboardApiPayload | null;
  etag: string | null;
};

type AnalyticsSortKey =
  | "standingsRank"
  | "label"
  | "remain"
  | "adv"
  | "r1"
  | "r2"
  | "r3"
  | "r4"
  | "r5"
  | "r6"
  | "total"
  | "behindLeader";

const SORT_HEADER_ARIA: Record<AnalyticsSortKey, string> = {
  standingsRank: "standings rank (#)",
  label: "row label",
  remain: "players remaining (REM)",
  adv: "advanced count",
  r1: "round 1 points",
  r2: "round 2 points",
  r3: "round 3 points",
  r4: "round 4 points",
  r5: "round 5 points",
  r6: "round 6 points",
  total: "total points",
  behindLeader: "points behind leader"
};

function defaultSortDir(key: AnalyticsSortKey): "asc" | "desc" {
  if (key === "standingsRank" || key === "label" || key === "behindLeader") return "asc";
  return "desc";
}

function compareNullableNumbers(a: number | null, b: number | null, mult: number): number {
  const aBad = a == null || !Number.isFinite(a);
  const bBad = b == null || !Number.isFinite(b);
  if (aBad && bBad) return 0;
  if (aBad) return 1;
  if (bBad) return -1;
  return (a - b) * mult;
}

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
  columnKey: AnalyticsSortKey;
  sortKey: AnalyticsSortKey;
  sortDir: "asc" | "desc";
  onSort: (k: AnalyticsSortKey) => void;
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

function roundSortValue(roundScores: Record<number, number> | undefined, r: number): number | null {
  if (!roundScores || !Object.prototype.hasOwnProperty.call(roundScores, r)) return null;
  const v = roundScores[r];
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

function sortRows(
  rows: AnalyticsActAggregateRankedRow[],
  sortKey: AnalyticsSortKey,
  sortDir: "asc" | "desc",
  maxTotal: number | null
): AnalyticsActAggregateRankedRow[] {
  const mult = sortDir === "asc" ? 1 : -1;
  const tie = (a: AnalyticsActAggregateRankedRow, b: AnalyticsActAggregateRankedRow) =>
    a.label.localeCompare(b.label);
  return [...rows].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "standingsRank":
        cmp = (a.rank - b.rank) * mult;
        break;
      case "label":
        cmp = a.label.localeCompare(b.label) * mult;
        break;
      case "remain":
        cmp = (a.remain - b.remain) * mult;
        break;
      case "adv":
        cmp = (a.adv - b.adv) * mult;
        break;
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
        cmp = compareNullableNumbers(a.totalScore, b.totalScore, mult);
        break;
      case "behindLeader":
        cmp = compareNullableNumbers(
          pointsBehindLeaderInTable(a.totalScore, maxTotal),
          pointsBehindLeaderInTable(b.totalScore, maxTotal),
          mult
        );
        break;
      default:
        break;
    }
    if (cmp !== 0) return cmp;
    return tie(a, b);
  });
}

function AnalyticsActTable({
  title,
  labelHeader,
  rowsRanked,
  sortKey,
  sortDir,
  onSort,
  tableOpen,
  onToggleOpen,
  maxTotal
}: {
  title: string;
  labelHeader: string;
  rowsRanked: AnalyticsActAggregateRankedRow[];
  sortKey: AnalyticsSortKey;
  sortDir: "asc" | "desc";
  onSort: (k: AnalyticsSortKey) => void;
  tableOpen: boolean;
  onToggleOpen: () => void;
  maxTotal: number | null;
}) {
  const displayRows = useMemo(
    () => sortRows(rowsRanked, sortKey, sortDir, maxTotal),
    [rowsRanked, sortKey, sortDir, maxTotal]
  );

  return (
    <div className="pool-card pool-card-compact min-w-0">
      <button
        type="button"
        onClick={onToggleOpen}
        className="w-full flex items-center justify-between gap-1 px-1.5 py-0 md:gap-2 md:px-2 md:py-1.5 rounded-md pool-card-header pool-owner-header pool-owner-header--leaderboard text-left"
        aria-expanded={tableOpen}
      >
        <div className="flex min-w-0 items-center gap-1 shrink-0">
          <span className="text-sm font-semibold pool-owner-name leading-none">{title}</span>
        </div>
        <div className="text-xs flex items-center gap-1 pool-owner-chevron shrink-0 md:gap-2">
          {tableOpen ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
        </div>
      </button>

      {tableOpen ? (
        <div className="pool-table-viewport mt-1.5 min-w-0 overflow-x-auto md:overflow-x-auto">
          <table className="pool-table text-xs min-w-0">
            <thead>
              <tr>
                <SortableTh
                  columnKey="standingsRank"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                  align="left"
                  className="text-left tabular-nums"
                  title="Rank by pool fantasy total (1 = highest)"
                >
                  #
                </SortableTh>
                <SortableTh
                  columnKey="label"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                  align="left"
                  className="text-left whitespace-nowrap"
                >
                  {labelHeader}
                </SortableTh>
                <SortableTh
                  columnKey="remain"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                  align="center"
                  title="Drafted players whose team is still in the tournament"
                >
                  REM
                </SortableTh>
                <SortableTh
                  columnKey="adv"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                  align="center"
                  title="Drafted players whose team clinched the next round: final win in the league’s active round, or eliminated only in a later round"
                  className="pool-table-col-group-end"
                >
                  ADV
                </SortableTh>
                {([1, 2, 3, 4, 5, 6] as const).map((r) => (
                  <SortableTh
                    key={r}
                    columnKey={`r${r}` as AnalyticsSortKey}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={onSort}
                    align="center"
                  >
                    <MRound r={r} />
                  </SortableTh>
                ))}
                <SortableTh
                  columnKey="total"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                  align="center"
                  className="text-center pool-table-col-primary"
                >
                  <MTot />
                </SortableTh>
                <SortableTh
                  columnKey="behindLeader"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                  align="center"
                  className="text-center w-11 tabular-nums"
                  title="Points behind the top row in this table; 0 if tied for first"
                >
                  -X
                </SortableTh>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row) => {
                const behind = pointsBehindLeaderInTable(row.totalScore, maxTotal);
                const groupAllEliminated = row.remain === 0;
                return (
                  <tr
                    key={row.key}
                    className={["pool-table-row", groupAllEliminated ? "pool-table-row-eliminated" : ""]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <td className="px-1 py-2 text-left tabular-nums text-foreground/80 align-middle">
                      {ordinalRankLabel(row.rank)}
                    </td>
                    <td className="px-1 py-2 font-semibold text-left align-middle whitespace-nowrap min-w-0 pool-table-col-group-end">
                      <span className="whitespace-nowrap" title={row.label}>
                        {row.label}
                      </span>
                    </td>
                    <td className="px-1 py-2 text-center font-semibold text-foreground align-middle">{row.remain}</td>
                    <td className="px-1 py-2 text-center font-semibold text-foreground align-middle pool-table-col-group-end">
                      {row.adv}
                    </td>
                    {([1, 2, 3, 4, 5, 6] as const).map((r) => (
                      <td
                        key={r}
                        className="px-1 py-2 text-center font-semibold text-foreground sleeper-score-font align-middle"
                        title={`R${r} pool fantasy points (sum of drafted players in this group)`}
                      >
                        {teamRoundCell(row.roundScores, r)}
                      </td>
                    ))}
                    <td className="px-1 py-2 text-center font-semibold sleeper-score-font pool-table-col-primary align-middle">
                      {String(Math.round(row.totalScore))}
                    </td>
                    <td className="px-1 py-2 text-center font-semibold sleeper-score-font align-middle tabular-nums pool-table-col-group-end">
                      {(() => {
                        if (behind == null) return "—";
                        const cls = behind === 0 ? "text-success" : "text-danger";
                        const text = behind === 0 ? "0" : `-${behind}`;
                        return <span className={cls}>{text}</span>;
                      })()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export function AnalyticsPageClient({ leagueId }: { leagueId?: string }) {
  const router = useRouter();
  const [data, setData] = useState<LeaderboardApiPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [unchangedRefreshStreak, setUnchangedRefreshStreak] = useState(0);
  const [heroPulse, setHeroPulse] = useState(false);
  const lastLbSyncRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const loadControllerRef = useRef<AbortController | null>(null);
  const etagRef = useRef<string | null>(null);
  const lastLoadedAtRef = useRef(0);

  const [schoolOpen, setSchoolOpen] = useState(false);
  const [conferenceOpen, setConferenceOpen] = useState(false);
  const [seedOpen, setSeedOpen] = useState(false);
  const [roundOpen, setRoundOpen] = useState(false);

  const [schoolSortKey, setSchoolSortKey] = useState<AnalyticsSortKey>("total");
  const [schoolSortDir, setSchoolSortDir] = useState<"asc" | "desc">("desc");
  const [conferenceSortKey, setConferenceSortKey] = useState<AnalyticsSortKey>("total");
  const [conferenceSortDir, setConferenceSortDir] = useState<"asc" | "desc">("desc");
  const [seedSortKey, setSeedSortKey] = useState<AnalyticsSortKey>("total");
  const [seedSortDir, setSeedSortDir] = useState<"asc" | "desc">("desc");
  const [roundSortKey, setRoundSortKey] = useState<AnalyticsSortKey>("total");
  const [roundSortDir, setRoundSortDir] = useState<"asc" | "desc">("desc");

  const cacheKey = useMemo(() => (leagueId ? leaderboardSnapshotKey({ leagueId }) : null), [leagueId]);

  useEffect(() => {
    if (leagueId) writeStoredActiveLeagueId(leagueId);
  }, [leagueId]);

  useEffect(() => {
    if (!cacheKey) return;
    const snap = readStoredSnapshot<LeaderboardSnapshot>(cacheKey, 1000 * 60 * 20);
    if (snap?.data) setData(snap.data);
    if (snap?.etag) etagRef.current = snap.etag;
  }, [cacheKey]);

  const load = useCallback(
    async (opts?: { manual?: boolean; force?: boolean; silent?: boolean }) => {
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
    },
    [leagueId, cacheKey]
  );

  useEffect(() => {
    if (!leagueId) return;
    void load();
  }, [leagueId, load]);

  useEffect(() => {
    return subscribeLeagueLiveScoreboard(leagueId, () => void load({ silent: true, force: true }), {
      channelPrefix: "analytics_lb"
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

  useEffect(() => {
    const at = data?.lastSyncedAt ?? null;
    if (!at || at === lastLbSyncRef.current) return;
    lastLbSyncRef.current = at;
    setHeroPulse(true);
    const t = window.setTimeout(() => setHeroPulse(false), 700);
    return () => window.clearTimeout(t);
  }, [data?.lastSyncedAt]);

  async function onManualRefresh() {
    if (!leagueId) return;
    setRefreshBusy(true);
    setError(null);
    try {
      try {
        await postStatTrackerLiveSync(leagueId, { force: true });
      } catch {
        /* best-effort */
      }
      await load({ manual: true, force: true });
    } finally {
      setRefreshBusy(false);
    }
  }

  const teamsSorted = useMemo(() => {
    const list = data?.teams ?? [];
    return [...list].sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.ownerName.localeCompare(b.ownerName);
    });
  }, [data?.teams]);

  const currentRound = data?.currentRound ?? 0;
  const numTeams = teamsSorted.length;

  const schoolRows = useMemo(() => {
    if (teamsSorted.length === 0) return [];
    return assignAnalyticsRanks(buildSchoolPerformanceRows(teamsSorted, currentRound));
  }, [teamsSorted, currentRound]);

  const conferenceRows = useMemo(() => {
    if (teamsSorted.length === 0) return [];
    return assignAnalyticsRanks(buildConferencePerformanceRows(teamsSorted, currentRound));
  }, [teamsSorted, currentRound]);

  const seedRows = useMemo(() => {
    if (teamsSorted.length === 0) return [];
    return assignAnalyticsRanks(buildSeedPerformanceRows(teamsSorted, currentRound));
  }, [teamsSorted, currentRound]);

  const roundRows = useMemo(() => {
    if (teamsSorted.length === 0) return [];
    return assignAnalyticsRanks(buildRoundPerformanceRows(teamsSorted, currentRound, numTeams));
  }, [teamsSorted, currentRound, numTeams]);

  const schoolMax = useMemo(() => maxTotalInRows(schoolRows), [schoolRows]);
  const conferenceMax = useMemo(() => maxTotalInRows(conferenceRows), [conferenceRows]);
  const seedMax = useMemo(() => maxTotalInRows(seedRows), [seedRows]);
  const roundMax = useMemo(() => maxTotalInRows(roundRows), [roundRows]);

  const roundLiveLabel = data?.currentRound
    ? data.currentRound === 0
      ? "1"
      : String(data.currentRound)
    : null;

  function handleSchoolSort(k: AnalyticsSortKey) {
    if (k === schoolSortKey) setSchoolSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSchoolSortKey(k);
      setSchoolSortDir(defaultSortDir(k));
    }
  }
  function handleConferenceSort(k: AnalyticsSortKey) {
    if (k === conferenceSortKey) setConferenceSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setConferenceSortKey(k);
      setConferenceSortDir(defaultSortDir(k));
    }
  }
  function handleSeedSort(k: AnalyticsSortKey) {
    if (k === seedSortKey) setSeedSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSeedSortKey(k);
      setSeedSortDir(defaultSortDir(k));
    }
  }
  function handleRoundSort(k: AnalyticsSortKey) {
    if (k === roundSortKey) setRoundSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setRoundSortKey(k);
      setRoundSortDir(defaultSortDir(k));
    }
  }

  return (
    <div className="pool-page-stack pool-page-stack-tight pool-leaderboard-page">
      <div className="pool-hero pool-hero-databallr">
        <div className="grid grid-cols-[5rem_1fr_5rem] items-center gap-2 md:grid-cols-[auto_1fr_auto]">
          <div className="flex items-center justify-start md:justify-start">
            <div
              className="h-9 w-9 shrink-0 rounded-md bg-accent/15 border border-accent/40 flex items-center justify-center"
              aria-hidden
            >
              <BarChart3 className="h-4 w-4 text-accent" />
            </div>
          </div>
          <div className="min-w-0 text-center md:text-center">
            <h1 className="stat-tracker-page-title text-center md:text-center">Analytics</h1>
            {data?.lastSyncedAt ? (
              <div
                className={`pool-hero-sync-meta text-[10px] tabular-nums text-foreground/50 mt-0.5 hidden md:block text-center ${
                  heroPulse ? "motion-safe:animate-pulse" : ""
                }`}
              >
                Synced {new Date(data.lastSyncedAt).toLocaleString()}
                {data.anyLiveGames ? (
                  <span className="ml-1.5 text-emerald-500 font-semibold">· Live ×{data.liveGamesCount}</span>
                ) : null}
              </div>
            ) : (
              <div className="pool-hero-sync-meta text-[10px] text-foreground/45 mt-0.5 hidden md:block text-center">
                Drafted-player performance by school, seed, and draft round
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
          School, conference, tournament seed, and draft-round totals for players selected in your pool (ACT columns).
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

      {leagueId && teamsSorted.length > 0 && (
        <div className="flex flex-col gap-3 min-w-0">
          <AnalyticsActTable
            title="School Performance"
            labelHeader="SCHOOL"
            rowsRanked={schoolRows}
            sortKey={schoolSortKey}
            sortDir={schoolSortDir}
            onSort={handleSchoolSort}
            tableOpen={schoolOpen}
            onToggleOpen={() => setSchoolOpen((v) => !v)}
            maxTotal={schoolMax}
          />
          <AnalyticsActTable
            title="Conference Performance"
            labelHeader="CONF"
            rowsRanked={conferenceRows}
            sortKey={conferenceSortKey}
            sortDir={conferenceSortDir}
            onSort={handleConferenceSort}
            tableOpen={conferenceOpen}
            onToggleOpen={() => setConferenceOpen((v) => !v)}
            maxTotal={conferenceMax}
          />
          <AnalyticsActTable
            title="Seed Performance"
            labelHeader="SEED"
            rowsRanked={seedRows}
            sortKey={seedSortKey}
            sortDir={seedSortDir}
            onSort={handleSeedSort}
            tableOpen={seedOpen}
            onToggleOpen={() => setSeedOpen((v) => !v)}
            maxTotal={seedMax}
          />
          <AnalyticsActTable
            title="Round Performance"
            labelHeader="ROUND"
            rowsRanked={roundRows}
            sortKey={roundSortKey}
            sortDir={roundSortDir}
            onSort={handleRoundSort}
            tableOpen={roundOpen}
            onToggleOpen={() => setRoundOpen((v) => !v)}
            maxTotal={roundMax}
          />
        </div>
      )}
    </div>
  );
}
