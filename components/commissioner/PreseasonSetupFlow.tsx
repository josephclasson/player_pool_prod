"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

function formatApiError(json: unknown, fallback: string): string {
  const err = (json as { error?: unknown })?.error;
  if (typeof err === "string") return err;
  if (err != null && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

async function readJsonResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`HTTP ${res.status}: expected JSON`);
  }
}

const NO_LEAGUE_STORAGE_KEY = "__pending__";

type Step1Path = "create" | "existing";

type ProgressStore = {
  leagueGate: boolean;
  /** Step 1: commissioner explicitly chose create vs modify before seeing that flow */
  step1Path: Step1Path | null;
  ownersDone: boolean;
  dataLoadDone: boolean;
  playersDone: boolean;
  draftStarted: boolean;
};

const defaultProgress: ProgressStore = {
  leagueGate: false,
  step1Path: null,
  ownersDone: false,
  dataLoadDone: false,
  playersDone: false,
  draftStarted: false
};

function storageKey(leagueKey: string) {
  const t = leagueKey.trim();
  return `pp_preseason_${t || NO_LEAGUE_STORAGE_KEY}`;
}

function loadProgress(leagueKey: string): ProgressStore {
  if (typeof window === "undefined") return defaultProgress;
  try {
    const key = storageKey(leagueKey);
    const localRaw = localStorage.getItem(key);
    const sessionRaw = sessionStorage.getItem(key);
    const raw = localRaw ?? sessionRaw;
    if (!raw) {
      // If we previously saved progress while `leagueKey` was temporarily empty,
      // it would have been stored under the pending key. Migrate it forward once we know the real league.
      if (!leagueKey.trim()) return defaultProgress;
      const pendingRaw = sessionStorage.getItem(storageKey(""));
      if (!pendingRaw) return defaultProgress;
      const o = JSON.parse(pendingRaw) as Partial<ProgressStore>;
      const merged = {
        ...defaultProgress,
        ...o,
        step1Path:
          o.step1Path === "create" || o.step1Path === "existing" ? o.step1Path : defaultProgress.step1Path
      };
      // Best-effort migration: if localStorage is available, store under the real league key too.
      try {
        localStorage.setItem(key, JSON.stringify(merged));
      } catch {
        /* ignore */
      }
      return merged;
    }

    const o = JSON.parse(raw) as Partial<ProgressStore>;
    return {
      ...defaultProgress,
      ...o,
      step1Path:
        o.step1Path === "create" || o.step1Path === "existing" ? o.step1Path : defaultProgress.step1Path
    };
  } catch {
    return defaultProgress;
  }
}

