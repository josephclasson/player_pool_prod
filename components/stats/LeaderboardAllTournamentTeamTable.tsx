"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { PoolTablePlayerPhotoCell, PoolTableTeamLogoCell } from "@/components/stats/PoolTableMediaCells";
import { PlayerHeatBadge } from "@/components/stats/PlayerHeatBadge";
import { espnMensCollegeBasketballPlayerProfileUrl } from "@/lib/espn-mbb-directory";
import {
  allLeagueDraftedPlayers,
  bestPlayerPerDraftRound,
  HIGHLIGHT_DRAFT_ROUNDS,
  sumTournamentPoints,
  topKAllTournamentPlayers,
  worstPlayerPerDraftRound
} from "@/lib/all-tournament-team";
import { computeHeatBadgeInfo } from "@/lib/player-heat-badge";
import type { LeaderboardRosterPlayerApi } from "@/lib/scoring/persist-league-scoreboard";

type RoundScores = Record<number, number | null | undefined>;

type TablePlayer = {
  rosterSlotId: string;
  playerId: string;
  espnAthleteId: number | null;
  playerName: string;
  ownerName: string;
  position: string | null;
  teamName: string;
  headshotUrls: string[];
  teamLogoUrl: string | null;
  roundScores: RoundScores;
  seed: number | null;
  overallSeed: number | null;
  /** Raw region label from team row (for Bracket column abbreviation). */
  regionLabel: string;
  seasonPpg: number;
  total: number;
  projection: number;
  originalProjection: number | null;
  eliminated: boolean;
  eliminatedRound: number | null;
};

function rosterRowToTablePlayer(p: LeaderboardRosterPlayerApi): TablePlayer {
  const roundScores: RoundScores = {};
  for (let r = 1; r <= 6; r++) {
    if (Object.prototype.hasOwnProperty.call(p.tournamentRoundPoints, r)) {
      roundScores[r] = p.tournamentRoundPoints[r];
    }
  }
  const proj =
    p.projection != null && Number.isFinite(Number(p.projection)) ? Number(p.projection) : 0;
  const team = p.team;
  const teamName =
    team?.name != null && String(team.name).trim() !== ""
      ? String(team.name).trim()
      : team != null && team.id > 0
        ? `Team #${team.id}`
        : "—";
  const regionRaw =
    team?.region != null && String(team.region).trim() !== "" ? String(team.region).trim() : "";

  return {
    rosterSlotId: p.rosterSlotId,
    playerId: String(p.playerId),
    espnAthleteId: p.espnAthleteId,
    playerName: p.name,
    ownerName: String(p.ownerName ?? "").trim() || "—",
    position: p.position,
    teamName,
    headshotUrls: p.headshotUrls,
    teamLogoUrl: team?.logoUrl ?? null,
    roundScores,
    seed: team?.seed ?? null,
    overallSeed: p.overallSeed,
    regionLabel: regionRaw,
    seasonPpg: p.seasonPpg != null && Number.isFinite(Number(p.seasonPpg)) ? Number(p.seasonPpg) : 0,
    total: sumTournamentPoints(p),
    projection: proj,
    originalProjection: p.originalProjection,
    eliminated: p.eliminated ?? false,
    eliminatedRound: p.eliminatedRound ?? null
  };
}

/** Full bracket region for display (matches StatTracker under team name). */
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

function formatMaybeNumber(v: number | null | undefined) {
  if (v === null || v === undefined) return "";
  return v;
}

function playerRowKey(p: TablePlayer): string {
  const sid = p.rosterSlotId != null ? String(p.rosterSlotId).trim() : "";
  if (sid) return sid;
  return String(p.playerId);
}

