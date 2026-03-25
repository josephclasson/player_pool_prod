"use client";

import type { ReactNode } from "react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronDown, ChevronUp, UsersRound } from "lucide-react";
import { useSubscribePullRefresh } from "@/hooks/useSubscribePullRefresh";
import { PoolTableSkeleton } from "@/components/ui/PoolTableSkeleton";
import {
  playerStatsSnapshotKey,
  readStoredActiveLeagueId,
  readStoredSnapshot,
  writeStoredActiveLeagueId,
  writeStoredSnapshot
} from "@/lib/player-pool-storage";
import { PoolTablePlayerPhotoCell, PoolTableTeamLogoCell } from "@/components/stats/PoolTableMediaCells";
import { HeatBadgeLegend } from "@/components/stats/HeatBadgeLegend";
import { PlayerHeatBadge } from "@/components/stats/PlayerHeatBadge";
import { computeHeatBadgeInfo, roundScoresFromTournamentRoundPoints } from "@/lib/player-heat-badge";
import { resolveEspnTeamLogoForPoolRow } from "@/lib/espn-ncaam-assets";
import { espnMensCollegeBasketballPlayerProfileUrl } from "@/lib/espn-mbb-directory";
import { displayCollegeTeamNameForUi } from "@/lib/college-team-display";
import { resolvePlayerHeadshotUrlCandidates } from "@/lib/player-media";

type TeamInfo = {
  id: number;
  name: unknown;
  shortName: unknown;
  seed: unknown;
  overallSeed: unknown;
  region: unknown;
  conference: unknown;
  isPower5: unknown;
  externalTeamId: unknown;
  logoUrl?: unknown;
} | null;

type PoolPlayer = {
  id: number;
  name: string;
  short_name: string | null;
  position: string | null;
  jersey_number: number | null;
  height: string | null;
  season_year: number | null;
  season_ppg: number | string | null;
  season_ppg_source: string | null;
  external_player_id: string | null;
  headshot_url: string | null;
  espn_athlete_id: string | number | null;
  /** Server-resolved ESPN/storage URL (helps when client cache strips fields). */
  displayHeadshotUrl?: string | null;
  /** Ordered headshot URL fallbacks; client tries each until one loads. */
  headshotUrls?: string[] | null;
  team_id: number;
  team: TeamInfo;
  /** Live projection (integer): actual tournament pts + PPG × remaining expected chalk games. */
  projection?: number | null;
  projectionChalk?: number | null;
  /** Pre-tournament: PPG × full chalk expected games for this team’s bracket path. */
  originalProjection?: number | null;
  /** Fantasy points by display round R1–R6 (First Four counts as R1); JSON keys are strings. */
  tournamentRoundPoints?: Record<string, number> | Record<number, number>;
  /** Remaining expected chalk games = full chalk expected − completed R1–R6 finals (0 if eliminated). */
  chalkGamesRemaining?: number | null;
  expectedChalkGamesTotal?: number | null;
  completedTournamentGames?: number | null;
  ownerTeamName?: string | null;
};

type PlayersMeta = {
  count: number;
  limit: number;
  leagueId: string | null;
  lastSyncedAt: string | null;
  hasLiveGames: boolean;
};

type PlayersSnapshot = {
  rows: PoolPlayer[];
  meta: PlayersMeta | null;
  etag: string | null;
};