function saveProgress(leagueKey: string, p: ProgressStore) {
  try {
    // Do not persist under the pending key; that causes "choose your path" to reset
    // when the leagueId arrives after mount.
    if (!leagueKey.trim()) return;
    localStorage.setItem(storageKey(leagueKey), JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

type LeagueTeamRow = {
  id: string;
  teamName: string;
  draftPosition: number | null;
  userId?: string;
  isCommissioner?: boolean;
};

type EditableTeamRow = LeagueTeamRow & { clientKey: string };

function rosterSignature(rows: EditableTeamRow[]): string {
  return JSON.stringify(rows.map((r) => ({ id: r.id, teamName: r.teamName.trim() })));
}

type Props = {
  /** Current league UUID or short code (same value all commissioner tools use). */
  leagueId: string;
  setLeagueId: (id: string) => void;
  commissionerHeaders: (json?: boolean) => HeadersInit;
  /** True when commissioner password is set (or local NEXT_PUBLIC dev flag). */
  sessionReady: boolean;
  onGatesChange?: (g: { ownersDone: boolean; dataLoadDone: boolean; draftStarted: boolean }) => void;
};

export function PreseasonSetupFlow({
  leagueId,
  setLeagueId,
  commissionerHeaders,
  sessionReady,
  onGatesChange
}: Props) {
  const [leagueName, setLeagueName] = useState("");
  const [leagueCode, setLeagueCode] = useState("");
  const [seasonYear, setSeasonYear] = useState(2026);
  const [createBusy, setCreateBusy] = useState(false);
  const [startDraftBusy, setStartDraftBusy] = useState(false);
  const [ownerCsv, setOwnerCsv] = useState("");
  const [ownerPass, setOwnerPass] = useState("");
  const [ownersBusy, setOwnersBusy] = useState(false);
  const [localMsg, setLocalMsg] = useState<string | null>(null);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressStore>(defaultProgress);

  const [leagueTeams, setLeagueTeams] = useState<LeagueTeamRow[] | null>(null);
  const [editableRows, setEditableRows] = useState<EditableTeamRow[]>([]);
  const [rosterBaselineJson, setRosterBaselineJson] = useState("");
  const [leagueTeamsErr, setLeagueTeamsErr] = useState<string | null>(null);
  const [leagueTeamsBusy, setLeagueTeamsBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);

  const key = leagueId.trim();
  const hasLeague = key.length > 0;

  const fetchLeagueTeams = useCallback(async () => {
    if (!hasLeague || !key) return;
    setLeagueTeamsBusy(true);
    setLeagueTeamsErr(null);
    try {
      const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/owners/list`, {
        headers: commissionerHeaders(false)
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `HTTP ${res.status}`));
      const teams = (json as { teams?: LeagueTeamRow[] }).teams ?? [];
      setLeagueTeams(teams);
      const mapped: EditableTeamRow[] = teams.map((t) => ({
        ...t,
        clientKey: t.id
      }));
      setEditableRows(mapped);
      setRosterBaselineJson(rosterSignature(mapped));
    } catch (e: unknown) {
      setLeagueTeams(null);
      setEditableRows([]);
      setRosterBaselineJson("");
      setLeagueTeamsErr(e instanceof Error ? e.message : "Failed to load league teams");
    } finally {
      setLeagueTeamsBusy(false);
    }
  }, [commissionerHeaders, hasLeague, key]);

  /** After league is connected (any path), load teams so step 2 can show existing owners + bypass. */
  useEffect(() => {
    if (!progress.leagueGate || !hasLeague || progress.ownersDone) {
      setLeagueTeams(null);
      setEditableRows([]);
      setRosterBaselineJson("");
      setLeagueTeamsErr(null);
      setLeagueTeamsBusy(false);
      return;
    }
    setLeagueTeamsBusy(true);
    void fetchLeagueTeams();
  }, [progress.leagueGate, progress.ownersDone, hasLeague, leagueId, fetchLeagueTeams]);

  useEffect(() => {
    setProgress(loadProgress(leagueId));
  }, [leagueId]);

  useEffect(() => {
    saveProgress(leagueId, progress);
  }, [leagueId, progress]);

  useEffect(() => {
    onGatesChange?.({
      ownersDone: progress.ownersDone,
      dataLoadDone: progress.dataLoadDone,
      draftStarted: progress.draftStarted
    });
  }, [progress.ownersDone, progress.dataLoadDone, progress.draftStarted, onGatesChange]);

  const activeStep = useMemo(() => {
    if (!progress.leagueGate) return 1;
    if (!progress.ownersDone) return 2;
    if (!progress.dataLoadDone) return 3;
    if (!progress.playersDone) return 4;
    if (!progress.draftStarted) return 5;
    return 6;
  }, [progress]);

  const rosterDirty = useMemo(
    () => rosterSignature(editableRows) !== rosterBaselineJson,
    [editableRows, rosterBaselineJson]
  );

  const setP = useCallback((patch: Partial<ProgressStore>) => {
    setProgress((prev) => ({ ...prev, ...patch }));
  }, []);

  const onCreateLeague = useCallback(async () => {
    setCreateBusy(true);
    setLocalErr(null);
    setLocalMsg(null);
    try {
      if (!leagueName.trim() || !leagueCode.trim()) {
        throw new Error("Enter league display name and short league id (code).");
      }
      const res = await fetch("/api/commissioner/leagues/create", {
        method: "POST",
        headers: commissionerHeaders(true),
        body: JSON.stringify({
          name: leagueName.trim(),
          code: leagueCode.trim(),
          seasonYear
        })
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Create failed: ${res.status}`));
      const j = json as { league?: { id: string; code: string } };
      if (!j.league?.id) throw new Error("No league id returned");
      const id = j.league.id;
      const merged = { ...defaultProgress, leagueGate: true, step1Path: "create" as const };
      saveProgress(id, merged);
      setLeagueId(id);
      setProgress(merged);
      setLocalMsg(`League created — code "${j.league.code}". UUID filled in the league field at the top of this section.`);
    } catch (e: unknown) {
      setLocalErr(e instanceof Error ? e.message : "Create league failed");
    } finally {
      setCreateBusy(false);
    }
  }, [commissionerHeaders, leagueName, leagueCode, seasonYear, setLeagueId]);

  const onContinueWithExistingLeague = useCallback(() => {
    if (!hasLeague) {
      setLocalErr("Paste or enter your league UUID or code in the league field in Pre-season setup first.");
      return;
    }
    setLocalErr(null);
    const merged = {
      ...loadProgress(leagueId),
      leagueGate: true,
      step1Path: "existing" as const
    };
    setProgress(merged);
    saveProgress(leagueId, merged);
    setLocalMsg("Continuing with this league.");
  }, [hasLeague, leagueId]);

  const onEnsureOwners = useCallback(async () => {
    if (!progress.leagueGate) {
      setLocalErr("Finish step 1 first (create league or continue with an existing ID).");
      return;
    }
    if (!hasLeague) {
      setLocalErr("Enter the league UUID (or code) in the league field in Pre-season setup first.");
      return;
    }
    setOwnersBusy(true);
    setLocalErr(null);
    setLocalMsg(null);
    try {
      const ownerDisplayNames = ownerCsv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!ownerDisplayNames.length) throw new Error("Enter at least one owner name.");
      const body: { ownerDisplayNames: string[]; passcode?: string } = { ownerDisplayNames };
      const pc = ownerPass.trim();
      if (pc) body.passcode = pc;
      const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/owners/ensure`, {
        method: "POST",
        headers: commissionerHeaders(true),
        body: JSON.stringify(body)
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Ensure owners failed: ${res.status}`));
      setP({ ownersDone: true });
      setLocalMsg("Owners / teams updated. Draft order follows the list order.");
      void fetchLeagueTeams();
    } catch (e: unknown) {
      setLocalErr(e instanceof Error ? e.message : "Ensure owners failed");
    } finally {
      setOwnersBusy(false);
    }
  }, [
    commissionerHeaders,
    fetchLeagueTeams,
    hasLeague,
    key,
    ownerCsv,
    ownerPass,
    progress.leagueGate,
    setP
  ]);

  const syncRoster = useCallback(async (): Promise<boolean> => {
    if (!hasLeague || !key) {
      setLocalErr("Enter a league id first.");
      return false;
    }
    if (editableRows.length === 0) {
      setLocalErr("Add at least one owner with a name.");
      return false;
    }
    if (editableRows.some((r) => r.teamName.trim() === "")) {
      setLocalErr("Fill in every owner name or remove empty rows.");
      return false;
    }
    const rows = editableRows;
    setSyncBusy(true);
    setLocalErr(null);
    setLocalMsg(null);
    try {
      const body: {
        teams: Array<{ id?: string; teamName: string }>;
        passcode?: string;
      } = {
        teams: rows.map((r) => {
          const name = r.teamName.trim();
          if (r.id) return { id: r.id, teamName: name };
          return { teamName: name };
        })
      };
      const pc = ownerPass.trim();
      if (pc) body.passcode = pc;
      const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/owners/sync`, {
        method: "PUT",
        headers: commissionerHeaders(true),
        body: JSON.stringify(body)
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Save roster failed: ${res.status}`));
      setLocalMsg("Roster saved.");
      await fetchLeagueTeams();
      return true;
    } catch (e: unknown) {
      setLocalErr(e instanceof Error ? e.message : "Save roster failed");
      return false;
    } finally {
      setSyncBusy(false);
    }
  }, [commissionerHeaders, editableRows, fetchLeagueTeams, hasLeague, key, ownerPass]);

  const onContinueOwnersStep = useCallback(async () => {
    if (activeStep !== 2) return;
    setLocalErr(null);
    if (rosterDirty) {
      const hasEmpty = editableRows.some((r) => r.teamName.trim() === "");
      if (hasEmpty) {
        setLocalErr("Fill in every owner name or remove empty rows before continuing.");
        return;
      }
      const ok = await syncRoster();
      if (!ok) return;
    }
    setP({ ownersDone: true });
  }, [activeStep, editableRows, rosterDirty, setP, syncRoster]);

  function addOwnerRow() {
    setEditableRows((prev) => [
      ...prev,
      {
        clientKey: `new-${crypto.randomUUID()}`,
        id: "",
        teamName: "",
        draftPosition: null,
        isCommissioner: false
      }
    ]);
  }

  function removeOwnerRow(clientKey: string) {
    setEditableRows((prev) => prev.filter((r) => r.clientKey !== clientKey));
  }

  function moveOwnerRow(clientKey: string, dir: -1 | 1) {
    setEditableRows((prev) => {
      const i = prev.findIndex((r) => r.clientKey === clientKey);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  function updateOwnerName(clientKey: string, teamName: string) {
    setEditableRows((prev) => prev.map((r) => (r.clientKey === clientKey ? { ...r, teamName } : r)));
  }

  const onStartDraft = useCallback(async () => {
    if (!hasLeague) {
      setLocalErr("Enter the league UUID (or code) first.");
      return;
    }
    setStartDraftBusy(true);
    setLocalErr(null);
    setLocalMsg(null);
    try {
      const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/draft/start`, {
        method: "POST",
        headers: commissionerHeaders(true),
        body: JSON.stringify({})
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Start draft failed: ${res.status}`));
      const j = json as { startStatus?: string };
      setP({ draftStarted: true });
      setLocalMsg(
        `Draft room ready (${j.startStatus ?? "ok"}). Open the Draft tab — available players are already your pre-season pool; no Draft-tab init needed.`
      );
    } catch (e: unknown) {
      setLocalErr(e instanceof Error ? e.message : "Start draft failed");
    } finally {
      setStartDraftBusy(false);
    }
  }, [commissionerHeaders, hasLeague, key, setP]);

  function StepDoneRow({ n, title }: { n: number; title: string }) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-sm">
        <span className="font-medium text-emerald-400/95">
          ✓ Step {n}: {title}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-foreground/35">Done</span>
      </div>
    );
  }

  function StepLockedRow({ n, title }: { n: number; title: string }) {
    return (
      <div className="rounded-lg border border-border/30 bg-muted/5 px-3 py-2 text-sm text-foreground/40">
        <span className="font-medium">{n}.</span> {title}{" "}
        <span className="text-foreground/30">— complete the highlighted step first</span>
      </div>
    );
  }

  return (
    <div className="pool-subpanel space-y-4 border border-accent/20 rounded-xl p-4">
      <div>
        <div className="pool-text-title">Pre-season setup (guided)</div>
        <p className="pool-text-muted-sm mt-1">
          Work top to bottom. Only one step is expanded at a time; finished steps collapse. The{" "}
          <span className="text-[rgb(var(--pool-stats-accent))] font-semibold">gold button</span> is always your
          next action.
        </p>
      </div>

      <div className="rounded-xl border border-border/50 bg-muted/10 p-3 space-y-2">
        <label className="flex flex-col gap-1">
          <span className="pool-label">League UUID or code</span>
          <input
            className="pool-field font-mono text-[12px]"
            value={leagueId}
            onChange={(e) => setLeagueId(e.target.value)}
            placeholder="e.g. CHALK26 or paste full UUID"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className="pool-text-muted-sm text-xs leading-relaxed">
          Set the league you&apos;re working on (same id used everywhere on this page after the wizard). For{" "}
          <strong>Modify existing league</strong>, enter it before you continue. For <strong>Create new league</strong>
          , it fills in automatically after creation.
        </p>
      </div>

      <details className="space-y-4 rounded-xl border border-border/40 bg-muted/5 p-2" open>
        <summary className="pool-text-title cursor-pointer select-none rounded-lg px-2 py-2 text-sm hover:bg-muted/30">
          Pre-season wizard
        </summary>
        <div className="space-y-4 px-1 pb-2 pt-1">
      {/* Step 1 */}
      {progress.leagueGate && activeStep > 1 ? (
        <StepDoneRow
          n={1}
          title={
            progress.step1Path === "create"
              ? "League ready (new league)"
              : progress.step1Path === "existing"
                ? "League ready (existing league)"
                : "League ready"
          }
        />
      ) : (
        <div
          className={`space-y-3 rounded-xl border bg-muted/10 p-4 ${activeStep === 1 ? "pool-step-current border-border/70" : "border-border/40 opacity-80"}`}
        >
          <div className="text-[11px] font-bold uppercase tracking-wider text-[rgb(var(--pool-stats-accent))]">
            Current step · 1 of 5
          </div>
          <div className="font-semibold text-foreground">League — choose your path</div>
          {!sessionReady && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100/90">
              Sign in first (email link or password) — then you can continue.
            </p>
          )}

          {progress.step1Path == null ? (
            <>
              <p className="pool-text-muted-sm text-sm">
                Pick one — you&apos;ll only see the fields and actions for that choice. The gold button is always
                your next step after you choose.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={!sessionReady}
                  onClick={() => {
                    setLocalErr(null);
                    setLocalMsg(null);
                    setP({ step1Path: "create" });
                  }}
                  className={[
                    "rounded-xl border p-4 text-left transition-colors",
                    "border-border/60 bg-background/40 hover:border-[rgb(var(--pool-stats-accent))]/50 hover:bg-muted/30",
                    "disabled:cursor-not-allowed disabled:opacity-50"
                  ].join(" ")}
                >
                  <div className="text-sm font-bold text-foreground">Create new league</div>
                  <p className="mt-2 text-xs pool-text-muted-sm leading-relaxed">
                    Start a brand-new pool. You&apos;ll name it, pick a short code, and we&apos;ll fill in the league
                    UUID after creation.
                  </p>
                </button>
                <button
                  type="button"
                  disabled={!sessionReady}
                  onClick={() => {
                    setLocalErr(null);
                    setLocalMsg(null);
                    setP({ step1Path: "existing" });
                  }}
                  className={[
                    "rounded-xl border p-4 text-left transition-colors",
                    "border-border/60 bg-background/40 hover:border-[rgb(var(--pool-stats-accent))]/50 hover:bg-muted/30",
                    "disabled:cursor-not-allowed disabled:opacity-50"
                  ].join(" ")}
                >
                  <div className="text-sm font-bold text-foreground">Modify existing league</div>
                  <p className="mt-2 text-xs pool-text-muted-sm leading-relaxed">
                    Your league already exists. Enter its UUID or code in the <strong>League UUID or code</strong> field
                    at the top of this section, then confirm below.
                  </p>
                </button>
              </div>
            </>
          ) : progress.step1Path === "create" ? (
            <>
              <p className="pool-text-muted-sm text-sm">
                New league: enter display name, short code, and season. Your league <strong>UUID</strong> appears in
                the league field at the top of this section after you create.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="pool-label">League display name</span>
                  <input
                    className="pool-field"
                    value={leagueName}
                    onChange={(e) => setLeagueName(e.target.value)}
                    placeholder="Chalk Pool 2026"
                    disabled={!sessionReady}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="pool-label">Short league id (code)</span>
                  <input
                    className="pool-field"
                    value={leagueCode}
                    onChange={(e) => setLeagueCode(e.target.value)}
                    placeholder="CHALK26"
                    disabled={!sessionReady}
                  />
                </label>
                <label className="flex flex-col gap-1 sm:col-span-2">
                  <span className="pool-label">Season year</span>
                  <input
                    className="pool-field max-w-[120px]"
                    type="number"
                    value={seasonYear}
                    onChange={(e) => setSeasonYear(Number(e.target.value))}
                    disabled={!sessionReady}
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  className="pool-next-cta"
                  size="md"
                  onClick={() => void onCreateLeague()}
                  disabled={createBusy || !sessionReady}
                >
                  {createBusy ? "Creating…" : "Create league"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  className="text-foreground/70"
                  onClick={() => {
                    setLocalErr(null);
                    setLocalMsg(null);
                    setP({ step1Path: null });
                  }}
                >
                  ← Choose different path
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="pool-text-muted-sm text-sm">
                Use the <strong>League UUID or code</strong> field at the top of Pre-season setup (same value all
                season), then confirm to unlock the next steps.
              </p>
              {!hasLeague && (
                <p className="rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs text-foreground/75">
                  The league field is empty — paste or type your id at the top of this section first.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  className="pool-next-cta"
                  type="button"
                  size="md"
                  onClick={onContinueWithExistingLeague}
                  disabled={!sessionReady || !hasLeague}
                >
                  Continue with this league
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  className="text-foreground/70"
                  onClick={() => {
                    setLocalErr(null);
                    setLocalMsg(null);
                    setP({ step1Path: null });
                  }}
                >
                  ← Choose different path
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Step 2 */}
      {!progress.leagueGate ? (
        <StepLockedRow n={2} title="Owners & teams" />
      ) : (
        <div
          className={`space-y-3 rounded-xl border bg-muted/10 p-4 ${activeStep === 2 ? "pool-step-current border-border/70" : "border-border/40 opacity-80"}`}
        >
          <div className="text-[11px] font-bold uppercase tracking-wider text-[rgb(var(--pool-stats-accent))]">
            Current step · 2 of 5
          </div>

          <div className="font-semibold text-foreground">Owners &amp; teams</div>
          <p className="pool-text-muted-sm text-sm">
            Teams load from the server. Edit names, reorder with ↑/↓, add a row, or remove a row (the
            commissioner&apos;s slot can&apos;t be deleted). <strong>Save roster</strong> applies changes;{" "}
            <strong>Continue to next step</strong> saves first if you have unsaved edits. New owners use the optional
            passcode field below (same as Ensure).
          </p>
          {leagueTeamsBusy && <p className="text-sm pool-text-muted-sm">Loading league teams…</p>}
          {leagueTeamsErr && (
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-sm text-foreground/90">
              <strong>Could not load teams</strong> — {leagueTeamsErr} Set the commissioner password in the header or
              on this page (<code className="pool-code">COMMISSIONER_API_SECRET</code>). You can still add owners with
              the form below.
            </div>
          )}

          {!leagueTeamsBusy && leagueTeams !== null && leagueTeams.length > 0 && (
            <>
              {rosterDirty && (
                <p className="text-xs font-medium text-amber-600/95 dark:text-amber-400/90">
                  Unsaved changes — save or continue to apply them.
                </p>
              )}
              {rosterDirty && progress.draftStarted && (
                <p className="text-xs font-medium text-amber-600/95 dark:text-amber-400/90">
                  Draft is already started: saving owners also updates draft order. If you changed order or owner
                  count, use <strong>Draft reset</strong> afterward to avoid pick attribution issues.
                </p>
              )}
              <div className="overflow-x-auto rounded-lg border border-border/50">
                <table className="pool-table w-full text-left text-[11px]">
                  <thead className="border-b border-border/40 bg-muted/30">
                    <tr>
                      <th className="px-2 py-1.5 font-semibold">Pick #</th>
                      <th className="px-2 py-1.5 font-semibold">Team name</th>
                      <th className="px-2 py-1.5 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editableRows.map((t, idx) => (
                      <tr key={t.clientKey} className="pool-table-row border-b border-border/30">
                        <td className="px-2 py-1.5 font-mono align-middle">{idx + 1}</td>
                        <td className="px-2 py-1.5 align-middle">
                          <input
                            className="pool-field h-8 py-1 text-[11px]"
                            value={t.teamName}
                            onChange={(e) => updateOwnerName(t.clientKey, e.target.value)}
                            placeholder="Owner / team name"
                            disabled={leagueTeamsBusy}
                            aria-label={`Team name pick ${idx + 1}`}
                          />
                        </td>
                        <td className="px-2 py-1.5 align-middle text-right whitespace-nowrap">
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-[10px]"
                              disabled={leagueTeamsBusy || idx === 0}
                              onClick={() => moveOwnerRow(t.clientKey, -1)}
                              title="Move up in draft order"
                            >
                              ↑
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-[10px]"
                              disabled={leagueTeamsBusy || idx >= editableRows.length - 1}
                              onClick={() => moveOwnerRow(t.clientKey, 1)}
                              title="Move down in draft order"
                            >
                              ↓
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-[10px] text-destructive border-destructive/40 hover:bg-destructive/10"
                              disabled={leagueTeamsBusy || t.isCommissioner}
                              onClick={() => removeOwnerRow(t.clientKey)}
                              title={
                                t.isCommissioner
                                  ? "Cannot delete the commissioner's team"
                                  : "Remove this owner"
                              }
                            >
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  disabled={leagueTeamsBusy}
                  onClick={addOwnerRow}
                >
                  Add owner
                </Button>
              </div>
              <p className="pool-text-muted-sm text-xs">
                Optional passcode for <strong>new</strong> owners (blank = demo1234):
              </p>
              <input
                className="pool-field max-w-xs"
                type="password"
                autoComplete="off"
                placeholder="Passcode for new demo users"
                value={ownerPass}
                onChange={(e) => setOwnerPass(e.target.value)}
                disabled={leagueTeamsBusy}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  className="pool-next-cta"
                  size="md"
                  disabled={activeStep !== 2 || syncBusy}
                  onClick={() => void onContinueOwnersStep()}
                >
                  {syncBusy ? "Saving…" : "Continue to next step"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  disabled={syncBusy || leagueTeamsBusy || !sessionReady || !rosterDirty}
                  onClick={() => void syncRoster()}
                >
                  {syncBusy ? "Saving…" : "Save roster"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  disabled={leagueTeamsBusy || syncBusy}
                  onClick={() => void fetchLeagueTeams()}
                >
                  Refresh list
                </Button>
              </div>
              <details className="rounded-lg border border-border/50 bg-muted/10 p-3">
                <summary className="cursor-pointer text-sm font-semibold text-foreground">
                  Bulk add / replace (Ensure CSV)
                </summary>
                <p className="mt-2 pool-text-muted-sm text-xs">
                  Comma-separated names in draft order (adds without removing existing). Same as{" "}
                  <strong>League owners &amp; draft</strong> below.
                </p>
                <input
                  className="pool-field mt-2"
                  value={ownerCsv}
                  onChange={(e) => setOwnerCsv(e.target.value)}
                  placeholder="Alice, Bob, Carol"
                  disabled={leagueTeamsBusy}
                />
                <div className="mt-2">
                  <Button
                    size="md"
                    variant="outline"
                    onClick={() => void onEnsureOwners()}
                    disabled={!hasLeague || ownersBusy || !sessionReady}
                  >
                    {ownersBusy ? "Saving…" : "Ensure owners / teams"}
                  </Button>
                </div>
              </details>
            </>
          )}

          {!leagueTeamsBusy &&
            (leagueTeamsErr || (leagueTeams !== null && leagueTeams.length === 0)) && (
              <>
                {progress.step1Path === "create" ? (
                  <p className="text-sm text-foreground/85">
                    <strong>New league:</strong> no teams in the database yet. Add owners below (creates demo users +{" "}
                    <code className="pool-code">league_teams</code>) in draft order.
                  </p>
                ) : leagueTeamsErr ? (
                  <p className="text-sm font-semibold text-foreground">Add owners manually</p>
                ) : (
                  <p className="text-sm text-foreground/85">
                    No teams returned for this league yet. Add owners below (creates demo users +{" "}
                    <code className="pool-code">league_teams</code>).
                  </p>
                )}
                <input
                  className="pool-field"
                  value={ownerCsv}
                  onChange={(e) => setOwnerCsv(e.target.value)}
                  placeholder="Alice, Bob, Carol"
                  disabled={leagueTeamsBusy}
                />
                <input
                  className="pool-field max-w-xs"
                  type="password"
                  autoComplete="off"
                  placeholder="Optional — blank = demo1234, or 3+ chars (e.g. 365)"
                  value={ownerPass}
                  onChange={(e) => setOwnerPass(e.target.value)}
                  disabled={leagueTeamsBusy}
                />
                <Button
                  className={activeStep === 2 ? "pool-next-cta" : ""}
                  size="md"
                  variant={activeStep === 2 ? "default" : "outline"}
                  onClick={() => void onEnsureOwners()}
                  disabled={!hasLeague || ownersBusy || !sessionReady}
                >
                  {ownersBusy ? "Saving…" : "Ensure owners / teams"}
                </Button>
              </>
            )}
        </div>
      )}

      {/* Step 3 */}
      {!progress.ownersDone ? (
        <StepLockedRow n={3} title="Tournament data load" />
      ) : progress.dataLoadDone && activeStep > 3 ? (
        <StepDoneRow n={3} title="Tournament data load" />
      ) : (
        <div
          className={`space-y-3 rounded-xl border bg-muted/10 p-4 ${activeStep === 3 ? "pool-step-current border-border/70" : "border-border/40 opacity-80"}`}
        >
          <div className="text-[11px] font-bold uppercase tracking-wider text-[rgb(var(--pool-stats-accent))]">
            Current step · 3 of 5
          </div>
          <div className="font-semibold text-foreground">Load tournament data</div>
          <p className="pool-text-muted-sm text-sm">
            Scroll to{" "}
            <a className="pool-link" href="#commissioner-easy-actions">
              Easy commissioner actions
            </a>{" "}
            below. Run <strong>1 · Run full tournament setup</strong> (and <strong>2 · Load every tournament day</strong>{" "}
            for box scores), then check the box here.
          </p>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={progress.dataLoadDone}
              onChange={(e) => setP({ dataLoadDone: e.target.checked })}
              disabled={activeStep !== 3}
            />
            <span>
              I&apos;ve run <strong>Easy commissioner actions</strong> (setup + scores) for this league.
            </span>
          </label>
          {activeStep === 3 && !progress.dataLoadDone && (
            <Button
              type="button"
              size="md"
              className="pool-next-cta w-fit"
              onClick={() => setP({ dataLoadDone: true })}
            >
              Data load done — continue
            </Button>
          )}
        </div>
      )}

      {/* Step 4 */}
      {!progress.dataLoadDone ? (
        <StepLockedRow n={4} title="Verify player pool" />
      ) : progress.playersDone && activeStep > 4 ? (
        <StepDoneRow n={4} title="Verify player pool" />
      ) : (
        <div
          className={`space-y-3 rounded-xl border bg-muted/10 p-4 ${activeStep === 4 ? "pool-step-current border-border/70" : "border-border/40 opacity-80"}`}
        >
          <div className="text-[11px] font-bold uppercase tracking-wider text-[rgb(var(--pool-stats-accent))]">
            Current step · 4 of 5
          </div>
          <div className="font-semibold text-foreground">Verify player pool</div>
          <p className="pool-text-muted-sm text-sm">
            Open the Player Statistics tab and confirm imports look reasonable.
          </p>
          <Link
            href={`/players?seasonYear=${seasonYear}`}
            className={`inline-flex font-semibold ${activeStep === 4 ? "pool-link" : "pointer-events-none text-foreground/35"}`}
          >
            Open Player Statistics (season {seasonYear}) →
          </Link>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={progress.playersDone}
              onChange={(e) => setP({ playersDone: e.target.checked })}
              disabled={activeStep !== 4}
            />
            <span>Players look good — continue to starting the draft</span>
          </label>
          {activeStep === 4 && !progress.playersDone && (
            <Button
              type="button"
              size="md"
              className="pool-next-cta w-fit"
              onClick={() => setP({ playersDone: true })}
            >
              Players verified — continue
            </Button>
          )}
        </div>
      )}

      {/* Step 5 */}
      {!progress.playersDone ? (
        <StepLockedRow n={5} title="Start draft" />
      ) : progress.draftStarted && activeStep > 5 ? (
        <StepDoneRow n={5} title="Draft started" />
      ) : (
        <div
          className={`space-y-3 rounded-xl border bg-muted/10 p-4 ${activeStep === 5 ? "pool-step-current border-border/70" : "border-border/40 opacity-80"}`}
        >
          <div className="text-[11px] font-bold uppercase tracking-wider text-[rgb(var(--pool-stats-accent))]">
            Current step · 5 of 5
          </div>
          <div className="font-semibold text-foreground">Start the draft room</div>
          <p className="pool-text-muted-sm text-sm">
            Creates the draft room (snake order from your owner list). Then owners pick on the Draft tab.
          </p>
          <Button
            className={activeStep === 5 ? "pool-next-cta" : ""}
            size="md"
            variant={activeStep === 5 ? "default" : "outline"}
            onClick={() => void onStartDraft()}
            disabled={!hasLeague || startDraftBusy || activeStep !== 5}
          >
            {startDraftBusy ? "Starting…" : "Start draft for this league"}
          </Button>
          {hasLeague && paramLooksLikeUuid(key) && activeStep === 5 && (
            <div>
              <Link
                href={`/draft?leagueId=${encodeURIComponent(key)}`}
                className="pool-link font-semibold text-sm"
              >
                Open Draft tab with this league →
              </Link>
            </div>
          )}
        </div>
      )}

      {/* After wizard */}
      {progress.draftStarted && (
        <div className="space-y-2 rounded-xl border border-border/50 bg-muted/5 p-4 text-sm">
          <div className="font-semibold text-foreground">You&apos;re ready to draft</div>
          <p className="pool-text-muted-sm">
            Extra commissioner tools (sync, invites, seeds, bulk assign) are unlocked below. Owners use the Draft
            tab; use <strong>proxy picks</strong> there after entering the commissioner password in the header.
          </p>
          <p className="pool-text-muted-sm">
            <strong>Offline draft:</strong> use <strong>Download Excel template</strong> / <strong>Assign rosters from Excel</strong> or{" "}
            <strong>Bulk assign rosters (JSON)</strong> in the section below.
          </p>
        </div>
      )}
        </div>
      </details>

      {localMsg && <div className="text-sm pool-text-body border-t border-border/40 pt-3">{localMsg}</div>}
      {localErr && <div className="pool-alert-danger text-sm">{localErr}</div>}
    </div>
  );
}

function paramLooksLikeUuid(raw: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.trim());
}