function roundPointsNumeric(p: TablePlayer, displayRound: number): number | null {
  const v = p.roundScores?.[displayRound];
  if (v === null || v === undefined) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function displayRoundScoreCell(p: TablePlayer, displayRound: number): number | string {
  const er = p.eliminatedRound;
  if (er != null && Number.isFinite(er) && displayRound > er) return "E";
  const v = p.roundScores?.[displayRound];
  if (v !== null && v !== undefined) return v;
  return "";
}

function tournamentPpgNumeric(p: TablePlayer): number | null {
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

function getTppgMinusSeasonInfo(p: TablePlayer): { text: string; value: number | null } {
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

function computeDisplayTournamentPpg(p: TablePlayer) {
  const tournamentPpg = tournamentPpgNumeric(p);
  return tournamentPpg == null ? p.seasonPpg : tournamentPpg;
}

function ranksHigherIsBetter(
  players: TablePlayer[],
  getValue: (p: TablePlayer) => number | null
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

/** Lower numeric value ranks better (e.g. NCAA overall seed 1–68). */
function ranksLowerIsBetter(
  players: TablePlayer[],
  getValue: (p: TablePlayer) => number | null
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

function buildLeagueStatRanks(players: TablePlayer[]): LeagueStatRanks {
  const empty = (): LeagueStatRanks => ({
    draftedCount: 0,
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
    overallSeed: ranksLowerIsBetter(players, (p) => (p.overallSeed != null && Number.isFinite(p.overallSeed) ? p.overallSeed : null)),
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

function playerAdvancedThroughCurrentRound(p: TablePlayer, currentRound: number): boolean {
  const R = currentRound <= 0 ? 1 : currentRound;
  const er = p.eliminatedRound;
  if (er == null) {
    return !p.eliminated;
  }
  return er > R;
}

function computeFooterTotals(visible: TablePlayer[], currentRound: number) {
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

  let liveProjSum: number | null = null;
  if (visible.length > 0 && visible.every((p) => Number.isFinite(p.projection))) {
    liveProjSum = visible.reduce((s, p) => s + Math.round(p.projection), 0);
  }

  let origProjSum = "—";
  if (
    visible.length > 0 &&
    visible.every((p) => p.originalProjection != null && Number.isFinite(p.originalProjection))
  ) {
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
    advancedCount
  };
}

function InlineLeagueStatRank({
  rank,
  draftedCount,
  context = "player-league"
}: {
  rank: number | undefined;
  draftedCount: number;
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
  showRank?: boolean;
  rankContext?: "player-league" | "owner-aggregate";
}) {
  return (
    <div className={["flex flex-col items-center justify-center gap-0", className].filter(Boolean).join(" ")}>
      <div>{children}</div>
      {showRank ? (
        <InlineLeagueStatRank rank={rank} draftedCount={draftedCount} context={rankContext} />
      ) : null}
    </div>
  );
}

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
      >
        {playerName}
      </a>
    );
  }
  return <span className="font-semibold">{playerName}</span>;
}

function EmptyHighlightTableRow({ showTppgColumns }: { showTppgColumns: boolean }) {
  const projBlockDivider = showTppgColumns ? " pool-table-col-total-divider" : "";
  const d = "px-1 py-2 text-center text-foreground/45 align-middle";
  const dLeft = "px-1 py-2 text-left text-foreground/45 align-middle";
  return (
    <tr className="pool-table-row">
      <PoolTableTeamLogoCell url={null} teamName="" />
      <PoolTablePlayerPhotoCell urls={[]} playerName="" />
      <td className={`${dLeft} align-top`}>—</td>
      <td className={`${dLeft} pool-table-col-group-end min-w-0 max-w-[9rem]`}>—</td>
      <td className={d}>—</td>
      <td className={`${d} tabular-nums pool-table-col-group-end`}>—</td>
      <td className={d}>—</td>
      {showTppgColumns ? (
        <>
          <td className={`${d} text-foreground/80`}>—</td>
          <td className={d}>—</td>
        </>
      ) : null}
      <td className={`${d} sleeper-score-font`}>—</td>
      <td className={`${d} sleeper-score-font`}>—</td>
      <td className={`${d} sleeper-score-font`}>—</td>
      <td className={`${d} sleeper-score-font`}>—</td>
      <td className={`${d} sleeper-score-font`}>—</td>
      <td className={`${d} sleeper-score-font`}>—</td>
      <td className={`${d} sleeper-score-font pool-table-col-primary${projBlockDivider}`}>—</td>
      <td className={`${d} sleeper-score-font`}>—</td>
      <td className={`${d} sleeper-score-font`}>—</td>
      <td className={`${d} sleeper-score-font`}>—</td>
    </tr>
  );
}

const ALL_TOURNAMENT_TEAM_SIZE = 8;

type LeaderboardPlayersHighlightTableProps = {
  title: string;
  subtitle: ReactNode;
  bodyRows: (TablePlayer | null)[];
  allTablePlayers: TablePlayer[];
  currentRound: number;
  showTppgColumns: boolean;
  showInlineRanks: boolean;
};

function LeaderboardPlayersHighlightTable({
  title,
  subtitle,
  bodyRows,
  allTablePlayers,
  currentRound,
  showTppgColumns,
  showInlineRanks
}: LeaderboardPlayersHighlightTableProps) {
  const [open, setOpen] = useState(true);
  const leagueStatRanks = buildLeagueStatRanks(allTablePlayers);
  const filledRows = bodyRows.filter((p): p is TablePlayer => p != null);
  const footer = computeFooterTotals(filledRows, currentRound);
  const seedSum = filledRows.reduce((sum, p) => sum + (p.seed ?? 0), 0);
  const overallSum = filledRows.reduce((sum, p) => sum + (p.overallSeed ?? 0), 0);
  const hasAnySeed = filledRows.some((p) => p.seed != null);
  const hasAnyOverall = filledRows.some((p) => p.overallSeed != null);
  const seedFooterDisplay: ReactNode =
    filledRows.length === 0 || !hasAnySeed ? "—" : <span className="tabular-nums font-semibold">{seedSum}</span>;
  const overallFooterDisplay: ReactNode =
    filledRows.length === 0 || !hasAnyOverall ? "—" : <span className="tabular-nums font-semibold">{overallSum}</span>;

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

  const dc = leagueStatRanks.draftedCount;
  const projBlockDivider = showTppgColumns ? " pool-table-col-total-divider" : "";

  return (
    <div className="pool-card pool-card-compact mt-4 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md pool-card-header pool-owner-header text-left"
        aria-expanded={open}
      >
        <div className="flex min-w-0 items-center gap-1 shrink-0">
          <span className="text-sm font-semibold pool-owner-name">{title}</span>
        </div>
        <div className="pool-owner-header-stat-meta hidden md:flex min-w-0 flex-1 flex-wrap items-baseline justify-end gap-x-1.5 gap-y-0.5 text-right text-[10px] sm:text-[11px] font-normal tabular-nums">
          {subtitle}
        </div>
        <div className="text-xs flex items-center gap-2 pool-owner-chevron shrink-0">
          {open ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
        </div>
      </button>

      {open ? (
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
              <th className="text-left min-w-[9rem]" title="Player name, position, and college team">
                Player
              </th>
              <th className="text-left min-w-[5.5rem]" title="Pool owner who drafted this player">
                Owner
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
              <th className="text-center" title="Pre-tournament: season PPG × full chalk expected games">
                Orig
              </th>
              <th
                className="text-center"
                title="Actual tournament points + season PPG × remaining expected chalk games"
              >
                Live
              </th>
              <th className="text-center w-11" title="Live projection − original projection">
                +/−
              </th>
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((p, rowIdx) => {
              if (!p) {
                return <EmptyHighlightTableRow key={`empty-${rowIdx}`} showTppgColumns={showTppgColumns} />;
              }
              const liveR = Math.round(p.projection);
              const origR =
                p.originalProjection != null && Number.isFinite(p.originalProjection)
                  ? Math.round(p.originalProjection)
                  : null;
              const projPm = getProjectionPlusMinusInfo(liveR, origR);
              const tppgPm = getTppgMinusSeasonInfo(p);
              const rowKey = playerRowKey(p);
              const heatInfo = computeHeatBadgeInfo(p.roundScores, p.seasonPpg);
              return (
                <tr
                  key={p.rosterSlotId || p.playerId}
                  className={`pool-table-row ${p.eliminated ? "pool-table-row-eliminated" : ""}`}
                >
                  <PoolTableTeamLogoCell url={p.teamLogoUrl} teamName={p.teamName} />
                  <PoolTablePlayerPhotoCell urls={p.headshotUrls} playerName={p.playerName} />
                  <td className="px-1 py-2 transition-colors text-left align-top">
                    <span className="inline-flex items-baseline gap-1 flex-wrap min-w-0">
                      <StatTrackerPlayerNameLink playerName={p.playerName} espnAthleteId={p.espnAthleteId} />
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
                      <span className="text-foreground/80">{displayRegionName(p.regionLabel)}</span>
                    </div>
                  </td>
                  <td className="px-1 py-2 text-left text-foreground/85 transition-colors align-top pool-table-col-group-end min-w-0 max-w-[9rem]">
                    <span className="truncate block" title={p.ownerName}>
                      {p.ownerName}
                    </span>
                  </td>
                  <td
                    className="px-1 py-2 text-center transition-colors"
                    title={p.seed != null ? `Regional seed ${p.seed}` : undefined}
                  >
                    {p.seed != null ? <span className="tabular-nums">{p.seed}</span> : "—"}
                  </td>
                  <td
                    className="px-1 py-2 text-center transition-colors tabular-nums pool-table-col-group-end"
                    title={
                      p.overallSeed != null
                        ? `NCAA overall seed ${p.overallSeed} of 68 (selection committee S-curve)`
                        : undefined
                    }
                  >
                    <StatCellWithRank
                      showRank={false}
                      rank={leagueStatRanks.overallSeed.get(rowKey)}
                      draftedCount={dc}
                    >
                      {p.overallSeed != null ? p.overallSeed : "—"}
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
                          <span className={tppgPm.value >= 0 ? "text-success" : "text-danger"}>{tppgPm.text}</span>
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
                  <td className="px-1 py-2 text-center transition-colors sleeper-score-font">
                    <StatCellWithRank showRank={showInlineRanks} rank={leagueStatRanks.origProj.get(rowKey)} draftedCount={dc}>
                      {origR != null ? String(origR) : "—"}
                    </StatCellWithRank>
                  </td>
                  <td className="px-1 py-2 text-center transition-colors sleeper-score-font">
                    <StatCellWithRank showRank={showInlineRanks} rank={leagueStatRanks.liveProj.get(rowKey)} draftedCount={dc}>
                      {String(liveR)}
                    </StatCellWithRank>
                  </td>
                  <td className="px-1 py-2 text-center transition-colors sleeper-score-font">
                    <StatCellWithRank
                      showRank={showInlineRanks}
                      rank={leagueStatRanks.projPlusMinus.get(rowKey)}
                      draftedCount={dc}
                    >
                      {projPm.value == null ? (
                        projPm.text
                      ) : (
                        <span className={projPm.value >= 0 ? "text-success" : "text-danger"}>{projPm.text}</span>
                      )}
                    </StatCellWithRank>
                  </td>
                </tr>
              );
            })}
            <tr className="pool-table-footer-row">
              <td colSpan={2} className="w-10 p-1 px-1 py-2 text-center text-[11px] font-semibold align-middle">
                TOTALS
              </td>
              <td
                colSpan={2}
                className="px-1 py-2 text-left text-[11px] font-normal tabular-nums opacity-90 align-middle leading-tight pool-table-col-group-end"
              >
                {footer.remainingPlayers} remaining {footer.remainingPlayers === 1 ? "player" : "players"}
              </td>
              <td className="px-1 py-2 text-center font-semibold">
                <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                  {seedFooterDisplay}
                </StatCellWithRank>
              </td>
              <td className="px-1 py-2 text-center font-semibold tabular-nums pool-table-col-group-end">
                <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                  {overallFooterDisplay}
                </StatCellWithRank>
              </td>
              <td className="px-1 py-2 text-center font-semibold">
                <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                  {footer.seasonPpgAvg}
                </StatCellWithRank>
              </td>
              {showTppgColumns ? (
                <td className="px-1 py-2 text-center font-semibold">
                  <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                    {footer.tppgAvg}
                  </StatCellWithRank>
                </td>
              ) : null}
              {showTppgColumns ? (
                <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                  <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                    <span className={tppgFooterClass}>{tppgFooterText}</span>
                  </StatCellWithRank>
                </td>
              ) : null}
              <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                  {formatMaybeNumber(footer.roundScores[1])}
                </StatCellWithRank>
              </td>
              <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                  {formatMaybeNumber(footer.roundScores[2])}
                </StatCellWithRank>
              </td>
              <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                  {formatMaybeNumber(footer.roundScores[3])}
                </StatCellWithRank>
              </td>
              <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                  {formatMaybeNumber(footer.roundScores[4])}
                </StatCellWithRank>
              </td>
              <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                  {formatMaybeNumber(footer.roundScores[5])}
                </StatCellWithRank>
              </td>
              <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                  {formatMaybeNumber(footer.roundScores[6])}
                </StatCellWithRank>
              </td>
              <td
                className={`px-1 py-2 text-center font-semibold sleeper-score-font pool-table-col-primary${projBlockDivider}`}
              >
                <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                  {footer.totalPts}
                </StatCellWithRank>
              </td>
              <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                  {footer.origProjSum}
                </StatCellWithRank>
              </td>
              <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                  {footer.liveProjSum != null ? String(footer.liveProjSum) : "—"}
                </StatCellWithRank>
              </td>
              <td className="px-1 py-2 text-center font-semibold sleeper-score-font">
                <StatCellWithRank showRank={false} rank={undefined} draftedCount={0}>
                  <span className={projFooterClass}>{projFooterText}</span>
                </StatCellWithRank>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      ) : null}
    </div>
  );
}

export function LeaderboardAllTournamentTeamTable({
  teams,
  currentRound,
  showTppgColumns,
  showInlineRanks
}: {
  teams: Array<{ players?: LeaderboardRosterPlayerApi[] }>;
  currentRound: number;
  showTppgColumns: boolean;
  showInlineRanks: boolean;
}) {
  const drafted = allLeagueDraftedPlayers(teams);
  if (drafted.length === 0) return null;

  const allTablePlayers = drafted.map(rosterRowToTablePlayer);
  const topApi = topKAllTournamentPlayers(drafted, ALL_TOURNAMENT_TEAM_SIZE);
  const bodyRows: (TablePlayer | null)[] = topApi.map(rosterRowToTablePlayer);

  return (
    <LeaderboardPlayersHighlightTable
      title="All-Tournament Team"
      subtitle={<span>Top {ALL_TOURNAMENT_TEAM_SIZE} by Tournament Points</span>}
      bodyRows={bodyRows}
      allTablePlayers={allTablePlayers}
      currentRound={currentRound}
      showTppgColumns={showTppgColumns}
      showInlineRanks={showInlineRanks}
    />
  );
}

export function LeaderboardBestSelectionByRoundTable({
  teams,
  currentRound,
  showTppgColumns,
  showInlineRanks
}: {
  teams: Array<{ players?: LeaderboardRosterPlayerApi[] }>;
  currentRound: number;
  showTppgColumns: boolean;
  showInlineRanks: boolean;
}) {
  const drafted = allLeagueDraftedPlayers(teams);
  if (drafted.length === 0) return null;

  const numTeams = teams.length;
  if (numTeams < 1) return null;

  const allTablePlayers = drafted.map(rosterRowToTablePlayer);
  const bestApi = bestPlayerPerDraftRound(drafted, numTeams);
  const bodyRows: (TablePlayer | null)[] = bestApi.map((api: LeaderboardRosterPlayerApi | null) =>
    api ? rosterRowToTablePlayer(api) : null
  );

  return (
    <LeaderboardPlayersHighlightTable
      title="Best Selection by Round"
      subtitle={
        <span>
          Top scorer per draft round (rows 1–{HIGHLIGHT_DRAFT_ROUNDS}); overall pick # and league size (
          {numTeams} {numTeams === 1 ? "team" : "teams"})
        </span>
      }
      bodyRows={bodyRows}
      allTablePlayers={allTablePlayers}
      currentRound={currentRound}
      showTppgColumns={showTppgColumns}
      showInlineRanks={showInlineRanks}
    />
  );
}

export function LeaderboardWorstSelectionByRoundTable({
  teams,
  currentRound,
  showTppgColumns,
  showInlineRanks
}: {
  teams: Array<{ players?: LeaderboardRosterPlayerApi[] }>;
  currentRound: number;
  showTppgColumns: boolean;
  showInlineRanks: boolean;
}) {
  const drafted = allLeagueDraftedPlayers(teams);
  if (drafted.length === 0) return null;

  const numTeams = teams.length;
  if (numTeams < 1) return null;

  const allTablePlayers = drafted.map(rosterRowToTablePlayer);
  const worstApi = worstPlayerPerDraftRound(drafted, numTeams);
  const bodyRows: (TablePlayer | null)[] = worstApi.map((api: LeaderboardRosterPlayerApi | null) =>
    api ? rosterRowToTablePlayer(api) : null
  );

  return (
    <LeaderboardPlayersHighlightTable
      title="Worst Selection by Round"
      subtitle={
        <span>
          Lowest scorer per draft round (rows 1–{HIGHLIGHT_DRAFT_ROUNDS}); overall pick # and league size (
          {numTeams} {numTeams === 1 ? "team" : "teams"})
        </span>
      }
      bodyRows={bodyRows}
      allTablePlayers={allTablePlayers}
      currentRound={currentRound}
      showTppgColumns={showTppgColumns}
      showInlineRanks={showInlineRanks}
    />
  );
}