function displayRegionName(region: unknown): string {
  const r = region != null ? String(region).trim() : "";
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

function displayCollegeTeam(t: TeamInfo): string {
  if (!t) return "—";
  return displayCollegeTeamNameForUi(
    {
      id: t.id,
      external_team_id: t.externalTeamId,
      name: t.name,
      short_name: t.shortName
    },
    "—"
  );
}

function eliminatedRoundForPlayer(p: PoolPlayer): number | null {
  const chalkRem = p.chalkGamesRemaining;
  const completed = p.completedTournamentGames;

  const chalkRemN = chalkRem == null ? null : Number(chalkRem);
  const completedN = completed == null ? null : Number(completed);

  // Elimination is ambiguous when `chalkGamesRemaining === 0` (winners can also end with 0).
  // Use `completedTournamentGames` vs `expectedChalkGamesTotal` to decide eliminated.
  if (chalkRemN == null || !Number.isFinite(chalkRemN)) return null;
  if (chalkRemN !== 0) return null;

  const expected = p.expectedChalkGamesTotal;
  const expectedN = expected == null ? null : Number(expected);
  if (expectedN != null && Number.isFinite(expectedN) && completedN != null && Number.isFinite(completedN)) {
    // Not eliminated: played all expected chalk games.
    if (completedN >= expectedN) return null;
    const er = Math.trunc(completedN);
    if (er >= 1 && er <= 6) return er;
  }

  // Fallback: infer last round that has any aggregated points row.
  const tr = p.tournamentRoundPoints as Record<string, number | undefined> | undefined;
  if (!tr) return null;

  for (let r = 6; r >= 1; r--) {
    const sk = String(r);
    const hasKey =
      Object.prototype.hasOwnProperty.call(tr, sk) || Object.prototype.hasOwnProperty.call(tr, r);
    if (!hasKey) continue;
    return r;
  }

  return null;
}

/** Show em dash only when that round has no aggregated row; real 0 fantasy points show as "0". */
function tournamentRoundPointsCell(p: PoolPlayer, displayRound: number): string {
  const er = eliminatedRoundForPlayer(p);
  if (er != null && displayRound > er) return "E";

  const tr = p.tournamentRoundPoints;
  if (!tr) return "—";
  const raw = tr as Record<string, number | undefined>;
  const sk = String(displayRound);
  const hasKey = Object.prototype.hasOwnProperty.call(raw, sk) || Object.prototype.hasOwnProperty.call(raw, displayRound);
  if (!hasKey) return "—";
  const v = raw[sk] ?? raw[displayRound];
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return String(n);
}

/** Sum of R1–R6 fantasy points; "—" when no round has box-score data yet. */
function tournamentR1ToR6TotalDisplay(p: PoolPlayer): string {
  const tr = p.tournamentRoundPoints;
  if (!tr) return "—";
  const raw = tr as Record<string, number | undefined>;
  let sum = 0;
  let any = false;
  for (let r = 1; r <= 6; r++) {
    const sk = String(r);
    const hasKey =
      Object.prototype.hasOwnProperty.call(raw, sk) || Object.prototype.hasOwnProperty.call(raw, r);
    if (!hasKey) continue;
    any = true;
    const v = raw[sk] ?? raw[r];
    const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
    sum += n;
  }
  if (!any) return "—";
  return String(sum);
}

function ownerLabel(p: PoolPlayer): string {
  const o = p.ownerTeamName;
  if (o != null && String(o).trim() !== "") return String(o).trim();
  return "Undrafted";
}

/** Live projection minus original projection (same idea as StatTracker +/- styling). */
function getProjectionPlusMinusInfo(
  liveRounded: number | null,
  origRounded: number | null
): { text: string; value: number | null } {
  if (liveRounded == null || origRounded == null) return { text: "—", value: null };
  const diff = liveRounded - origRounded;
  const sign = diff > 0 ? "+" : "";
  return { text: `${sign}${diff}`, value: diff };
}

function errorMessageFromPoolJson(json: { error?: unknown }): string {
  const e = json.error;
  if (typeof e === "string" && e.trim()) return e;
  if (e != null && typeof e === "object") {
    try {
      return JSON.stringify(e);
    } catch {
      return "Request failed";
    }
  }
  return "Request failed";
}

function ownerFilterKey(p: PoolPlayer): string {
  const o = p.ownerTeamName;
  if (o != null && String(o).trim() !== "") return String(o).trim();
  return "Undrafted";
}

type SortColumn =
  | "player"
  | "owner"
  | "seed"
  | "overall"
  | "ppg"
  | "tppg"
  | "r1"
  | "r2"
  | "r3"
  | "r4"
  | "r5"
  | "r6"
  | "total"
  | "liveProj"
  | "origProj"
  | "plusMinus";

type NumericSortColumn = Exclude<SortColumn, "player" | "owner" | "seed" | "overall">;

const PLAYERS_SORT_ARIA: Record<SortColumn, string> = {
  player: "player name",
  owner: "fantasy owner",
  seed: "regional seed",
  overall: "NCAA overall seed",
  ppg: "season points per game",
  tppg: "tournament points per game",
  r1: "round 1 fantasy points",
  r2: "round 2 fantasy points",
  r3: "round 3 fantasy points",
  r4: "round 4 fantasy points",
  r5: "round 5 fantasy points",
  r6: "round 6 fantasy points",
  total: "tournament total points",
  origProj: "original projection",
  liveProj: "live projection",
  plusMinus: "projection plus minus"
};

const ROUND_SORT_COLUMNS: readonly SortColumn[] = ["r1", "r2", "r3", "r4", "r5", "r6"];

function roundPointsNumeric(p: PoolPlayer, displayRound: number): number | null {
  const tr = p.tournamentRoundPoints;
  if (!tr) return null;
  const raw = tr as Record<string, number | undefined>;
  const sk = String(displayRound);
  const hasKey =
    Object.prototype.hasOwnProperty.call(raw, sk) || Object.prototype.hasOwnProperty.call(raw, displayRound);
  if (!hasKey) return null;
  const v = raw[sk] ?? raw[displayRound];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function totalPointsNumeric(p: PoolPlayer): number | null {
  const tr = p.tournamentRoundPoints;
  if (!tr) return null;
  const raw = tr as Record<string, number | undefined>;
  let sum = 0;
  let any = false;
  for (let r = 1; r <= 6; r++) {
    const sk = String(r);
    const hasKey =
      Object.prototype.hasOwnProperty.call(raw, sk) || Object.prototype.hasOwnProperty.call(raw, r);
    if (!hasKey) continue;
    any = true;
    const v = raw[sk] ?? raw[r];
    sum += typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
  return any ? sum : null;
}

function ppgNumeric(p: PoolPlayer): number | null {
  if (p.season_ppg == null || String(p.season_ppg).trim() === "") return null;
  const n = Number(p.season_ppg);
  return Number.isFinite(n) ? n : null;
}

/** Average fantasy points per tournament game: mean of R1–R6 buckets that have box-score rows (same rounds as the table). */
function tournamentPpgNumeric(p: PoolPlayer): number | null {
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

function tournamentPpgDisplay(p: PoolPlayer): string {
  const v = tournamentPpgNumeric(p);
  return v == null ? "—" : v.toFixed(1);
}

function liveProjNumeric(p: PoolPlayer): number | null {
  if (p.projection != null && Number.isFinite(Number(p.projection))) return Number(p.projection);
  if (p.projectionChalk != null && Number.isFinite(Number(p.projectionChalk))) return Number(p.projectionChalk);
  return null;
}

function origProjNumeric(p: PoolPlayer): number | null {
  if (p.originalProjection != null && Number.isFinite(Number(p.originalProjection)))
    return Number(p.originalProjection);
  return null;
}

function plusMinusNumeric(p: PoolPlayer): number | null {
  const live = liveProjNumeric(p);
  const orig = origProjNumeric(p);
  if (live == null || orig == null) return null;
  return Math.round(live) - Math.round(orig);
}

function seedNumeric(p: PoolPlayer): number | null {
  const t = p.team;
  if (!t || t.seed == null || String(t.seed).trim() === "") return null;
  const n = Number(t.seed);
  return Number.isFinite(n) ? n : null;
}

/** NCAA committee overall seed 1–68 (lower is better). */
function overallNumeric(p: PoolPlayer): number | null {
  const t = p.team;
  if (!t || t.overallSeed == null || String(t.overallSeed).trim() === "") return null;
  const n = Number(t.overallSeed);
  if (!Number.isFinite(n)) return null;
  const tr = Math.trunc(n);
  if (tr < 1 || tr > 68) return null;
  return tr;
}

function overallDisplay(p: PoolPlayer): string {
  const v = overallNumeric(p);
  return v == null ? "—" : String(v);
}

function ranksHigherIsBetterPool(
  players: PoolPlayer[],
  getValue: (p: PoolPlayer) => number | null
): Map<number, number> {
  const scored: { id: number; value: number }[] = [];
  for (const p of players) {
    const v = getValue(p);
    if (v != null && Number.isFinite(v)) {
      scored.push({ id: p.id, value: v });
    }
  }
  scored.sort((a, b) => b.value - a.value || a.id - b.id);
  const map = new Map<number, number>();
  let i = 0;
  while (i < scored.length) {
    const v = scored[i].value;
    let j = i + 1;
    while (j < scored.length && scored[j].value === v) j++;
    const rank = i + 1;
    for (let k = i; k < j; k++) map.set(scored[k].id, rank);
    i = j;
  }
  return map;
}

type PoolStatRanks = {
  poolSize: number;
  ppg: Map<number, number>;
  tppg: Map<number, number>;
  r1: Map<number, number>;
  r2: Map<number, number>;
  r3: Map<number, number>;
  r4: Map<number, number>;
  r5: Map<number, number>;
  r6: Map<number, number>;
  total: Map<number, number>;
  origProj: Map<number, number>;
  liveProj: Map<number, number>;
  plusMinus: Map<number, number>;
};

function buildPoolStatRanks(players: PoolPlayer[]): PoolStatRanks {
  const empty = (): PoolStatRanks => ({
    poolSize: 0,
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
    plusMinus: new Map()
  });
  if (players.length === 0) return empty();
  return {
    poolSize: players.length,
    ppg: ranksHigherIsBetterPool(players, ppgNumeric),
    tppg: ranksHigherIsBetterPool(players, tournamentPpgNumeric),
    r1: ranksHigherIsBetterPool(players, (p) => roundPointsNumeric(p, 1)),
    r2: ranksHigherIsBetterPool(players, (p) => roundPointsNumeric(p, 2)),
    r3: ranksHigherIsBetterPool(players, (p) => roundPointsNumeric(p, 3)),
    r4: ranksHigherIsBetterPool(players, (p) => roundPointsNumeric(p, 4)),
    r5: ranksHigherIsBetterPool(players, (p) => roundPointsNumeric(p, 5)),
    r6: ranksHigherIsBetterPool(players, (p) => roundPointsNumeric(p, 6)),
    total: ranksHigherIsBetterPool(players, totalPointsNumeric),
    origProj: ranksHigherIsBetterPool(players, origProjNumeric),
    liveProj: ranksHigherIsBetterPool(players, liveProjNumeric),
    plusMinus: ranksHigherIsBetterPool(players, plusMinusNumeric)
  };
}

function sortValueForColumn(p: PoolPlayer, col: NumericSortColumn): number | null {
  switch (col) {
    case "ppg":
      return ppgNumeric(p);
    case "tppg":
      return tournamentPpgNumeric(p);
    case "r1":
      return roundPointsNumeric(p, 1);
    case "r2":
      return roundPointsNumeric(p, 2);
    case "r3":
      return roundPointsNumeric(p, 3);
    case "r4":
      return roundPointsNumeric(p, 4);
    case "r5":
      return roundPointsNumeric(p, 5);
    case "r6":
      return roundPointsNumeric(p, 6);
    case "total":
      return totalPointsNumeric(p);
    case "liveProj":
      return liveProjNumeric(p);
    case "origProj":
      return origProjNumeric(p);
    case "plusMinus":
      return plusMinusNumeric(p);
    default:
      return null;
  }
}

function comparePoolPlayers(a: PoolPlayer, b: PoolPlayer, col: SortColumn, dir: "asc" | "desc"): number {
  const mult = dir === "asc" ? 1 : -1;
  switch (col) {
    case "player": {
      const c = a.name.localeCompare(b.name) * mult;
      if (c !== 0) return c;
      return a.id - b.id;
    }
    case "owner": {
      const c = ownerLabel(a).localeCompare(ownerLabel(b)) * mult;
      if (c !== 0) return c;
      return a.name.localeCompare(b.name);
    }
    case "seed": {
      const sa = seedNumeric(a);
      const sb = seedNumeric(b);
      if (sa == null && sb == null) return a.name.localeCompare(b.name);
      if (sa == null) return 1;
      if (sb == null) return -1;
      const c = (sa - sb) * mult;
      if (c !== 0) return c;
      return a.name.localeCompare(b.name);
    }
    case "overall": {
      const oa = overallNumeric(a);
      const ob = overallNumeric(b);
      if (oa == null && ob == null) return a.name.localeCompare(b.name);
      if (oa == null) return 1;
      if (ob == null) return -1;
      const c = (oa - ob) * mult;
      if (c !== 0) return c;
      return a.name.localeCompare(b.name);
    }
    default: {
      const va = sortValueForColumn(a, col);
      const vb = sortValueForColumn(b, col);
      const na = va == null;
      const nb = vb == null;
      if (na && nb) return a.name.localeCompare(b.name);
      if (na) return 1;
      if (nb) return -1;
      const raw = va - vb;
      const cmp = raw * mult;
      if (cmp !== 0) return cmp;
      return a.name.localeCompare(b.name);
    }
  }
}

function defaultSortDirForColumn(col: SortColumn): "asc" | "desc" {
  if (col === "player" || col === "owner" || col === "overall" || col === "seed") return "asc";
  return "desc";
}

function PlayersPoolPlayerNameLink({
  playerName,
  espnAthleteId
}: {
  playerName: string;
  espnAthleteId: string | number | null;
}) {
  const idNum = espnAthleteId != null ? Number(espnAthleteId) : NaN;
  if (Number.isFinite(idNum) && idNum > 0) {
    return (
      <a
        href={espnMensCollegeBasketballPlayerProfileUrl({ espnAthleteId: idNum, playerName })}
        target="_blank"
        rel="noopener noreferrer"
        className="pool-table-player-link"
      >
        {playerName}
      </a>
    );
  }
  return <span className="font-semibold">{playerName}</span>;
}

/** Gold sub-rank under value; ranks computed from full pool load (`rows`), unchanged by filters. */
function InlinePoolStatRank({ rank, poolSize }: { rank: number | undefined; poolSize: number }) {
  if (rank == null || poolSize <= 0) return null;
  return (
    <span
      className="pool-inline-rank block text-[9px] sm:text-[10px] font-bold tabular-nums leading-none mt-0.5 text-[rgb(var(--pool-stats-accent))]"
      title={`Pool rank ${rank} of ${poolSize} players (1 = best)`}
    >
      {rank}
    </span>
  );
}

function StatPoolCellWithRank({
  children,
  rank,
  poolSize,
  align = "center",
  className
}: {
  children: ReactNode;
  rank: number | undefined;
  poolSize: number;
  align?: "left" | "center";
  className?: string;
}) {
  const flex =
    align === "left"
      ? "flex flex-col items-start justify-center min-w-0"
      : "flex flex-col items-center justify-center";
  return (
    <div className={className ? `${flex} ${className}`.trim() : flex}>
      {children}
      <InlinePoolStatRank rank={rank} poolSize={poolSize} />
    </div>
  );
}

function SortableTh({
  column,
  sortKey,
  sortDir,
  onSort,
  align,
  title,
  className,
  children
}: {
  column: SortColumn;
  sortKey: SortColumn;
  sortDir: "asc" | "desc";
  onSort: (c: SortColumn) => void;
  align: "left" | "center";
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const active = sortKey === column;
  const justify = align === "left" ? "justify-start" : "justify-center";
  const mergedTh = [align === "center" ? "text-center" : "text-left", className].filter(Boolean).join(" ");
  return (
    <th scope="col" className={mergedTh || undefined} title={title} aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center ${justify} gap-0.5 w-full min-w-0 font-inherit text-inherit bg-transparent border-0 p-0 m-0 cursor-pointer select-none hover:text-[rgb(var(--pool-stats-accent))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgb(var(--pool-stats-accent)/0.55)]`}
        aria-label={`Sort by ${PLAYERS_SORT_ARIA[column]}`}
      >
        <span className="min-w-0 truncate">{children}</span>
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

export function PlayersPoolClient({
  initialSeasonYear,
  initialQ
}: {
  initialSeasonYear: number;
  initialQ: string;
}) {
  const searchParams = useSearchParams();
  const leagueIdFromUrl = useMemo(() => searchParams.get("leagueId")?.trim() ?? "", [searchParams]);

  const [seasonYear, setSeasonYear] = useState(initialSeasonYear);
  const [q, setQ] = useState(initialQ);
  const qDeferred = useDeferredValue(q);
  const [storedLeagueId, setStoredLeagueId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<PoolPlayer[]>([]);
  const [meta, setMeta] = useState<PlayersMeta | null>(null);
  const inFlightRef = useRef(false);
  const loadControllerRef = useRef<AbortController | null>(null);
  const etagRef = useRef<string | null>(null);
  const [unchangedRefreshStreak, setUnchangedRefreshStreak] = useState(0);

  const effectiveLeagueId = leagueIdFromUrl || storedLeagueId;
  const snapshotKey = useMemo(
    () =>
      playerStatsSnapshotKey({
        seasonYear,
        q: qDeferred,
        leagueId: effectiveLeagueId || null
      }),
    [seasonYear, qDeferred, effectiveLeagueId]
  );

  useEffect(() => {
    setStoredLeagueId(readStoredActiveLeagueId());
  }, []);

  useEffect(() => {
    if (leagueIdFromUrl) writeStoredActiveLeagueId(leagueIdFromUrl);
  }, [leagueIdFromUrl]);

  useEffect(() => {
    const snap = readStoredSnapshot<PlayersSnapshot>(snapshotKey, 1000 * 60 * 20);
    if (!snap) return;
    if (Array.isArray(snap.rows) && snap.rows.length > 0) setRows(snap.rows);
    if (snap.meta) setMeta(snap.meta);
    etagRef.current = snap.etag ?? null;
  }, [snapshotKey]);

  const load = useCallback(async (opts?: { manual?: boolean; force?: boolean; silent?: boolean }) => {
    if (inFlightRef.current) {
      // Always replace stale in-flight requests so remount/effect re-runs (Strict Mode)
      // cannot leave the page empty waiting for the next poll tick.
      loadControllerRef.current?.abort();
    }
    const controller = new AbortController();
    loadControllerRef.current = controller;
    inFlightRef.current = true;
    const showBusy = rows.length === 0 && meta == null && !opts?.silent;
    if (showBusy) setBusy(true);
    if (opts?.manual) setError(null);
    try {
      const sp = new URLSearchParams();
      sp.set("seasonYear", String(seasonYear));
      if (qDeferred.trim()) sp.set("q", qDeferred.trim());
      sp.set("limit", "8000");
      const lid = effectiveLeagueId.trim();
      if (lid) sp.set("leagueId", lid);
      if (opts?.force) sp.set("refresh", "1");
      const headers: Record<string, string> = {};
      if (!opts?.force && etagRef.current) headers["If-None-Match"] = etagRef.current;
      const res = await fetch(`/api/players/pool?${sp.toString()}`, { signal: controller.signal, headers });
      if (res.status === 304) {
        setUnchangedRefreshStreak((n) => n + 1);
        return;
      }
      const json = (await res.json()) as {
        error?: string;
        players?: PoolPlayer[];
        count?: number;
        limit?: number;
        leagueId?: string | null;
        lastSyncedAt?: string | null;
        hasLiveGames?: boolean;
      };
      if (!res.ok) throw new Error(errorMessageFromPoolJson(json) || `HTTP ${res.status}`);
      etagRef.current = res.headers.get("etag");
      setUnchangedRefreshStreak(0);
      const nextRows = json.players ?? [];
      const nextMeta = {
        count: json.count ?? 0,
        limit: json.limit ?? 0,
        leagueId: json.leagueId ?? null,
        lastSyncedAt: json.lastSyncedAt ?? null,
        hasLiveGames: Boolean(json.hasLiveGames)
      };
      setRows(nextRows);
      setMeta(nextMeta);
      writeStoredSnapshot<PlayersSnapshot>(snapshotKey, {
        rows: nextRows,
        meta: nextMeta,
        etag: etagRef.current
      });
    } catch (e: unknown) {
      if ((e as Error)?.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Load failed");
      setRows([]);
      setMeta(null);
    } finally {
      inFlightRef.current = false;
      if (showBusy) setBusy(false);
    }
  }, [seasonYear, qDeferred, effectiveLeagueId, rows.length, meta, snapshotKey]);

  useSubscribePullRefresh(() => void load({ manual: true, force: true }), true);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      loadControllerRef.current?.abort();
    };
  }, []);

  const pollMs = useMemo(() => {
    const hasLive = Boolean(meta?.hasLiveGames);
    if (hasLive) return unchangedRefreshStreak >= 3 ? 30_000 : 15_000;
    return unchangedRefreshStreak >= 2 ? 60_000 : 30_000;
  }, [meta?.hasLiveGames, unchangedRefreshStreak]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load({ silent: true });
    }, pollMs);
    return () => window.clearInterval(id);
  }, [pollMs, load]);

  const leagueContext = Boolean(meta?.leagueId);

  const activeRoundBucketGlobal = useMemo(() => {
    let max = 0;
    for (const p of rows) {
      const tr = p.tournamentRoundPoints;
      if (!tr) continue;
      const raw = tr as Record<string, number | undefined>;
      for (let r = 1; r <= 6; r++) {
        const sk = String(r);
        const hasKey =
          Object.prototype.hasOwnProperty.call(raw, sk) || Object.prototype.hasOwnProperty.call(raw, r);
        if (hasKey) max = Math.max(max, r);
      }
    }
    return max || 1;
  }, [rows]);

  const poolStatRanks = useMemo(() => buildPoolStatRanks(rows), [rows]);

  const [showOnlyActivePlayers, setShowOnlyActivePlayers] = useState(false);

  const ownerOptions = useMemo(() => {
    const s = new Set<string>();
    for (const p of rows) s.add(ownerFilterKey(p));
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const collegeTeamOptions = useMemo(() => {
    const s = new Set<string>();
    for (const p of rows) s.add(displayCollegeTeam(p.team));
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const [selectedOwnerNames, setSelectedOwnerNames] = useState<string[]>([]);
  const selectedOwnerNameSet = useMemo(() => new Set(selectedOwnerNames), [selectedOwnerNames]);

  const [selectedCollegeTeams, setSelectedCollegeTeams] = useState<string[]>([]);
  const selectedCollegeTeamsSet = useMemo(() => new Set(selectedCollegeTeams), [selectedCollegeTeams]);

  const allOwnersSelected = useMemo(
    () => ownerOptions.length > 0 && selectedOwnerNames.length === ownerOptions.length,
    [ownerOptions.length, selectedOwnerNames.length]
  );

  const allTeamsSelected = useMemo(
    () => collegeTeamOptions.length > 0 && selectedCollegeTeams.length === collegeTeamOptions.length,
    [collegeTeamOptions.length, selectedCollegeTeams.length]
  );

  const didInitOwnersRef = useRef(false);
  const didInitTeamsRef = useRef(false);

  useEffect(() => {
    didInitOwnersRef.current = false;
    didInitTeamsRef.current = false;
  }, [seasonYear, effectiveLeagueId]);

  useEffect(() => {
    if (didInitOwnersRef.current) return;
    if (ownerOptions.length === 0) return;
    setSelectedOwnerNames([...ownerOptions]);
    didInitOwnersRef.current = true;
  }, [ownerOptions]);

  useEffect(() => {
    if (didInitTeamsRef.current) return;
    if (collegeTeamOptions.length === 0) return;
    setSelectedCollegeTeams([...collegeTeamOptions]);
    didInitTeamsRef.current = true;
  }, [collegeTeamOptions]);

  const ownerButtonRef = useRef<HTMLButtonElement | null>(null);
  const teamButtonRef = useRef<HTMLButtonElement | null>(null);
  const [ownerPickerOpen, setOwnerPickerOpen] = useState(false);
  const [teamPickerOpen, setTeamPickerOpen] = useState(false);
  const [ownerPickerPos, setOwnerPickerPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [teamPickerPos, setTeamPickerPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  function openOwnerPicker() {
    const rect = ownerButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setOwnerPickerPos({ top: rect.bottom + 8, left: rect.left, width: rect.width });
    setOwnerPickerOpen(true);
  }

  function closeOwnerPicker() {
    setOwnerPickerOpen(false);
  }

  function toggleOwnerPicker() {
    if (ownerPickerOpen) closeOwnerPicker();
    else openOwnerPicker();
  }

  function openTeamPicker() {
    const rect = teamButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTeamPickerPos({ top: rect.bottom + 8, left: rect.left, width: rect.width });
    setTeamPickerOpen(true);
  }

  function closeTeamPicker() {
    setTeamPickerOpen(false);
  }

  function toggleTeamPicker() {
    if (teamPickerOpen) closeTeamPicker();
    else openTeamPicker();
  }

  const [sortState, setSortState] = useState<{ column: SortColumn; dir: "asc" | "desc" }>({
    column: "liveProj",
    dir: "desc"
  });

  const handleSortClick = useCallback((column: SortColumn) => {
    setSortState((prev) => {
      if (prev.column !== column) return { column, dir: defaultSortDirForColumn(column) };
      return { column, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  }, []);

  useEffect(() => {
    setSortState({ column: "liveProj", dir: "desc" });
  }, [seasonYear, effectiveLeagueId]);

  const filteredRows = useMemo(() => {
    let list = rows;
    if (showOnlyActivePlayers) {
      list = list.filter((p) => roundPointsNumeric(p, activeRoundBucketGlobal) != null);
    }
    if (selectedOwnerNames.length === 0) return [];
    list = list.filter((p) => selectedOwnerNameSet.has(ownerFilterKey(p)));
    if (selectedCollegeTeams.length === 0) return [];
    list = list.filter((p) => selectedCollegeTeamsSet.has(displayCollegeTeam(p.team)));
    return list;
  }, [
    rows,
    showOnlyActivePlayers,
    activeRoundBucketGlobal,
    selectedOwnerNames.length,
    selectedOwnerNameSet,
    selectedCollegeTeams.length,
    selectedCollegeTeamsSet
  ]);

  const displayedRows = useMemo(() => {
    const col = sortState.column;
    if (!col) return filteredRows;
    return [...filteredRows].sort((a, b) => comparePoolPlayers(a, b, col, sortState.dir));
  }, [filteredRows, sortState.column, sortState.dir]);

  return (
    <div className="pool-page-stack pool-page-stack-tight">
      <div className="pool-hero pool-hero-databallr">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-3">
          <div className="flex items-center gap-2.5 md:gap-3 min-w-0">
            <div
              className="h-9 w-9 shrink-0 rounded-md bg-accent/15 border border-accent/40 flex items-center justify-center"
              aria-hidden
            >
              <UsersRound className="h-4 w-4 text-accent" />
            </div>
            <div className="min-w-0">
              <h1 className="stat-tracker-page-title">Player Statistics</h1>
              <div className="text-[10px] tabular-nums text-foreground/50 mt-0.5 hidden md:block">
                {meta ? (
                  <>
                    {meta.lastSyncedAt ? `Synced ${new Date(meta.lastSyncedAt).toLocaleString()}` : "Synced —"}
                    <span className="ml-1.5">{meta.count} players</span>
                    {meta.hasLiveGames ? (
                      <span className="ml-1.5 text-emerald-500 font-semibold">· Live</span>
                    ) : null}
                    <span className="ml-1.5 text-foreground/40">
                      · Auto-refresh ~{meta.hasLiveGames ? 15 : 30}s
                    </span>
                  </>
                ) : (
                  <span className="text-foreground/45">Live player stats status</span>
                )}
              </div>
              <div className="md:hidden mt-0.5 text-[9px] text-foreground/40">Pull down to refresh</div>
            </div>
          </div>
          <div className="hidden md:flex flex-wrap items-center gap-1.5 shrink-0">
            <button
              type="button"
              className="pool-btn-outline-cta pool-btn-outline-cta--sm"
              disabled={busy}
              onClick={() => void load({ manual: true, force: true })}
            >
              {busy ? "…" : "Refresh Data"}
            </button>
          </div>
        </div>
        <div className="mt-1.5 pt-2 border-t border-border/25 text-[10px] text-foreground/45 hidden md:block">
          Player-level pool stats, R1-R6 scoring splits, ownership filters, and draft projection trends.
        </div>
      </div>

      <div className="pool-panel pool-panel-compact min-w-0">
        <div className="flex flex-wrap items-end gap-2 sm:gap-3 mb-3">
          <label className="flex flex-col gap-0.5 min-w-0">
            <span className="pool-filter-label">Season</span>
            <input
              className="pool-field w-[4.5rem] text-xs py-1.5"
              type="number"
              value={seasonYear}
              onChange={(e) => setSeasonYear(Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-0.5 min-w-[10rem] flex-1">
            <span className="pool-filter-label">Search</span>
            <input
              className="pool-field text-xs py-1.5 min-w-0"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name…"
            />
          </label>
        </div>

        <div className="pool-filter-toolbar">
          <label className="pool-filter-chip">
            <input
              type="checkbox"
              checked={showOnlyActivePlayers}
              onChange={() => setShowOnlyActivePlayers((v) => !v)}
            />
            <span>Active Only</span>
          </label>
          <div className="pool-filter-select">
            <span className="pool-filter-label">Owner</span>
            <button
              ref={ownerButtonRef}
              type="button"
              onClick={toggleOwnerPicker}
              className={
                selectedOwnerNames.length > 0 && allOwnersSelected
                  ? "pool-filter-select-trigger pool-filter-select-trigger--all"
                  : "pool-filter-select-trigger"
              }
            >
              <span className="pool-filter-select-trigger-text">
                {selectedOwnerNames.length === 0
                  ? "None"
                  : allOwnersSelected
                    ? "All"
                    : selectedOwnerNames.length === 1
                      ? selectedOwnerNames[0]
                      : `${selectedOwnerNames.length} selected`}
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
                  ? "None"
                  : allTeamsSelected
                    ? "All"
                    : selectedCollegeTeams.length === 1
                      ? selectedCollegeTeams[0]
                      : `${selectedCollegeTeams.length} selected`}
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
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedCollegeTeams([])}
                      disabled={selectedCollegeTeams.length === 0}
                      className="pool-btn-ghost flex-1"
                    >
                      None
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
                    onClick={() => setSelectedOwnerNames(ownerOptions)}
                    disabled={allOwnersSelected}
                    className="pool-btn-ghost flex-1"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedOwnerNames([])}
                    disabled={selectedOwnerNames.length === 0}
                    className="pool-btn-ghost flex-1"
                  >
                    None
                  </button>
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {ownerOptions.map((name) => {
                    const checked = selectedOwnerNameSet.has(name);
                    return (
                      <label key={name} className="pool-picker-row w-full">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setSelectedOwnerNames((prev) =>
                              prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
                            )
                          }
                        />
                        <span className="truncate">{name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </>
          )}
          <HeatBadgeLegend className="ml-auto" />
        </div>

        <div className="pool-text-muted-sm mb-2 hidden md:block">
          {meta ? (
            <span>
              Showing {displayedRows.length}
              {displayedRows.length !== meta.count ? ` of ${meta.count}` : ""} after filters.
              {leagueContext ? (
                <span className="ml-1">Owner column uses your active league.</span>
              ) : (
                <span className="ml-1">
                  Set league via Draft or <code className="pool-code text-[10px]">?leagueId=</code>.
                </span>
              )}
            </span>
          ) : null}
        </div>
        {error && <div className="pool-alert-danger pool-alert-compact text-sm mb-2">{error}</div>}

        {busy && rows.length === 0 ? (
          <PoolTableSkeleton rows={8} />
        ) : (
        <div className="pool-card pool-card-compact min-w-0">
          <div className="min-w-0 overflow-x-hidden md:overflow-x-auto">
            <table className="pool-table pool-players-stat-table w-full text-xs min-w-[1040px]">
              <thead>
                <tr>
                  <th className="w-10 max-md:hidden p-1 text-center" scope="col">
                    <span className="sr-only">Team logo</span>
                  </th>
                  <th className="w-10 p-1 text-center" scope="col">
                    <span className="sr-only">Player photo</span>
                  </th>
                  <SortableTh
                    column="player"
                    sortKey={sortState.column}
                    sortDir={sortState.dir}
                    onSort={handleSortClick}
                    align="left"
                    className="min-w-[140px]"
                    title="Player name"
                  >
                    Player
                  </SortableTh>
                  <SortableTh
                    column="owner"
                    sortKey={sortState.column}
                    sortDir={sortState.dir}
                    onSort={handleSortClick}
                    align="left"
                    className="min-w-[100px]"
                    title="Fantasy team in your active league"
                  >
                    Owner
                  </SortableTh>
                  <SortableTh
                    column="seed"
                    sortKey={sortState.column}
                    sortDir={sortState.dir}
                    onSort={handleSortClick}
                    align="center"
                    title="Regional pod seed"
                  >
                    Seed
                  </SortableTh>
                  <SortableTh
                    column="overall"
                    sortKey={sortState.column}
                    sortDir={sortState.dir}
                    onSort={handleSortClick}
                    align="center"
                    className="min-w-[2.5rem]"
                    title="NCAA committee overall seed (1–68)"
                  >
                    Overall
                  </SortableTh>
                  <SortableTh
                    column="ppg"
                    sortKey={sortState.column}
                    sortDir={sortState.dir}
                    onSort={handleSortClick}
                    align="center"
                    title="Season points per game"
                  >
                    PPG
                  </SortableTh>
                  <SortableTh
                    column="tppg"
                    sortKey={sortState.column}
                    sortDir={sortState.dir}
                    onSort={handleSortClick}
                    align="center"
                    title="Tournament Points per Game — average fantasy points per R1–R6 round that has box score data"
                  >
                    TPPG
                  </SortableTh>
                  {([1, 2, 3, 4, 5, 6] as const).map((r) => (
                    <SortableTh
                      key={r}
                      column={ROUND_SORT_COLUMNS[r - 1]}
                      sortKey={sortState.column}
                      sortDir={sortState.dir}
                      onSort={handleSortClick}
                      align="center"
                      className="w-9 px-0.5"
                      title={
                        r === 1
                          ? "Round 1 — round of 64 (First Four excluded)"
                          : `Round ${r} tournament fantasy points (live + final box scores)`
                      }
                    >
                      R{r}
                    </SortableTh>
                  ))}
                  <SortableTh
                    column="total"
                    sortKey={sortState.column}
                    sortDir={sortState.dir}
                    onSort={handleSortClick}
                    align="center"
                    className="pool-table-col-primary min-w-[2.75rem] px-0.5"
                    title="Sum of R1–R6 tournament fantasy points (actual only)"
                  >
                    Total
                  </SortableTh>
                  <SortableTh
                    column="origProj"
                    sortKey={sortState.column}
                    sortDir={sortState.dir}
                    onSort={handleSortClick}
                    align="center"
                    title="Pre-tournament: season PPG × full chalk expected games for this team (NCAA bracket, all favorites win)"
                  >
                    Orig
                  </SortableTh>
                  <SortableTh
                    column="liveProj"
                    sortKey={sortState.column}
                    sortDir={sortState.dir}
                    onSort={handleSortClick}
                    align="center"
                    title="Actual R1–R6 fantasy points + season PPG × remaining chalk games (full expected − games played: decisive finals or live; 0 remaining if eliminated)"
                  >
                    Live
                  </SortableTh>
                  <SortableTh
                    column="plusMinus"
                    sortKey={sortState.column}
                    sortDir={sortState.dir}
                    onSort={handleSortClick}
                    align="center"
                    className="w-11"
                    title="Live projection − original projection (green if ahead, red if behind)"
                  >
                    +/-
                  </SortableTh>
                </tr>
              </thead>
            <tbody>
              {displayedRows.map((p) => {
                const ps = poolStatRanks;
                const t = p.team;
                const teamLabel = displayCollegeTeam(t);
                const teamLogoUrl = resolveEspnTeamLogoForPoolRow({
                  logoUrl: t?.logoUrl != null ? String(t.logoUrl) : null,
                  shortName: t?.shortName != null ? String(t.shortName) : null,
                  fullName: t?.name != null ? String(t.name) : null
                });
                const headshotUrls =
                  p.headshotUrls?.length ?
                    p.headshotUrls
                  : resolvePlayerHeadshotUrlCandidates({
                      headshot_url: p.headshot_url,
                      espn_athlete_id: p.espn_athlete_id
                    });
                const seedDisplay = t?.seed != null && t.seed !== "" ? String(t.seed) : "—";
                const ppg =
                  p.season_ppg != null && String(p.season_ppg).trim() !== ""
                    ? Number(p.season_ppg).toFixed(1)
                    : "—";
                const liveProjVal =
                  p.projection != null && Number.isFinite(Number(p.projection))
                    ? Number(p.projection)
                    : p.projectionChalk != null && Number.isFinite(Number(p.projectionChalk))
                      ? Number(p.projectionChalk)
                      : null;
                const liveProj = liveProjVal != null ? String(Math.round(liveProjVal)) : "—";
                const origVal =
                  p.originalProjection != null && Number.isFinite(Number(p.originalProjection))
                    ? Number(p.originalProjection)
                    : null;
                const origProj = origVal != null ? String(Math.round(origVal)) : "—";
                const liveRounded = liveProjVal != null ? Math.round(liveProjVal) : null;
                const origRounded = origVal != null ? Math.round(origVal) : null;
                const projPlusMinus = getProjectionPlusMinusInfo(liveRounded, origRounded);
                const chalkRem = p.chalkGamesRemaining;
                const chalkTot = p.expectedChalkGamesTotal;
                const chalkDone = p.completedTournamentGames;
                const liveProjTitle =
                  ppg !== "—" && chalkTot != null && chalkDone != null && chalkRem != null
                    ? `Actual pts + ${ppg} PPG × ${chalkRem} remaining (${chalkTot} chalk expected − ${chalkDone} games played: finals or live)`
                    : "Actual tournament points + season PPG × remaining expected chalk games";
                const origProjTitle =
                  ppg !== "—" && chalkTot != null
                    ? `${ppg} PPG × ${chalkTot} expected chalk games (full run)`
                    : "Season PPG × full chalk expected games";

                const posTrim =
                  p.position != null && String(p.position).trim() !== "" ? String(p.position).trim() : "";
                const seasonPpgN = ppgNumeric(p);
                const heatInfo =
                  seasonPpgN != null
                    ? computeHeatBadgeInfo(roundScoresFromTournamentRoundPoints(p.tournamentRoundPoints), seasonPpgN)
                    : null;

                const roundRanks = [ps.r1, ps.r2, ps.r3, ps.r4, ps.r5, ps.r6] as const;

                return (
                  <tr
                    key={p.id}
                    className={`cursor-pointer group pool-table-row ${
                      eliminatedRoundForPlayer(p) != null ? "pool-table-row-eliminated" : ""
                    }`}
                  >
                    <PoolTableTeamLogoCell url={teamLogoUrl} teamName={teamLabel} />
                    <PoolTablePlayerPhotoCell urls={headshotUrls} playerName={p.name} />
                    <td className="px-1 py-2 transition-colors text-left align-top">
                      <span className="inline-flex items-baseline gap-1 flex-wrap min-w-0">
                        <PlayersPoolPlayerNameLink playerName={p.name} espnAthleteId={p.espn_athlete_id} />
                        {posTrim ? (
                          <span className="hidden text-[10px] sm:text-[11px] text-foreground/65 font-normal tabular-nums shrink-0 md:inline">
                            {posTrim}
                          </span>
                        ) : null}
                        {heatInfo && seasonPpgN != null ? (
                          <PlayerHeatBadge info={heatInfo} seasonPpg={seasonPpgN} className="shrink-0" />
                        ) : null}
                      </span>
                      <div className="text-[10px] sm:text-[11px] text-foreground/65 mt-1 leading-snug font-normal flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                        <span className="text-foreground/75 font-medium line-clamp-2 min-w-0">{teamLabel}</span>
                        <span className="text-foreground/35" aria-hidden>
                          ·
                        </span>
                        <span className="text-foreground/80">{displayRegionName(t?.region)}</span>
                      </div>
                    </td>
                    <td className="px-1 py-2 text-left text-foreground/85 transition-colors align-top pool-table-col-group-end">
                      {ownerLabel(p)}
                    </td>
                    <td className="px-1 py-2 text-center transition-colors">{seedDisplay}</td>
                    <td className="px-1 py-2 text-center transition-colors pool-table-col-group-end">
                      {overallDisplay(p)}
                    </td>
                    <td className="px-1 py-2 text-center transition-colors sleeper-score-font">
                      <StatPoolCellWithRank rank={ps.ppg.get(p.id)} poolSize={ps.poolSize}>
                        {ppg}
                      </StatPoolCellWithRank>
                    </td>
                    <td
                      className="px-1 py-2 text-center transition-colors sleeper-score-font"
                      title="Tournament Points per Game (R1–R6 rounds with box scores)"
                    >
                      <StatPoolCellWithRank rank={ps.tppg.get(p.id)} poolSize={ps.poolSize}>
                        {tournamentPpgDisplay(p)}
                      </StatPoolCellWithRank>
                    </td>
                    {([1, 2, 3, 4, 5, 6] as const).map((r) => (
                      <td
                        key={r}
                        className="px-0.5 py-2 text-center transition-colors sleeper-score-font"
                        title={`R${r} tournament fantasy points`}
                      >
                        <StatPoolCellWithRank rank={roundRanks[r - 1].get(p.id)} poolSize={ps.poolSize}>
                          {tournamentRoundPointsCell(p, r)}
                        </StatPoolCellWithRank>
                      </td>
                    ))}
                    <td
                      className="px-0.5 py-2 text-center transition-colors sleeper-score-font pool-table-col-primary pool-table-col-group-end"
                      title="R1 + R2 + R3 + R4 + R5 + R6 tournament fantasy points"
                    >
                      <StatPoolCellWithRank rank={ps.total.get(p.id)} poolSize={ps.poolSize}>
                        {tournamentR1ToR6TotalDisplay(p)}
                      </StatPoolCellWithRank>
                    </td>
                    <td
                      className="px-1 py-2 text-center transition-colors sleeper-score-font"
                      title={origProjTitle}
                    >
                      <StatPoolCellWithRank rank={ps.origProj.get(p.id)} poolSize={ps.poolSize}>
                        {origProj}
                      </StatPoolCellWithRank>
                    </td>
                    <td
                      className="px-1 py-2 text-center transition-colors sleeper-score-font"
                      title={liveProjTitle}
                    >
                      <StatPoolCellWithRank rank={ps.liveProj.get(p.id)} poolSize={ps.poolSize}>
                        {liveProj}
                      </StatPoolCellWithRank>
                    </td>
                    <td
                      className="px-1 py-2 text-center transition-colors sleeper-score-font"
                      title={
                        liveRounded != null && origRounded != null
                          ? `Live projection (${liveRounded}) − original projection (${origRounded})`
                          : "Live projection − original projection"
                      }
                    >
                      <StatPoolCellWithRank rank={ps.plusMinus.get(p.id)} poolSize={ps.poolSize}>
                        {projPlusMinus.value == null ? (
                          projPlusMinus.text
                        ) : (
                          <span
                            className={
                              projPlusMinus.value >= 0 ? "text-success" : "text-danger"
                            }
                          >
                            {projPlusMinus.text}
                          </span>
                        )}
                      </StatPoolCellWithRank>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && !busy && (
                <tr className="pool-table-empty">
                  <td colSpan={18} className="py-8 text-center pool-text-faint text-[11px]">
                    No players with <strong>season PPG &gt; 0</strong> for this season (blank or zero PPG are
                    hidden). In Commissioner, use <strong>Easy commissioner actions</strong> →{" "}
                    <strong>Run full tournament setup</strong> (with roster import) or step{" "}
                    <strong>4 · Import / refresh players (ESPN)</strong>.
                  </td>
                </tr>
              )}
              {rows.length > 0 && !busy && displayedRows.length === 0 && (
                <tr className="pool-table-empty">
                  <td colSpan={18} className="py-8 text-center pool-text-faint text-[11px]">
                    No players match current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
