"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, GraduationCap } from "lucide-react";
import { readStoredActiveLeagueId, writeStoredActiveLeagueId } from "@/lib/player-pool-storage";
import {
  PLAYER_POOL_IDENTITY_CHANGE_EVENT,
  readPlayerPoolSession,
  type PlayerPoolSession
} from "@/lib/player-pool-session";
import { PoolTablePlayerPhotoCell, PoolTableTeamLogoCell } from "@/components/stats/PoolTableMediaCells";
import { resolveEspnTeamLogoForPoolRow } from "@/lib/espn-ncaam-assets";
import { espnMensCollegeBasketballPlayerProfileUrl } from "@/lib/espn-mbb-directory";
import { displayCollegeTeamNameForUi } from "@/lib/college-team-display";

type DraftStateResponse = {
  seasonYear?: number | null;
  lastSyncedAt?: string | null;
  draftRoom: {
    id: string;
    leagueId: string;
    status: string;
    totalRounds: number;
    rosterSize: number;
    pickTimerSeconds: number;
    currentPickOverall: number;
    startedAt: string | null;
    completedAt: string | null;
  };
  draftOrder: string[];
  currentTurn: {
    roundNumber: number;
    pickNumberInRound: number;
    leagueTeamId: string | null;
  };
  picks: Array<{
    pickOverall: number;
    roundNumber: number;
    pickNumberInRound: number;
    leagueTeamId: string;
    ownerName: string;
    player: {
      id: number;
      name: string;
      shortName: string | null;
      espnAthleteId?: number | string | null;
      position?: string | null;
      headshotUrls?: string[];
      seasonPpg: number | null;
      projection?: number | null;
      originalProjection?: number | null;
      team: {
        id: number;
        name: string;
        shortName?: string | null;
        seed: number | null;
        region: string | null;
        conference: string | null;
        isPower5: boolean;
        logoUrl?: string | null;
      } | null;
    };
  }>;
  availablePlayers: Array<{
    id: number;
    name: string;
    shortName: string | null;
    espnAthleteId?: number | string | null;
    position?: string | null;
    seasonPpg: number | null;
    headshotUrls?: string[];
    displayHeadshotUrl?: string | null;
    chalkProjection?: number;
    /** Pre-tournament projection (Orig Proj on Player Statistics). */
    projection?: number | null;
    originalProjection?: number | null;
    projectionPlusMinus?: number | null;
    tppg?: number | null;
    team: {
      id: number;
      name: string;
      shortName?: string | null;
      seed: number | null;
      overallSeed?: number | null;
      region: string | null;
      conference: string | null;
      isPower5: boolean;
      logoUrl?: string | null;
    } | null;
  }>;
  leagueTeams?: Array<{ id: string; teamName: string }>;
  yourLeagueTeamId: string | null;
  /** True when request included officer auth and draft is in progress — commissioner proxy picks. */
  viewerCanCommissionerPick?: boolean;
};

type AvailablePlayer = DraftStateResponse["availablePlayers"][number];

type DraftPlayerForAdp = {
  id: number;
  name: string;
  projection: number | null;
};

function abbrRegion(region: string | null | undefined) {
  const r = region != null ? String(region) : "";
  switch (r) {
    case "West":
      return "W";
    case "East":
      return "E";
    case "Midwest":
      return "MW";
    case "South":
      return "S";
    default:
      return r || "—";
  }
}

function displayCollegeTeam(t: AvailablePlayer["team"]): string {
  if (!t) return "—";
  return displayCollegeTeamNameForUi(
    {
      id: t.id,
      name: t.name,
      short_name: t.shortName
    },
    "—"
  );
}

function displayRegionName(region: string | null | undefined): string {
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

function DraftPlayerNameLink({
  playerName,
  espnAthleteId
}: {
  playerName: string;
  espnAthleteId: string | number | null | undefined;
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

type DraftSortColumn = "name" | "team" | "position" | "seed" | "region" | "ppg" | "projection";

function ppgNumeric(p: AvailablePlayer): number | null {
  if (p.seasonPpg == null || String(p.seasonPpg).trim() === "") return null;
  const n = Number(p.seasonPpg);
  return Number.isFinite(n) ? n : null;
}

function projectionNumeric(p: AvailablePlayer): number | null {
  if (p.projection != null && Number.isFinite(Number(p.projection))) return Number(p.projection);
  return null;
}

function seedNumeric(t: AvailablePlayer["team"]): number | null {
  if (!t || t.seed == null) return null;
  const n = Number(t.seed);
  return Number.isFinite(n) ? n : null;
}

function positionSortKey(p: AvailablePlayer): string {
  const x = p.position;
  if (x != null && String(x).trim() !== "") return String(x).trim();
  return "\uFFFF";
}

function compareNumericNullable(a: number | null, b: number | null, dir: "asc" | "desc"): number {
  const na = a == null;
  const nb = b == null;
  if (na && nb) return 0;
  if (na) return 1;
  if (nb) return -1;
  const raw = a - b;
  return dir === "asc" ? raw : -raw;
}

function compareAvailablePlayers(
  a: AvailablePlayer,
  b: AvailablePlayer,
  col: DraftSortColumn,
  dir: "asc" | "desc"
): number {
  let cmp = 0;
  switch (col) {
    case "name":
      cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      break;
    case "team":
      cmp = displayCollegeTeam(a.team).localeCompare(displayCollegeTeam(b.team), undefined, {
        sensitivity: "base"
      });
      break;
    case "position":
      cmp = positionSortKey(a).localeCompare(positionSortKey(b), undefined, { sensitivity: "base" });
      break;
    case "seed":
      cmp = compareNumericNullable(seedNumeric(a.team), seedNumeric(b.team), dir);
      break;
    case "region":
      cmp = abbrRegion(a.team?.region).localeCompare(abbrRegion(b.team?.region), undefined, {
        sensitivity: "base"
      });
      break;
    case "ppg":
      cmp = compareNumericNullable(ppgNumeric(a), ppgNumeric(b), dir);
      break;
    case "projection":
      cmp = compareNumericNullable(projectionNumeric(a), projectionNumeric(b), dir);
      break;
    default:
      cmp = 0;
  }
  if (col !== "seed" && col !== "ppg" && col !== "projection") {
    if (dir === "desc") cmp = -cmp;
  }
  if (cmp !== 0) return cmp;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function SortableTh({
  column,
  sortKey,
  sortDir,
  onSort,
  title,
  className,
  children
}: {
  column: DraftSortColumn;
  sortKey: DraftSortColumn | null;
  sortDir: "asc" | "desc";
  onSort: (c: DraftSortColumn) => void;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const active = sortKey === column;
  const dirLabel = sortDir === "desc" ? "Descending (click to reverse)" : "Ascending (click to reverse)";
  const fullTitle = active ? [title, dirLabel].filter(Boolean).join(" · ") : title;

  return (
    <th className={className} scope="col">
      <button
        type="button"
        onClick={() => onSort(column)}
        title={fullTitle}
        className={`inline-flex w-full min-w-0 items-center justify-center rounded-sm px-0.5 py-1 font-inherit text-inherit hover:bg-muted/50 transition-colors cursor-pointer ${
          active ? "font-semibold underline decoration-foreground/35 underline-offset-2" : ""
        }`}
      >
        <span className="truncate">{children}</span>
      </button>
    </th>
  );
}

function formatSeconds(secs: number) {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, "0")}` : `${r}s`;
}

/** Static round columns on the draft board (R1–R8). */
const DRAFT_BOARD_ROUND_COUNT = 8;

function pickCellCollegeLine(
  team: DraftStateResponse["picks"][number]["player"]["team"]
): string {
  if (!team) return "";
  const short = team.shortName != null && String(team.shortName).trim() ? String(team.shortName).trim() : "";
  const full = team.name != null && String(team.name).trim() ? String(team.name).trim() : "";
  return short || full || "";
}

function numericProjection(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function adpText(value: number | null): string {
  if (value == null) return "—";
  return String(value);
}

function adpDeltaText(delta: number | null): string {
  if (delta == null) return "—";
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDev(values: number[], mu: number): number {
  if (values.length <= 1) return 0;
  const variance = values.reduce((s, v) => s + (v - mu) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

function gradeFromCurveRank(rank: number, totalOwners: number): { grade: string; percentile: number } {
  if (totalOwners <= 1) return { grade: "A", percentile: 1 };
  // Rank-based percentile guarantees spread by class rank each year.
  const percentile = 1 - (rank - 1) / (totalOwners - 1);
  if (percentile >= 0.9) return { grade: "A", percentile };
  if (percentile >= 0.82) return { grade: "A-", percentile };
  if (percentile >= 0.72) return { grade: "B+", percentile };
  if (percentile >= 0.6) return { grade: "B", percentile };
  if (percentile >= 0.48) return { grade: "B-", percentile };
  if (percentile >= 0.36) return { grade: "C+", percentile };
  if (percentile >= 0.24) return { grade: "C", percentile };
  if (percentile >= 0.14) return { grade: "C-", percentile };
  if (percentile >= 0.07) return { grade: "D", percentile };
  return { grade: "F", percentile };
}

function reportCardBlurb(opts: {
  ownerName: string;
  grade: string;
  rank: number;
  totalOwners: number;
  avgAdp: number | null;
  avgAdpDelta: number | null;
  percentile: number;
}): string {
  const { ownerName, grade, rank, totalOwners, avgAdp, avgAdpDelta, percentile } = opts;
  const adpTxt = avgAdp != null ? avgAdp.toFixed(1) : "—";
  const deltaTxt =
    avgAdpDelta == null ? "—" : avgAdpDelta > 0 ? `+${avgAdpDelta.toFixed(2)}` : avgAdpDelta.toFixed(2);
  const pctTxt = `${Math.round(percentile * 100)}th percentile`;
  const styleIdx = (rank + ownerName.length) % 4;

  if (grade.startsWith("A")) {
    if (styleIdx === 0) {
      return `${ownerName} posted an elite draft profile (${pctTxt}), finishing ${rank}/${totalOwners} with Avg ADP ${adpTxt} and Avg ADP +/- ${deltaTxt}. This class looks like a value-hunting clinic.`;
    }
    if (styleIdx === 1) {
      return `${ownerName} won the room math: ${rank}/${totalOwners}, ${pctTxt}, and a strong ${deltaTxt} Avg ADP +/-. Opponents might call it luck; the board calls it precision.`;
    }
    if (styleIdx === 2) {
      return `${ownerName} turned board equity into results, landing ${rank}/${totalOwners} with Avg ADP ${adpTxt}. Grade ${grade} is exactly what the bell curve expects from a top-tier draft.`;
    }
    return `${ownerName} consistently drafted ahead of market expectation (${deltaTxt}) and earned ${rank}/${totalOwners}. That's a premium draft class by any distribution.`;
  }

  if (grade.startsWith("B")) {
    if (styleIdx === 0) {
      return `${ownerName} delivered a solid median-plus class: ${rank}/${totalOwners}, ${pctTxt}, Avg ADP ${adpTxt}, Avg ADP +/- ${deltaTxt}. Good value base with room to outperform.`;
    }
    if (styleIdx === 1) {
      return `${ownerName} balanced floor and upside well enough to stay on the right half of the curve (${rank}/${totalOwners}). This group looks sturdy if not flashy.`;
    }
    if (styleIdx === 2) {
      return `${ownerName} drafted like a steady operator, finishing ${rank}/${totalOwners} with a ${grade}. Not a headline class, but definitely playoff-grade process.`;
    }
    return `${ownerName} stayed competitive in both ADP and ADP +/- metrics, landing around the upper middle of the league distribution. That's a quality build.`;
  }

  if (grade.startsWith("C")) {
    if (styleIdx === 0) {
      return `${ownerName} landed near the center of the bell curve (${rank}/${totalOwners}), with Avg ADP ${adpTxt} and Avg ADP +/- ${deltaTxt}. A few tighter value picks could swing this higher.`;
    }
    if (styleIdx === 1) {
      return `${ownerName} drafted in the pack this year: credible foundation, mixed value capture, and a middle-band report card. Variance could still make this fun.`;
    }
    if (styleIdx === 2) {
      return `${ownerName} sits in the league's middle tier by ADP metrics (${pctTxt}). This class is one hot tournament run away from changing the narrative.`;
    }
    return `${ownerName} produced a balanced but uneven draft profile, finishing ${rank}/${totalOwners}. The process was close; the margins were not always friendly.`;
  }

  if (styleIdx === 0) {
    return `${ownerName} finished ${rank}/${totalOwners} on the owner bell curve, with Avg ADP ${adpTxt} and Avg ADP +/- ${deltaTxt}. This one leaned bold over efficient.`;
  }
  if (styleIdx === 1) {
    return `${ownerName} took more market-premium shots than discounts this year, landing in the lower tail (${pctTxt}). High-conviction draft, high-variance outcome.`;
  }
  if (styleIdx === 2) {
    return `${ownerName}'s class graded below league average by ADP efficiency metrics, but these are probabilities, not destiny. Bracket chaos can rewrite this fast.`;
  }
  return `${ownerName} chased upside with aggressive reaches and paid for it in the curve score (${rank}/${totalOwners}). If it hits, this blurb will age very badly.`;
}

export function DraftTabClient({ initialLeagueId }: { initialLeagueId?: string }) {
  const leagueIdFromQuery = initialLeagueId?.trim() || undefined;
  /** Fallback for draft state API when session has no leagueTeamId yet */
  const [username, setUsername] = useState("You");
  const [state, setState] = useState<DraftStateResponse | null>(null);
  const [busyPick, setBusyPick] = useState<number | null>(null);
  const [undoLastPickBusy, setUndoLastPickBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Name typed into the commissioner-editable draft-board cell. */
  const [draftCellInput, setDraftCellInput] = useState("");
  const [commissionerSecret, setCommissionerSecret] = useState("");
  const [poolSession, setPoolSession] = useState<PlayerPoolSession | null>(null);
  const [commissionerProxyMode, setCommissionerProxyMode] = useState(true);
  const [draftLoadError, setDraftLoadError] = useState<string | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  /** One automatic draft-room ensure per league id per page visit (retried after failed ensure). */
  const draftEnsurePassRef = useRef<string | null>(null);
  const draftCellInputRef = useRef<HTMLInputElement | null>(null);

  const [draftSort, setDraftSort] = useState<{ column: DraftSortColumn | null; dir: "asc" | "desc" }>({
    column: null,
    dir: "desc"
  });

  const [playerSearchQ, setPlayerSearchQ] = useState("");
  const [selectedTeamIds, setSelectedTeamIds] = useState<number[]>([]);
  const selectedTeamIdsSet = useMemo(() => new Set(selectedTeamIds), [selectedTeamIds]);
  const [teamPickerOpen, setTeamPickerOpen] = useState(false);
  const [teamPickerPos, setTeamPickerPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const teamButtonRef = useRef<HTMLButtonElement | null>(null);
  const didInitTeamFilterRef = useRef(false);
  const [selectedResultOwnerIds, setSelectedResultOwnerIds] = useState<string[]>([]);
  const selectedResultOwnerIdSet = useMemo(() => new Set(selectedResultOwnerIds), [selectedResultOwnerIds]);
  const [resultOwnerPickerOpen, setResultOwnerPickerOpen] = useState(false);
  const [resultOwnerPickerPos, setResultOwnerPickerPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const resultOwnerButtonRef = useRef<HTMLButtonElement | null>(null);
  const [resultsOpenByOwnerId, setResultsOpenByOwnerId] = useState<Record<string, boolean>>({});
  const [draftBoardOpen, setDraftBoardOpen] = useState(true);

  const teamOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of state?.availablePlayers ?? []) {
      const t = p.team;
      if (!t || t.id == null) continue;
      m.set(t.id, displayCollegeTeam(t));
    }
    return Array.from(m.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [state?.availablePlayers]);

  const teamNameById = useMemo(() => new Map(teamOptions.map((t) => [t.id, t.name])), [teamOptions]);

  const allTeamsSelected = useMemo(
    () => teamOptions.length > 0 && selectedTeamIds.length === teamOptions.length,
    [teamOptions.length, selectedTeamIds.length]
  );

  useEffect(() => {
    // When switching leagues, reset the filter UI to "all teams selected".
    didInitTeamFilterRef.current = false;
  }, [state?.draftRoom?.leagueId]);

  useEffect(() => {
    if (didInitTeamFilterRef.current) return;
    if (teamOptions.length === 0) return;
    setSelectedTeamIds(teamOptions.map((t) => t.id));
    didInitTeamFilterRef.current = true;
  }, [teamOptions]);

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

  const filteredAvailablePlayers = useMemo(() => {
    let list = state?.availablePlayers ?? [];

    const q = playerSearchQ.trim().toLowerCase();
    if (q) {
      list = list.filter((p) => {
        const pn = String(p.name ?? "").toLowerCase();
        const ps = String(p.shortName ?? "").toLowerCase();
        const t = p.team;
        const ts = t?.shortName ? String(t.shortName).toLowerCase() : "";
        const tn = t?.name ? String(t.name).toLowerCase() : "";
        return pn.includes(q) || ps.includes(q) || ts.includes(q) || tn.includes(q);
      });
    }

    // Team filter: when not all teams are selected, keep only those.
    if (!allTeamsSelected) {
      list = list.filter((p) => {
        const id = p.team?.id;
        return id != null && selectedTeamIdsSet.has(id);
      });
    }

    return list;
  }, [state?.availablePlayers, playerSearchQ, allTeamsSelected, selectedTeamIdsSet]);

  const cycleDraftSort = useCallback((column: DraftSortColumn) => {
    setDraftSort((prev) => {
      if (prev.column !== column) return { column, dir: "desc" };
      return { column, dir: prev.dir === "desc" ? "asc" : "desc" };
    });
  }, []);

  const activeLeagueId = useMemo(() => {
    const fromQuery = leagueIdFromQuery?.trim();
    const fromPool = poolSession?.leagueId?.trim();
    const fromLocal = readStoredActiveLeagueId().trim();
    return fromQuery || fromPool || fromLocal || null;
  }, [leagueIdFromQuery, poolSession?.leagueId]);

  useEffect(() => {
    if (poolSession?.teamName?.trim()) setUsername(poolSession.teamName.trim());
  }, [poolSession?.teamName]);

  useEffect(() => {
    if (activeLeagueId) writeStoredActiveLeagueId(activeLeagueId);
  }, [activeLeagueId]);

  useEffect(() => {
    draftEnsurePassRef.current = null;
  }, [activeLeagueId]);

  useEffect(() => {
    const syncPool = () => {
      setPoolSession(readPlayerPoolSession());
      try {
        setCommissionerSecret(sessionStorage.getItem("player_pool_commissioner_secret") ?? "");
      } catch {
        setCommissionerSecret("");
      }
    };
    syncPool();
    window.addEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, syncPool);
    window.addEventListener("focus", syncPool);
    return () => {
      window.removeEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, syncPool);
      window.removeEventListener("focus", syncPool);
    };
  }, []);

  const draftInitHeaders = useCallback(
    (json = true): HeadersInit => {
      const h: Record<string, string> = {};
      if (json) h["content-type"] = "application/json";
      const s = commissionerSecret.trim();
      if (s) h["x-player-pool-commissioner-secret"] = s;
      return h;
    },
    [commissionerSecret]
  );

  const timerRemaining = useMemo(() => {
    if (!state?.draftRoom.startedAt || !state?.draftRoom.pickTimerSeconds) return null;
    const startedAt = new Date(state.draftRoom.startedAt).getTime();
    const pickIndex = (state.draftRoom.currentPickOverall ?? 1) - 1;
    const pickStart = startedAt + pickIndex * state.draftRoom.pickTimerSeconds * 1000;
    const endsAt = pickStart + state.draftRoom.pickTimerSeconds * 1000;
    return Math.max(0, (endsAt - Date.now()) / 1000);
  }, [state]);

  async function loadState() {
    if (!activeLeagueId) return;
    const sp = new URLSearchParams();
    const ps = readPlayerPoolSession();
    if (ps?.leagueTeamId) sp.set("leagueTeamId", ps.leagueTeamId);
    else sp.set("username", username);

    const stateUrl = `/api/draft/${encodeURIComponent(activeLeagueId)}/state?${sp.toString()}`;
    const hdrs = draftInitHeaders(false);

    let res = await fetch(stateUrl, { headers: hdrs });

    if (res.status === 404 && draftEnsurePassRef.current !== activeLeagueId) {
      draftEnsurePassRef.current = activeLeagueId;
      const ens = await fetch(`/api/leagues/${encodeURIComponent(activeLeagueId)}/draft/ensure`, {
        method: "POST"
      });
      if (ens.ok) {
        res = await fetch(stateUrl, { headers: hdrs });
        if (res.status === 404) {
          draftEnsurePassRef.current = null;
        }
      } else {
        draftEnsurePassRef.current = null;
        setState(null);
        let msg = "Could not create the draft room.";
        try {
          const j = (await ens.json()) as { error?: string; code?: string };
          if (j.code === "no_teams") {
            msg =
              "Add at least one owner in Commissioner Tools first, then come back — the draft room will open automatically.";
          } else if (j.code === "completed") {
            msg = "This draft is already finished. Reset it from Commissioner Tools if you need a new draft.";
          } else if (j.error) msg = j.error;
        } catch {
          /* ignore */
        }
        setDraftLoadError(msg);
        return;
      }
    }

    if (!res.ok) {
      setState(null);
      if (res.status === 404) {
        setDraftLoadError(
          "No draft board yet. Confirm the league has owners and try again — the app creates the draft room automatically when you open this tab."
        );
      } else {
        setDraftLoadError(`Could not load draft state (HTTP ${res.status}).`);
      }
      return;
    }
    setDraftLoadError(null);
    const json = (await res.json()) as DraftStateResponse;
    setState(json);
  }

  async function onManualRefresh() {
    if (!activeLeagueId || refreshBusy) return;
    setRefreshBusy(true);
    try {
      await loadState();
    } finally {
      setRefreshBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    if (!activeLeagueId) return;
    const tick = async () => {
      if (cancelled) return;
      await loadState();
    };
    tick();
    const id = window.setInterval(tick, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLeagueId, poolSession?.leagueTeamId, username, commissionerSecret]);

  async function handlePick(playerId: number) {
    if (!activeLeagueId || !state?.draftRoom) return;

    const useProxy =
      commissionerProxyMode === true &&
      state.viewerCanCommissionerPick === true &&
      state.draftRoom.status === "in_progress";

    const normalPick =
      state.yourLeagueTeamId &&
      state.currentTurn.leagueTeamId &&
      state.currentTurn.leagueTeamId === state.yourLeagueTeamId;

    if (!useProxy && !normalPick) return;

    setBusyPick(playerId);
    setError(null);
    try {
      const body = useProxy
        ? { playerId, commissionerOverride: true }
        : { leagueTeamId: state.yourLeagueTeamId!, playerId };

      const res = await fetch(`/api/draft/${activeLeagueId}/pick`, {
        method: "POST",
        headers: draftInitHeaders(true),
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Pick failed: ${res.status} ${t}`);
      }

      // Optimistically update the board immediately so it doesn't wait for
      // the full `/api/draft/.../state` reload to finish.
      setState((prev) => {
        if (!prev) return prev;
        const useLeagueTeamId = useProxy ? prev.currentTurn.leagueTeamId : prev.yourLeagueTeamId;
        if (!useLeagueTeamId) return prev;

        const pickedPlayer = prev.availablePlayers.find((p) => p.id === playerId);
        if (!pickedPlayer) return prev;

        const pickOverall = prev.draftRoom.currentPickOverall ?? 1;
        const alreadyThere = prev.picks.some((p) => p.pickOverall === pickOverall && p.player.id === playerId);
        if (alreadyThere) return prev;

        const ownersCount = prev.draftOrder.length;
        const roundNumber = prev.currentTurn.roundNumber;
        const pickNumberInRound = prev.currentTurn.pickNumberInRound;

        const ownerName =
          prev.leagueTeams?.find((t) => t.id === useLeagueTeamId)?.teamName ??
          prev.picks.find((p) => p.leagueTeamId === useLeagueTeamId)?.ownerName ??
          "—";

        const nextPickOverall = pickOverall + 1;
        const maxPick = (prev.draftRoom.totalRounds ?? 6) * ownersCount;
        const nextStatus = nextPickOverall > maxPick ? "completed" : prev.draftRoom.status;

        // Recompute next turn (same snake logic as the server).
        const idx = nextPickOverall - 1;
        const nextRoundNumber = Math.floor(idx / ownersCount) + 1;
        const nextPickNumberInRound = (idx % ownersCount) + 1;
        const snakeOrder = nextRoundNumber % 2 === 1 ? prev.draftOrder : [...prev.draftOrder].reverse();
        const nextLeagueTeamId = snakeOrder[nextPickNumberInRound - 1] ?? null;

        const picked = {
          pickOverall,
          roundNumber,
          pickNumberInRound,
          leagueTeamId: useLeagueTeamId,
          ownerName,
          player: {
            id: pickedPlayer.id,
            name: pickedPlayer.name,
            shortName: pickedPlayer.shortName ?? null,
            espnAthleteId: pickedPlayer.espnAthleteId ?? null,
            position: pickedPlayer.position ?? null,
            headshotUrls: pickedPlayer.headshotUrls ?? undefined,
            seasonPpg: pickedPlayer.seasonPpg ?? null,
            projection: pickedPlayer.projection ?? null,
            originalProjection: pickedPlayer.originalProjection ?? null,
            team: pickedPlayer.team
              ? {
                  id: pickedPlayer.team.id,
                  name: pickedPlayer.team.name,
                  shortName: pickedPlayer.team.shortName ?? null,
                  seed: pickedPlayer.team.seed,
                  region: pickedPlayer.team.region,
                  conference: pickedPlayer.team.conference,
                  isPower5: Boolean(pickedPlayer.team.isPower5),
                  logoUrl: pickedPlayer.team.logoUrl ?? null
                }
              : null
          }
        };

        return {
          ...prev,
          picks: [...prev.picks, picked].sort((a, b) => a.pickOverall - b.pickOverall),
          draftRoom: {
            ...prev.draftRoom,
            currentPickOverall: nextPickOverall,
            status: nextStatus,
            completedAt: nextStatus === "completed" ? new Date().toISOString() : prev.draftRoom.completedAt
          },
          currentTurn: {
            ...prev.currentTurn,
            roundNumber: nextRoundNumber,
            pickNumberInRound: nextPickNumberInRound,
            leagueTeamId: nextLeagueTeamId
          }
        };
      });

      // Don't block the UI on a full draft-state reload.
      // `loadState()` is relatively expensive and was making picks feel delayed.
      void loadState().catch(() => {
        /* ignore background refresh failures; draft will recover on next interval */
      });
    } catch (e: any) {
      setError(e?.message ?? "Pick failed");
    } finally {
      setBusyPick(null);
    }
  }

  async function undoLastPick() {
    if (!activeLeagueId || !state?.draftRoom) return;
    if (!state.viewerCanCommissionerPick) return;
    if (state.draftRoom.status !== "in_progress") return;
    if ((state.picks?.length ?? 0) <= 0) return;
    if (!window.confirm("Undo last pick?")) return;

    setUndoLastPickBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/commissioner/${encodeURIComponent(activeLeagueId)}/draft/undo-last-pick`, {
        method: "POST",
        headers: draftInitHeaders(true)
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Undo pick failed: ${res.status} ${t}`);
      }
      setDraftCellInput("");
      await loadState();
    } catch (e: any) {
      setError(e?.message ?? "Undo pick failed");
    } finally {
      setUndoLastPickBusy(false);
    }
  }

  const yourTurn = state?.currentTurn.leagueTeamId && state.yourLeagueTeamId
    ? state.currentTurn.leagueTeamId === state.yourLeagueTeamId
    : false;

  const displayedAvailablePlayers = useMemo(() => {
    const col = draftSort.column;
    const list = filteredAvailablePlayers;
    if (!col) return list;
    return [...list].sort((a, b) => compareAvailablePlayers(a, b, col, draftSort.dir));
  }, [filteredAvailablePlayers, draftSort.column, draftSort.dir]);

  const draftCellSuggestions = useMemo(() => {
    const q = draftCellInput.trim().toLowerCase();
    // Suggestions should come from the full available player list (independent of the table filters).
    const src = state?.availablePlayers ?? [];
    // Avoid a long dropdown on first focus; only suggest after a couple keystrokes.
    if (q.length < 2) return [];
    return src
      .filter((p) => {
        const name = String(p.name ?? "").toLowerCase();
        const shortName = (p.shortName ?? "").toLowerCase();
        const teamShortName = p.team?.shortName ? String(p.team.shortName).toLowerCase() : "";
        const teamName = p.team?.name ? String(p.team.name).toLowerCase() : "";
        return name.includes(q) || shortName.includes(q) || teamShortName.includes(q) || teamName.includes(q);
      })
      .slice(0, 25);
  }, [draftCellInput, state?.availablePlayers]);

  const canPick = Boolean(
    state?.draftRoom?.status === "in_progress" &&
      (yourTurn ||
        (commissionerProxyMode && state?.viewerCanCommissionerPick === true))
  );

  const editableCellKey = useMemo(() => {
    if (!canPick) return null;
    if (state?.viewerCanCommissionerPick !== true) return null; // commissioner-only edit
    if (state?.draftRoom?.status !== "in_progress") return null;
    if (!state.currentTurn.leagueTeamId) return null;
    return `${state.currentTurn.leagueTeamId}:${state.currentTurn.roundNumber}`;
  }, [
    canPick,
    state?.draftRoom?.status,
    state?.viewerCanCommissionerPick,
    state?.currentTurn.leagueTeamId,
    state?.currentTurn.roundNumber
  ]);

  const lastEditableCellKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (editableCellKey !== lastEditableCellKeyRef.current) {
      setDraftCellInput("");
      lastEditableCellKeyRef.current = editableCellKey;
    }
  }, [editableCellKey]);

  useEffect(() => {
    if (!editableCellKey) return;
    draftCellInputRef.current?.focus();
  }, [editableCellKey]);

  function requestPickWithConfirm(p: AvailablePlayer) {
    if (!canPick || !activeLeagueId) return;
    const team = displayCollegeTeam(p.team);
    const label = team && team !== "—" ? `${p.name} — ${team}` : p.name;
    if (!window.confirm(`Draft ${label}?`)) return;
    void handlePick(p.id);
  }

  function submitDraftCellPickFromInput() {
    if (!canPick || !activeLeagueId) return;
    const raw = draftCellInput.trim();
    if (!raw) {
      setError("Type a player name (or pick from suggestions) to submit this cell.");
      return;
    }

    const lower = raw.toLowerCase();
    // Resolve typed names against the full available player list (independent of the table filters).
    const inputSource = state?.availablePlayers ?? [];
    const exactByName = inputSource.find((p) => String(p.name ?? "").toLowerCase() === lower);
    const exactByShortName = inputSource.find((p) => {
      const sn = p.shortName ?? "";
      return sn.trim() !== "" && sn.toLowerCase() === lower;
    });

    const resolved = exactByName ?? exactByShortName ?? null;
    if (!resolved) {
      setError("Player not found in the available player list. Select from the suggestions to avoid typos.");
      return;
    }

    const team = displayCollegeTeam(resolved.team);
    const label = team && team !== "—" ? `${resolved.name} — ${team}` : resolved.name;
    if (!window.confirm(`Draft ${label}?`)) return;
    setError(null);
    setDraftCellInput("");
    void handlePick(resolved.id);
  }

  const isFinal = state?.draftRoom?.status === "completed";

  const onClockOwnerName = useMemo(() => {
    const id = state?.currentTurn.leagueTeamId;
    if (!id || !state?.leagueTeams?.length) return "—";
    return state.leagueTeams.find((t) => t.id === id)?.teamName ?? "—";
  }, [state]);

  /** Rows follow `draftOrder`; each column R is that owner’s pick in round R. */
  const draftBoardRows = useMemo(() => {
    if (!state?.draftOrder?.length) return [];
    const picksByTeamRound = new Map<string, Map<number, DraftStateResponse["picks"][number]>>();
    for (const p of state.picks) {
      const tid = String(p.leagueTeamId);
      if (!picksByTeamRound.has(tid)) picksByTeamRound.set(tid, new Map());
      const rm = picksByTeamRound.get(tid)!;
      const r = p.roundNumber;
      if (!Number.isFinite(r) || r < 1) continue;
      const prev = rm.get(r);
      if (!prev || p.pickOverall > prev.pickOverall) rm.set(r, p);
    }
    const ownerLabel = (leagueTeamId: string) =>
      state.leagueTeams?.find((t) => t.id === leagueTeamId)?.teamName ??
      state.picks.find((p) => p.leagueTeamId === leagueTeamId)?.ownerName ??
      "—";

    return state.draftOrder.map((leagueTeamId) => {
      const id = String(leagueTeamId);
      const byRound = picksByTeamRound.get(id) ?? new Map();
      const roundPicks: Array<DraftStateResponse["picks"][number] | null> = [];
      for (let r = 1; r <= DRAFT_BOARD_ROUND_COUNT; r++) {
        roundPicks.push(byRound.get(r) ?? null);
      }
      return { leagueTeamId: id, ownerName: ownerLabel(id), roundPicks };
    });
  }, [state]);

  const resultsByOwner = useMemo(() => {
    if (!state?.picks?.length) return [];
    const orderIndexByLeagueTeamId = new Map<string, number>(
      (state.draftOrder ?? []).map((id, idx) => [String(id), idx])
    );
    const map = new Map<string, { leagueTeamId: string; ownerName: string; picks: DraftStateResponse["picks"] }>();
    for (const p of state.picks) {
      const key = String(p.leagueTeamId);
      const existing = map.get(key);
      if (!existing) map.set(key, { leagueTeamId: key, ownerName: p.ownerName, picks: [p] });
      else existing.picks.push(p);
    }
    return Array.from(map.entries())
      .sort((a, b) => {
        const ai = orderIndexByLeagueTeamId.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
        const bi = orderIndexByLeagueTeamId.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a[1].ownerName.localeCompare(b[1].ownerName);
      })
      .map(([, v]) => v);
  }, [state]);
  const resultOwnerOptions = useMemo(
    () =>
      resultsByOwner.map((bucket) => ({
        leagueTeamId: bucket.leagueTeamId,
        ownerName: bucket.ownerName
      })),
    [resultsByOwner]
  );
  const allResultOwnersSelected = useMemo(
    () => resultOwnerOptions.length > 0 && selectedResultOwnerIds.length === resultOwnerOptions.length,
    [resultOwnerOptions.length, selectedResultOwnerIds.length]
  );
  useEffect(() => {
    if (resultOwnerOptions.length === 0) {
      setSelectedResultOwnerIds([]);
      return;
    }
    setSelectedResultOwnerIds((prev) => {
      if (prev.length === 0) return resultOwnerOptions.map((o) => o.leagueTeamId);
      const valid = prev.filter((id) => resultOwnerOptions.some((o) => o.leagueTeamId === id));
      return valid.length > 0 ? valid : resultOwnerOptions.map((o) => o.leagueTeamId);
    });
  }, [resultOwnerOptions]);
  useEffect(() => {
    setResultsOpenByOwnerId((prev) => {
      const next = { ...prev };
      for (const o of resultOwnerOptions) {
        if (next[o.leagueTeamId] === undefined) next[o.leagueTeamId] = true;
      }
      return next;
    });
  }, [resultOwnerOptions]);
  const allResultsCollapsed = useMemo(
    () => resultOwnerOptions.length > 0 && resultOwnerOptions.every((o) => !(resultsOpenByOwnerId[o.leagueTeamId] ?? true)),
    [resultOwnerOptions, resultsOpenByOwnerId]
  );
  const setAllResultsCollapsed = useCallback(
    (collapsed: boolean) => {
      setResultsOpenByOwnerId((prev) => {
        const next = { ...prev };
        for (const o of resultOwnerOptions) next[o.leagueTeamId] = !collapsed;
        return next;
      });
    },
    [resultOwnerOptions]
  );
  function openResultOwnerPicker() {
    const rect = resultOwnerButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setResultOwnerPickerPos({ top: rect.bottom + 8, left: rect.left, width: rect.width });
    setResultOwnerPickerOpen(true);
  }
  function closeResultOwnerPicker() {
    setResultOwnerPickerOpen(false);
  }
  function toggleResultOwnerPicker() {
    if (resultOwnerPickerOpen) closeResultOwnerPicker();
    else openResultOwnerPicker();
  }

  const allPlayersForAdp = useMemo<DraftPlayerForAdp[]>(() => {
    const byId = new Map<number, DraftPlayerForAdp>();
    for (const p of state?.availablePlayers ?? []) {
      byId.set(p.id, {
        id: p.id,
        name: p.name,
        projection: numericProjection(p.originalProjection ?? p.projection)
      });
    }
    for (const p of state?.picks ?? []) {
      if (byId.has(p.player.id)) continue;
      byId.set(p.player.id, {
        id: p.player.id,
        name: p.player.name,
        projection: numericProjection(p.player.originalProjection)
      });
    }
    return Array.from(byId.values());
  }, [state?.availablePlayers, state?.picks]);

  const adpRankByPlayerId = useMemo(() => {
    const ranked = allPlayersForAdp
      .filter((p) => p.projection != null)
      .sort((a, b) => (b.projection! - a.projection!) || a.name.localeCompare(b.name));
    const m = new Map<number, number>();
    ranked.forEach((p, idx) => m.set(p.id, idx + 1));
    return m;
  }, [allPlayersForAdp]);

  const filteredResultsByOwner = useMemo(() => {
    if (selectedResultOwnerIds.length === 0 || allResultOwnersSelected) return resultsByOwner;
    return resultsByOwner.filter((b) => selectedResultOwnerIdSet.has(b.leagueTeamId));
  }, [resultsByOwner, selectedResultOwnerIds.length, allResultOwnersSelected, selectedResultOwnerIdSet]);

  const reportCardByOwnerId = useMemo(() => {
    const rows = resultsByOwner.map((bucket) => {
      const sortedPicks = bucket.picks.slice().sort((a, b) => a.pickOverall - b.pickOverall);
      const adpVals: number[] = [];
      const deltaVals: number[] = [];
      let projSum = 0;
      for (const p of sortedPicks) {
        const adp = adpRankByPlayerId.get(p.player.id) ?? null;
        const delta = adp != null ? adp - p.pickOverall : null;
        const origProj = numericProjection(p.player.originalProjection);
        if (adp != null) adpVals.push(adp);
        if (delta != null) deltaVals.push(delta);
        projSum += origProj ?? 0;
      }
      return {
        leagueTeamId: bucket.leagueTeamId,
        ownerName: bucket.ownerName,
        avgAdp: mean(adpVals),
        avgAdpDelta: mean(deltaVals),
        projSum
      };
    });

    const adpSet = rows.map((r) => r.avgAdp).filter((v): v is number => v != null);
    const deltaSet = rows.map((r) => r.avgAdpDelta).filter((v): v is number => v != null);
    const adpMu = mean(adpSet);
    const deltaMu = mean(deltaSet);
    const adpSd = adpMu == null ? 0 : stdDev(adpSet, adpMu);
    const deltaSd = deltaMu == null ? 0 : stdDev(deltaSet, deltaMu);

    const scored = rows.map((r) => {
      const adpZ =
        r.avgAdp != null && adpMu != null && adpSd > 1e-9 ? (adpMu - r.avgAdp) / adpSd : 0;
      const deltaZ =
        r.avgAdpDelta != null && deltaMu != null && deltaSd > 1e-9 ? (r.avgAdpDelta - deltaMu) / deltaSd : 0;
      const z = 0.5 * adpZ + 0.5 * deltaZ;
      return { ...r, z };
    });

    scored.sort((a, b) => b.z - a.z || a.ownerName.localeCompare(b.ownerName));
    const out = new Map<
      string,
      {
        avgAdp: number | null;
        avgAdpDelta: number | null;
        projSum: number;
        grade: string;
        percentile: number;
        rank: number;
        totalOwners: number;
        blurb: string;
      }
    >();
    const totalOwners = scored.length;
    scored.forEach((r, idx) => {
      const rank = idx + 1;
      const { grade, percentile } = gradeFromCurveRank(rank, totalOwners);
      out.set(r.leagueTeamId, {
        avgAdp: r.avgAdp,
        avgAdpDelta: r.avgAdpDelta,
        projSum: r.projSum,
        grade,
        percentile,
        rank,
        totalOwners,
        blurb: reportCardBlurb({
          ownerName: r.ownerName,
          grade,
          rank,
          totalOwners,
          avgAdp: r.avgAdp,
          avgAdpDelta: r.avgAdpDelta,
          percentile
        })
      });
    });
    return out;
  }, [resultsByOwner, adpRankByPlayerId]);

  const draftStatusLine = (() => {
    if (!activeLeagueId) return "Choose a pool in the top bar";
    if (!state?.draftRoom) return draftLoadError ? "—" : "Loading…";
    if (state.lastSyncedAt) return `Synced ${new Date(state.lastSyncedAt).toLocaleString()}`;
    return "Live draft board";
  })();

  return (
    <div className="pool-page-stack pool-page-stack-tight flex min-h-0 flex-1 flex-col">
      <div className="pool-hero pool-hero-databallr shrink-0">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <div
              className="h-9 w-9 shrink-0 rounded-md bg-accent/15 border border-accent/40 flex items-center justify-center"
              aria-hidden
            >
              <GraduationCap className="h-4 w-4 text-accent" />
            </div>
            <div className="min-w-0">
              <h1 className="stat-tracker-page-title">Draft</h1>
              <div className="text-[10px] tabular-nums text-foreground/50 mt-0.5">{draftStatusLine}</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            <button
              type="button"
              className="pool-btn-outline-cta pool-btn-outline-cta--sm"
              disabled={!activeLeagueId || refreshBusy}
              onClick={() => void onManualRefresh()}
            >
              {refreshBusy ? "…" : "Refresh Data"}
            </button>
          </div>
        </div>
        <div className="mt-1.5 pt-2 border-t border-border/25 text-[10px] text-foreground/45">
          Live draft board, available player pool, and recent picks by round.
        </div>

        {draftLoadError && (
          <div className="mt-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-100/90">
            {draftLoadError}
          </div>
        )}
        {error && (
          <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-100/90">
            {error}
          </div>
        )}

        {state && draftBoardRows.length > 0 && (
          <div className="pool-card pool-card-compact mt-2">
            <button
              type="button"
              onClick={() => setDraftBoardOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md pool-card-header pool-owner-header"
            >
              <div className="text-sm font-semibold pool-owner-name min-w-0 truncate">
                {(state.seasonYear ?? new Date().getFullYear())} Draft Board
              </div>
              <div className="text-xs flex items-center gap-2 pool-owner-chevron shrink-0">
                {draftBoardOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </div>
            </button>
            {draftBoardOpen ? (
            <div className="mt-1 shrink-0 overflow-x-auto">
              <table
                className="pool-table w-full min-w-[520px] text-[10px] sm:text-[11px]"
                aria-label="Draft board by round"
              >
              <thead>
                <tr>
                  <th className="sticky left-0 z-[1] w-24 min-w-[5.5rem] max-w-[6rem] bg-[rgb(var(--pool-stats-bg-odd)/0.92)] px-1 py-1.5 text-left text-[10px] font-semibold leading-tight backdrop-blur-sm sm:text-[11px]">
                    Owner
                  </th>
                  {Array.from({ length: DRAFT_BOARD_ROUND_COUNT }, (_, i) => i + 1).map((r) => (
                    <th key={r} className="w-24 min-w-[5.5rem] px-1 py-1.5 text-center font-semibold" scope="col">
                      {r}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {draftBoardRows.map((row, rowIdx) => (
                  <tr key={row.leagueTeamId} className="pool-table-row">
                    <th
                      scope="row"
                      className="sticky left-0 z-[1] w-24 min-w-[5.5rem] max-w-[6rem] bg-[rgb(var(--pool-stats-bg-even)/0.92)] px-1 py-1.5 text-left text-[10px] font-medium leading-tight text-foreground backdrop-blur-sm align-top sm:text-[11px]"
                      title={row.ownerName}
                    >
                      <span className="line-clamp-2 leading-snug">{row.ownerName}</span>
                    </th>
                    {row.roundPicks.map((pick, idx) => {
                      const roundNumber = idx + 1;
                      const cellIsClock =
                        state?.draftRoom?.status === "in_progress" &&
                        canPick &&
                        state?.currentTurn.leagueTeamId === row.leagueTeamId &&
                        state?.currentTurn.roundNumber === roundNumber;
                      const cellIsEditable = state?.viewerCanCommissionerPick === true && cellIsClock && !pick;
                      const college = pick ? pickCellCollegeLine(pick.player.team) : "";
                      const showSuggestions = cellIsEditable && draftCellInput.trim().length >= 2 && draftCellSuggestions.length > 0;
                      return (
                        <td
                          key={idx}
                          className="align-top px-1 py-1.5 text-left leading-snug text-foreground/90"
                        >
                          {pick ?
                            <>
                              <div className="font-semibold text-foreground line-clamp-2">
                                <DraftPlayerNameLink
                                  playerName={pick.player.name}
                                  espnAthleteId={pick.player.espnAthleteId}
                                />
                                {pick.player.position ? (
                                  <span className="ml-1 text-[10px] sm:text-[11px] text-foreground/65 font-normal tabular-nums">
                                    {pick.player.position}
                                  </span>
                                ) : null}
                              </div>
                              <div className="mt-0.5 line-clamp-2 text-foreground/55" title={college || undefined}>
                                {college || "—"} · {displayRegionName(pick.player.team?.region)}
                              </div>
                            </>
                          : cellIsEditable ? (
                            <div className="w-full relative">
                              <div className="flex items-center gap-1">
                                <input
                                  ref={draftCellInputRef}
                                  value={draftCellInput}
                                  onChange={(e) => {
                                    setDraftCellInput(e.target.value);
                                    if (error) setError(null);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key !== "Enter") return;
                                    e.preventDefault();
                                    submitDraftCellPickFromInput();
                                  }}
                                  placeholder="Type name..."
                                  className="w-full min-w-0 rounded-sm border border-border/40 bg-background/50 px-1 py-0.5 text-[11px] outline-none focus:border-[#b89a3a]/70 focus:ring-0"
                                  aria-label={`Draft board cell for round ${roundNumber}`}
                                />
                                <button
                                  type="button"
                                  onClick={submitDraftCellPickFromInput}
                                  disabled={busyPick != null}
                                  className="shrink-0 rounded-sm border border-border/40 bg-transparent px-1 py-0.5 text-[10px] text-foreground/80 hover:text-foreground hover:border-[#b89a3a]/70 disabled:opacity-50 disabled:pointer-events-none"
                                  aria-label={`Submit draft cell for round ${roundNumber}`}
                                >
                                  Pick
                                </button>
                              </div>
                              {showSuggestions && (
                                <div
                                  className={
                                    rowIdx === draftBoardRows.length - 1
                                      ? "absolute left-0 right-0 bottom-full mb-1 z-[9999] max-h-52 overflow-auto rounded-md border border-border/60 bg-background shadow-sm"
                                      : "absolute left-0 right-0 top-full mt-1 z-[9999] max-h-52 overflow-auto rounded-md border border-border/60 bg-background shadow-sm"
                                  }
                                  role="listbox"
                                  aria-label="Player suggestions"
                                >
                                  {draftCellSuggestions.map((p) => {
                                    const team = displayCollegeTeam(p.team);
                                    const label = team && team !== "—" ? `${p.name} — ${team}` : p.name;
                                    return (
                                      <button
                                        key={p.id}
                                        type="button"
                                        role="option"
                                        aria-selected={draftCellInput.trim().toLowerCase() === String(p.name).trim().toLowerCase()}
                                        className="block w-full truncate px-2 py-1.5 text-left text-[11px] hover:bg-muted/50"
                                        onMouseDown={(e) => {
                                          // Prevent input blur so the click works consistently.
                                          e.preventDefault();
                                        }}
                                        onClick={() => {
                                          setDraftCellInput(p.name);
                                          setError(null);
                                        }}
                                      >
                                        {label}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-foreground/35">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            ) : null}
          </div>
        )}

        {!isFinal && (
          <div
            className={`mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] ${
              yourTurn || (commissionerProxyMode && state?.viewerCanCommissionerPick)
                ? "text-foreground"
                : "text-muted-foreground"
            }`}
          >
            <span className="font-medium text-foreground">
              R{state?.currentTurn.roundNumber ?? 1} · P{state?.currentTurn.pickNumberInRound ?? 1}/
              {state?.draftOrder?.length ?? "—"} · #{state?.draftRoom?.currentPickOverall ?? "—"}
            </span>
            <span>
              Clock: <span className="font-semibold text-foreground">{onClockOwnerName}</span>
            </span>
            <span>Timer {timerRemaining === null ? "—" : formatSeconds(timerRemaining)}</span>
            <span className="font-medium">
              {yourTurn ?
                <span className="text-accent">Your turn</span>
              : commissionerProxyMode && state?.viewerCanCommissionerPick ?
                <span className="text-accent">Proxy: {onClockOwnerName}</span>
              : state?.currentTurn.leagueTeamId ?
                `Wait · ${onClockOwnerName}`
              : !activeLeagueId ?
                "Set league in header"
              : "—"}
            </span>
          </div>
        )}

        {state?.viewerCanCommissionerPick && state?.draftRoom?.status === "in_progress" && (
          <label
            className="mt-2 inline-flex max-w-full cursor-pointer items-center gap-2 text-[11px] text-muted-foreground"
            title="With commissioner access, submit picks for whoever is on the clock. Uncheck to pick only as your bar-selected team."
          >
            <input
              type="checkbox"
              className="shrink-0"
              checked={commissionerProxyMode}
              onChange={(e) => setCommissionerProxyMode(e.target.checked)}
            />
            <span>Pick for on-clock team</span>
          </label>
        )}

        {state?.viewerCanCommissionerPick &&
          state?.draftRoom?.status === "in_progress" &&
          (state?.picks?.length ?? 0) > 0 && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => void undoLastPick()}
                disabled={undoLastPickBusy}
                className="pool-btn-outline-cta text-[11px] px-2 py-1.5"
              >
                {undoLastPickBusy ? "Undoing…" : "Undo last pick"}
              </button>
            </div>
          )}

        {!state?.yourLeagueTeamId &&
          activeLeagueId &&
          !commissionerProxyMode &&
          state?.viewerCanCommissionerPick !== true && (
            <p className="mt-1.5 text-[11px] text-amber-500/90">Select your team in the header bar to pick.</p>
          )}

        <div className="mt-3 flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          {!isFinal ? (
            <>
              <div className="pool-subpanel flex min-h-0 min-w-0 flex-1 flex-col py-2">
                <div className="mb-2 flex shrink-0 flex-wrap items-baseline justify-between gap-2 px-1">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {state
                      ? `${displayedAvailablePlayers.length} available`
                      : activeLeagueId
                        ? "Loading…"
                        : "Set league in header"}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2">
                      <span className="sr-only">Search available players</span>
                      <input
                        className="pool-field w-[180px] max-w-full h-7 px-2 text-[11px]"
                        value={playerSearchQ}
                        onChange={(e) => setPlayerSearchQ(e.target.value)}
                        placeholder="Search player…"
                      />
                    </label>
                    <div className="relative">
                      <button
                        ref={teamButtonRef}
                        type="button"
                        onClick={toggleTeamPicker}
                        disabled={teamOptions.length === 0}
                        className="pool-btn-ghost h-7 px-2 text-[11px]"
                        aria-label="Filter by team"
                      >
                        Team:{" "}
                        {allTeamsSelected
                          ? "All"
                          : selectedTeamIds.length === 1
                            ? teamNameById.get(selectedTeamIds[0]!) ?? "1 team"
                            : `${selectedTeamIds.length} teams`}
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
                            role="dialog"
                            aria-label="Team filter"
                          >
                            <div className="flex gap-2 mb-2 px-2">
                              <button
                                type="button"
                                onClick={() => setSelectedTeamIds(teamOptions.map((t) => t.id))}
                                disabled={allTeamsSelected}
                                className="pool-btn-ghost flex-1"
                              >
                                All
                              </button>
                              <button
                                type="button"
                                onClick={() => setSelectedTeamIds([])}
                                disabled={selectedTeamIds.length === 0}
                                className="pool-btn-ghost flex-1"
                              >
                                None
                              </button>
                            </div>
                            <div>
                              {teamOptions.map((t) => {
                                const checked = selectedTeamIdsSet.has(t.id);
                                return (
                                  <label
                                    key={t.id}
                                    className="pool-picker-row w-full px-2 cursor-pointer hover:bg-muted/40"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => {
                                        setSelectedTeamIds((prev) => {
                                          const has = prev.includes(t.id);
                                          if (has) return prev.filter((x) => x !== t.id);
                                          return [...prev, t.id];
                                        });
                                      }}
                                    />
                                    <span className="truncate text-[11px]">{t.name}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="min-h-[min(640px,calc(100dvh-9.5rem))] flex-1 overflow-auto pr-1">
                  <div className="min-w-0 overflow-x-auto">
                    <table className="pool-table w-full text-xs min-w-[720px]">
                      <thead>
                        <tr>
                          <th className="w-6 p-0.5 text-center" scope="col">
                            <span className="sr-only">Draft player</span>
                          </th>
                          <th className="w-10 p-1 text-center" scope="col">
                            <span className="sr-only">Team logo</span>
                          </th>
                          <th className="w-10 p-1 text-center" scope="col">
                            <span className="sr-only">Player photo</span>
                          </th>
                          <SortableTh
                            column="name"
                            sortKey={draftSort.column}
                            sortDir={draftSort.dir}
                            onSort={cycleDraftSort}
                            className="text-left min-w-[120px]"
                            title="Player name"
                          >
                            Player
                          </SortableTh>
                          <SortableTh
                            column="team"
                            sortKey={draftSort.column}
                            sortDir={draftSort.dir}
                            onSort={cycleDraftSort}
                            className="text-center min-w-[100px]"
                            title="College team"
                          >
                            Team
                          </SortableTh>
                          <SortableTh
                            column="position"
                            sortKey={draftSort.column}
                            sortDir={draftSort.dir}
                            onSort={cycleDraftSort}
                            className="text-center min-w-[3rem]"
                            title="Position"
                          >
                            Pos
                          </SortableTh>
                          <SortableTh
                            column="seed"
                            sortKey={draftSort.column}
                            sortDir={draftSort.dir}
                            onSort={cycleDraftSort}
                            className="text-center"
                            title="Tournament seed"
                          >
                            Seed
                          </SortableTh>
                          <SortableTh
                            column="region"
                            sortKey={draftSort.column}
                            sortDir={draftSort.dir}
                            onSort={cycleDraftSort}
                            className="text-center"
                            title="Region"
                          >
                            Region
                          </SortableTh>
                          <SortableTh
                            column="ppg"
                            sortKey={draftSort.column}
                            sortDir={draftSort.dir}
                            onSort={cycleDraftSort}
                            className="text-center"
                            title="Season points per game"
                          >
                            PPG
                          </SortableTh>
                          <SortableTh
                            column="projection"
                            sortKey={draftSort.column}
                            sortDir={draftSort.dir}
                            onSort={cycleDraftSort}
                            className="text-center"
                            title="Draft projection: season PPG × full chalk expected games (same as Player Statistics Orig Proj)"
                          >
                            Draft Projection
                          </SortableTh>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedAvailablePlayers.map((p) => {
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
                            : p.displayHeadshotUrl ?
                              [p.displayHeadshotUrl]
                            : [];
                          const seedDisplay = t?.seed != null ? String(t.seed) : "—";
                          const ppg =
                            p.seasonPpg != null && String(p.seasonPpg).trim() !== ""
                              ? Number(p.seasonPpg).toFixed(1)
                              : "—";
                          const proj =
                            p.originalProjection != null && Number.isFinite(Number(p.originalProjection))
                              ? String(Math.round(Number(p.originalProjection)))
                              : p.projection != null && Number.isFinite(Number(p.projection))
                                ? String(Math.round(Number(p.projection)))
                              : "—";
                          const posTrim =
                            p.position != null && String(p.position).trim() !== ""
                              ? String(p.position).trim()
                              : "";
                          const pickDisabled = !canPick || busyPick === p.id || !activeLeagueId;

                          return (
                            <tr key={p.id} className="pool-table-row">
                              <td className="w-6 px-0.5 py-1 align-middle text-center">
                                <button
                                  type="button"
                                  onClick={() => requestPickWithConfirm(p)}
                                  disabled={pickDisabled}
                                  title={pickDisabled ? "Not your pick" : `Draft ${p.name}`}
                                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[#b89a3a] bg-transparent text-[10px] font-normal leading-none text-[#b89a3a] transition-[border-color,color,transform,opacity] hover:border-[#d4bc5c] hover:text-[#d4bc5c] active:scale-[0.96] disabled:pointer-events-none disabled:opacity-[0.35] dark:border-[#c4a94a] dark:text-[#c4a94a] dark:hover:border-[#e0cc6e] dark:hover:text-[#e0cc6e]"
                                  aria-label={`Draft ${p.name}`}
                                >
                                  {busyPick === p.id ? (
                                    <span className="text-[5px] font-semibold tracking-tight text-[#b89a3a] dark:text-[#c4a94a]">
                                      ···
                                    </span>
                                  ) : (
                                    <span aria-hidden className="-mt-px block font-light">
                                      +
                                    </span>
                                  )}
                                </button>
                              </td>
                              <PoolTableTeamLogoCell url={teamLogoUrl} teamName={teamLabel} />
                              <PoolTablePlayerPhotoCell urls={headshotUrls} playerName={p.name} />
                              <td className="px-1 py-2 transition-colors text-left align-top">
                                <span className="inline-flex items-baseline gap-1 flex-wrap min-w-0">
                                  <DraftPlayerNameLink playerName={p.name} espnAthleteId={p.espnAthleteId} />
                                  {posTrim ? (
                                    <span className="text-[10px] sm:text-[11px] text-foreground/65 font-normal tabular-nums shrink-0">
                                      {posTrim}
                                    </span>
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
                              <td className="px-1 py-2 align-top text-center text-foreground/85">{teamLabel}</td>
                              <td className="px-1 py-2 align-top text-center text-foreground/80">
                                {posTrim || "—"}
                              </td>
                              <td className="px-1 py-2 text-center">{seedDisplay}</td>
                              <td className="px-1 py-2 text-center text-foreground/80">
                                {abbrRegion(t?.region)}
                              </td>
                              <td className="px-1 py-2 text-center sleeper-score-font">{ppg}</td>
                              <td
                                className="px-1 py-2 text-center sleeper-score-font"
                                title="Draft projection: season PPG × full chalk expected games"
                              >
                                {proj}
                              </td>
                            </tr>
                          );
                        })}
                        {state && state.availablePlayers.length === 0 && (
                          <tr className="pool-table-empty">
                            <td colSpan={10} className="py-8 text-center pool-text-faint text-[11px]">
                              Pool empty or draft almost done.
                              {state.draftRoom.status === "in_progress" && (
                                <span className="mt-1 block text-amber-200/75">
                                  Load players (PPG) in Commissioner if the draft just started.
                                </span>
                              )}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <div className="pool-subpanel max-h-36 shrink-0 overflow-hidden py-2">
                <div className="mb-1 px-1 text-[11px] font-medium text-muted-foreground">Recent picks</div>
                <div className="max-h-28 overflow-x-auto overflow-y-auto">
                  <table className="pool-table w-full text-xs">
                    <thead>
                      <tr>
                        <th className="text-left">#</th>
                        <th className="text-left">Player</th>
                        <th className="text-left">Owner</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(state?.picks ?? []).slice(-12).map((p) => (
                        <tr key={p.pickOverall} className="pool-table-row">
                          <td className="font-semibold">{p.pickOverall}</td>
                          <td>
                            <div className="font-semibold">
                              <DraftPlayerNameLink playerName={p.player.name} espnAthleteId={p.player.espnAthleteId} />
                              {p.player.position ? (
                                <span className="ml-1 text-[10px] sm:text-[11px] text-foreground/65 font-normal tabular-nums">
                                  {p.player.position}
                                </span>
                              ) : null}
                            </div>
                            <div className="pool-text-faint mt-0.5">
                              {displayCollegeTeam(p.player.team)} · {displayRegionName(p.player.team?.region)}
                            </div>
                          </td>
                          <td className="pool-text-faint">{p.ownerName}</td>
                        </tr>
                      ))}
                      {(!state || state.picks.length === 0) && (
                        <tr className="pool-table-empty">
                          <td className="py-4 text-[11px]" colSpan={3}>
                            No picks yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div className="pool-subpanel py-2">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 px-1 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">Results</span>
                <span>{state?.picks?.length ?? 0} picks · Final</span>
              </div>
              <div className="mb-2 px-1">
                <div className="pool-filter-toolbar items-center gap-2">
                  <label className="pool-filter-chip">
                    <input
                      type="checkbox"
                      checked={allResultsCollapsed}
                      onChange={(e) => setAllResultsCollapsed(e.target.checked)}
                    />
                    <span>Collapse all</span>
                  </label>
                  <div className="pool-filter-select relative">
                    <span className="pool-filter-label">Owner</span>
                    <button
                      ref={resultOwnerButtonRef}
                      type="button"
                      onClick={toggleResultOwnerPicker}
                      disabled={resultOwnerOptions.length === 0}
                      className={
                        allResultOwnersSelected
                          ? "pool-filter-select-trigger pool-filter-select-trigger--all"
                          : "pool-filter-select-trigger"
                      }
                      aria-label="Filter draft results by owner"
                    >
                      <span className="pool-filter-select-trigger-text">
                        {selectedResultOwnerIds.length === 0
                          ? "None"
                          : allResultOwnersSelected
                            ? "All"
                            : selectedResultOwnerIds.length === 1
                              ? resultOwnerOptions.find((o) => o.leagueTeamId === selectedResultOwnerIds[0])?.ownerName ?? "1 selected"
                              : `${selectedResultOwnerIds.length} selected`}
                      </span>
                      <ChevronDown className="size-3 shrink-0 opacity-45" strokeWidth={2.25} aria-hidden />
                    </button>
                    {resultOwnerPickerOpen && resultOwnerPickerPos && (
                      <>
                        <div className="pool-modal-overlay" onClick={closeResultOwnerPicker} />
                        <div
                          className="pool-modal-sheet max-h-[360px] overflow-y-auto"
                          style={{
                            top: resultOwnerPickerPos.top,
                            left: resultOwnerPickerPos.left,
                            width: Math.max(220, Math.min(360, resultOwnerPickerPos.width))
                          }}
                          role="dialog"
                          aria-label="Results owner filter"
                        >
                          <div className="flex gap-2 mb-2 px-2">
                            <button
                              type="button"
                              onClick={() => setSelectedResultOwnerIds(resultOwnerOptions.map((o) => o.leagueTeamId))}
                              disabled={allResultOwnersSelected}
                              className="pool-btn-ghost flex-1"
                            >
                              All
                            </button>
                            <button
                              type="button"
                              onClick={() => setSelectedResultOwnerIds([])}
                              disabled={selectedResultOwnerIds.length === 0}
                              className="pool-btn-ghost flex-1"
                            >
                              None
                            </button>
                          </div>
                          <div>
                            {resultOwnerOptions.map((o) => {
                              const checked = selectedResultOwnerIdSet.has(o.leagueTeamId);
                              return (
                                <label
                                  key={o.leagueTeamId}
                                  className="pool-picker-row w-full px-2 cursor-pointer hover:bg-muted/40"
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => {
                                      setSelectedResultOwnerIds((prev) =>
                                        prev.includes(o.leagueTeamId)
                                          ? prev.filter((id) => id !== o.leagueTeamId)
                                          : [...prev, o.leagueTeamId]
                                      );
                                    }}
                                  />
                                  <span className="truncate text-[11px]">{o.ownerName}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {(filteredResultsByOwner ?? []).map((bucket) => {
                  const sortedPicks = bucket.picks.slice().sort((a, b) => a.pickOverall - b.pickOverall);
                  const pickRows = sortedPicks.map((p) => {
                    const adp = adpRankByPlayerId.get(p.player.id) ?? null;
                    const adpDelta = adp != null ? adp - p.pickOverall : null;
                    const origProj = numericProjection(p.player.originalProjection);
                    return { pick: p, adp, adpDelta, origProj };
                  });
                  const rc =
                    reportCardByOwnerId.get(bucket.leagueTeamId) ??
                    ({
                      avgAdp: null,
                      avgAdpDelta: null,
                      projSum: 0,
                      grade: "C",
                      percentile: 0.5,
                      rank: 1,
                      totalOwners: Math.max(1, resultsByOwner.length),
                      blurb: `${bucket.ownerName} completed the draft; report card metrics are pending.`
                    } as const);
                  return (
                    <div key={bucket.leagueTeamId} className="pool-card pool-card-compact">
                      <button
                        type="button"
                        onClick={() =>
                          setResultsOpenByOwnerId((prev) => ({
                            ...prev,
                            [bucket.leagueTeamId]: !(prev[bucket.leagueTeamId] ?? true)
                          }))
                        }
                        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md pool-card-header pool-owner-header"
                      >
                        <div className="text-sm font-semibold pool-owner-name min-w-0 truncate max-w-[min(100%,14rem)] sm:max-w-[18rem]">
                          {bucket.ownerName}
                        </div>
                        <div className="pool-owner-header-stat-meta flex min-w-0 flex-1 flex-wrap items-baseline justify-end gap-x-1.5 gap-y-0.5 text-right text-[10px] sm:text-[11px] font-normal tabular-nums">
                          <span>Report Card: {rc.grade}</span>
                          <span className="pool-owner-header-stat-meta-sep select-none" aria-hidden>·</span>
                          <span>
                            Avg ADP: {rc.avgAdp == null ? "—" : rc.avgAdp.toFixed(1)}
                          </span>
                          <span className="pool-owner-header-stat-meta-sep select-none" aria-hidden>·</span>
                          <span>
                            Avg ADP +/-: {rc.avgAdpDelta == null ? "—" : adpDeltaText(Number(rc.avgAdpDelta.toFixed(2)))}
                          </span>
                          <span className="pool-owner-header-stat-meta-sep select-none" aria-hidden>·</span>
                          <span>
                            Curve Rank: {rc.rank}/{rc.totalOwners}
                          </span>
                          <span className="pool-owner-header-stat-meta-sep select-none" aria-hidden>·</span>
                          <span>Draft Projection Total: {Math.round(rc.projSum)}</span>
                        </div>
                        <div className="text-xs flex items-center gap-2 pool-owner-chevron shrink-0">
                          {(resultsOpenByOwnerId[bucket.leagueTeamId] ?? true) ? (
                            <ChevronUp className="h-4 w-4" />
                          ) : (
                            <ChevronDown className="h-4 w-4" />
                          )}
                        </div>
                      </button>
                      <div className="mt-1 px-2 text-[11px] text-foreground/80">{rc.blurb}</div>
                      {(resultsOpenByOwnerId[bucket.leagueTeamId] ?? true) ? (
                        <>
                      <div className="mt-2 overflow-x-auto">
                        <table className="pool-table w-full text-xs">
                          <thead>
                            <tr>
                              <th className="w-10 p-1 text-center">
                                <span className="sr-only">Team logo</span>
                              </th>
                              <th className="w-10 p-1 text-center">
                                <span className="sr-only">Player photo</span>
                              </th>
                              <th className="text-left">Player</th>
                              <th className="text-center">Seed</th>
                              <th className="text-center">PPG</th>
                              <th className="text-center">Overall Pick</th>
                              <th className="text-center" title="Average Draft Position from Draft Projection rank across all loaded players">
                                ADP
                              </th>
                              <th className="text-center" title="ADP minus actual pick overall (green = value, red = reach)">
                                ADP +/-
                              </th>
                              <th className="text-center" title="Pre-tournament draft projection">
                                Draft Projection
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {pickRows.map(({ pick: p, adp, adpDelta, origProj }) => (
                              <tr key={p.pickOverall} className="pool-table-row">
                                <PoolTableTeamLogoCell
                                  url={resolveEspnTeamLogoForPoolRow({
                                    logoUrl:
                                      p.player.team?.logoUrl != null ? String(p.player.team.logoUrl) : null,
                                    shortName:
                                      p.player.team?.shortName != null ? String(p.player.team.shortName) : null,
                                    fullName: p.player.team?.name != null ? String(p.player.team.name) : null
                                  })}
                                  teamName={p.player.team?.name ?? "—"}
                                />
                                <PoolTablePlayerPhotoCell
                                  urls={p.player.headshotUrls ?? []}
                                  playerName={p.player.name}
                                />
                                <td className="px-1 py-2 transition-colors text-left align-top">
                                  <span className="inline-flex items-baseline gap-1 flex-wrap min-w-0">
                                    <DraftPlayerNameLink
                                      playerName={p.player.name}
                                      espnAthleteId={p.player.espnAthleteId}
                                    />
                                    {p.player.position ? (
                                      <span className="text-[10px] sm:text-[11px] text-foreground/65 font-normal tabular-nums shrink-0">
                                        {p.player.position}
                                      </span>
                                    ) : null}
                                  </span>
                                  <div className="text-[10px] sm:text-[11px] text-foreground/65 mt-1 leading-snug font-normal flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                                    <span className="text-foreground/75 font-medium line-clamp-2 min-w-0">
                                      {displayCollegeTeam(p.player.team)}
                                    </span>
                                    <span className="text-foreground/35" aria-hidden>
                                      ·
                                    </span>
                                    <span className="text-foreground/80">{displayRegionName(p.player.team?.region)}</span>
                                  </div>
                                </td>
                                <td className="text-center">{p.player.team?.seed ?? "—"}</td>
                                <td className="text-center sleeper-score-font">
                                  {p.player.seasonPpg != null && Number.isFinite(Number(p.player.seasonPpg))
                                    ? Number(p.player.seasonPpg).toFixed(1)
                                    : "—"}
                                </td>
                                <td className="text-center font-semibold">{p.pickOverall}</td>
                                <td className="text-center sleeper-score-font">{adpText(adp)}</td>
                                <td className="text-center sleeper-score-font">
                                  {adpDelta == null ? (
                                    "—"
                                  ) : (
                                    <span className={adpDelta >= 0 ? "text-success" : "text-danger"}>
                                      {adpDeltaText(adpDelta)}
                                    </span>
                                  )}
                                </td>
                                <td className="text-center sleeper-score-font">
                                  {origProj == null ? "—" : String(Math.round(origProj))}
                                </td>
                              </tr>
                            ))}
                            {bucket.picks.length === 0 && (
                              <tr className="pool-table-empty">
                                <td className="py-4 text-[11px]" colSpan={9}>
                                  No players drafted.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                        </>
                      ) : null}
                    </div>
                  );
                })}
                {filteredResultsByOwner.length === 0 && (
                  <div className="pool-text-faint px-1 text-[11px]">No results.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

