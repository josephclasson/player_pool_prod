"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PreseasonSetupFlow } from "@/components/commissioner/PreseasonSetupFlow";
import {
  PLAYER_POOL_IDENTITY_CHANGE_EVENT,
  readPlayerPoolSession,
  writeCommissionerSecretToSession
} from "@/lib/player-pool-session";
import { readStoredActiveLeagueId, writeStoredActiveLeagueId } from "@/lib/player-pool-storage";
import {
  TOURNAMENT_SYNC_MAX_CALENDAR_DAYS,
  utcDateISOsFromStart,
  utcTodayISO
} from "@/lib/ncaa-tournament-calendar";

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
    const t = text.trimStart();
    const isHtml = t.startsWith("<!DOCTYPE") || t.startsWith("<html") || t.startsWith("<HTML");
    const hint = isHtml
      ? "the server returned an HTML error page (not JSON). Open the terminal where `npm run dev` is running and look for a stack trace or compile error for this request."
      : `${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`;
    throw new Error(`HTTP ${res.status}: expected JSON, got ${hint}`);
  }
}

export function CommissionerForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const queryString = sp.toString();
  const leagueIdFromQuery = useMemo(() => {
    const params = new URLSearchParams(queryString);
    const raw = params.get("leagueId");
    if (raw == null || raw === "") return undefined;
    const t = raw.trim();
    return t.length ? t : undefined;
  }, [queryString]);

  const [leagueId, setLeagueId] = useState<string>(leagueIdFromQuery ?? "");
  const [syncDateISO, setSyncDateISO] = useState<string>("");
  /** First Round (round of 64) Thursday YYYY-MM-DD — remembered per league in sessionStorage. */
  const [firstRoundThursday, setFirstRoundThursday] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [tournamentSyncBusy, setTournamentSyncBusy] = useState(false);
  const [boxscoreBackfillBusy, setBoxscoreBackfillBusy] = useState(false);
  const [recomputeBusy, setRecomputeBusy] = useState(false);
  const [committeeScrapeBusy, setCommitteeScrapeBusy] = useState(false);
  const [committeeReportUrl, setCommitteeReportUrl] = useState("");
  const [playersBusy, setPlayersBusy] = useState(false);
  const [populatePlayersBusy, setPopulatePlayersBusy] = useState(false);
  const [playersJson, setPlayersJson] = useState(
    '{\n  "source": "manual_player_list",\n  "replace": false,\n  "players": [\n    {\n      "name": "Cameron Boozer",\n      "teamSeo": "duke",\n      "seasonPpg": 0,\n      "externalPlayerId": "example_boozer"\n    }\n  ]\n}'
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Same value as server `COMMISSIONER_API_SECRET` (shared commissioner password). */
  const [commissionerSecret, setCommissionerSecret] = useState("");
  const [setupPopulate, setSetupPopulate] = useState(true);
  const [setupBusy, setSetupBusy] = useState(false);
  const [draftResetBusy, setDraftResetBusy] = useState(false);
  const [bulkAssignBusy, setBulkAssignBusy] = useState(false);
  const [draftTemplateBusy, setDraftTemplateBusy] = useState(false);
  const [draftXlsxBusy, setDraftXlsxBusy] = useState(false);
  const [ensureOwnersBusy, setEnsureOwnersBusy] = useState(false);
  const [inviteOwnersBusy, setInviteOwnersBusy] = useState(false);
  const draftExcelInputRef = useRef<HTMLInputElement>(null);
  const [bulkAssignJson, setBulkAssignJson] = useState(
    '{\n  "assignments": {\n    "paste-league-team-uuid": [101, 102, 103]\n  }\n}'
  );
  const [ownerNamesCsv, setOwnerNamesCsv] = useState("Alice, Bob, Carol");
  const [ensureOwnersPasscode, setEnsureOwnersPasscode] = useState("");
  const [ownerInvitesJson, setOwnerInvitesJson] = useState(
    '{\n  "owners": [\n    { "fullName": "Alice Example", "username": "alice", "email": "alice@example.com" },\n    { "fullName": "Bob Example", "username": "bob", "email": "bob@example.com" }\n  ]\n}'
  );
  /** Unlocks commissioner tools below the guided preseason wizard (sync, invites, advanced). */
  const [preseasonGates, setPreseasonGates] = useState({
    ownersDone: false,
    dataLoadDone: false,
    draftStarted: false
  });

  const sessionReady = Boolean(
    commissionerSecret.trim() ||
      (typeof process !== "undefined" &&
        process.env.NEXT_PUBLIC_ALLOW_COMMISSIONER_ROUTES_WITHOUT_AUTH === "true")
  );

  useEffect(() => {
    // If we navigated here without `?leagueId=...`, fall back to last active league.
    if (!leagueIdFromQuery && !leagueId.trim()) {
      const stored = readStoredActiveLeagueId();
      if (stored) setLeagueId(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueIdFromQuery, leagueId]);

  useEffect(() => {
    if (!leagueId.trim()) return;
    writeStoredActiveLeagueId(leagueId);
  }, [leagueId]);

  const onPreseasonGatesChange = useCallback(
    (g: { ownersDone: boolean; dataLoadDone: boolean; draftStarted: boolean }) => {
      setPreseasonGates(g);
    },
    []
  );

  const leagueKey = leagueId.trim();
  const seedsBusy = committeeScrapeBusy;
  const anyBusy = useMemo(
    () =>
      syncBusy ||
      tournamentSyncBusy ||
      boxscoreBackfillBusy ||
      recomputeBusy ||
      seedsBusy ||
      playersBusy ||
      populatePlayersBusy ||
      setupBusy ||
      draftResetBusy ||
      bulkAssignBusy ||
      draftTemplateBusy ||
      draftXlsxBusy ||
      ensureOwnersBusy ||
      inviteOwnersBusy,
    [
      syncBusy,
      tournamentSyncBusy,
      boxscoreBackfillBusy,
      recomputeBusy,
      seedsBusy,
      playersBusy,
      populatePlayersBusy,
      setupBusy,
      draftResetBusy,
      bulkAssignBusy,
      draftTemplateBusy,
      draftXlsxBusy,
      ensureOwnersBusy,
      inviteOwnersBusy
    ]
  );

  useEffect(() => {
    if (leagueIdFromQuery) setLeagueId(leagueIdFromQuery);
  }, [leagueIdFromQuery]);

  useEffect(() => {
    const syncFromSession = () => {
      if (leagueIdFromQuery) return;
      const s = readPlayerPoolSession();
      if (!s?.leagueId) return;
      setLeagueId(s.leagueId);
      const params = new URLSearchParams(queryString);
      if (!params.get("leagueId")?.trim()) {
        params.set("leagueId", s.leagueId);
        router.replace(`/commissioner?${params.toString()}`);
      }
    };
    syncFromSession();
    window.addEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, syncFromSession);
    return () => window.removeEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, syncFromSession);
  }, [leagueIdFromQuery, queryString, router]);

  const firstRoundStorageKey = leagueKey ? `player_pool_first_round_thu_${leagueKey}` : "";

  useEffect(() => {
    if (!firstRoundStorageKey) return;
    try {
      const s = sessionStorage.getItem(firstRoundStorageKey);
      if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) setFirstRoundThursday(s);
    } catch {
      /* ignore */
    }
  }, [firstRoundStorageKey]);

  useEffect(() => {
    const syncSecret = () => {
      try {
        setCommissionerSecret(sessionStorage.getItem("player_pool_commissioner_secret") ?? "");
      } catch {
        setCommissionerSecret("");
      }
    };
    syncSecret();
    window.addEventListener("focus", syncSecret);
    window.addEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, syncSecret);
    return () => {
      window.removeEventListener("focus", syncSecret);
      window.removeEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, syncSecret);
    };
  }, []);

  const commissionerHeaders = useCallback(
    (json = true): HeadersInit => {
      const h: Record<string, string> = {};
      if (json) h["content-type"] = "application/json";
      const s = commissionerSecret.trim();
      if (s) h["x-player-pool-commissioner-secret"] = s;
      return h;
    },
    [commissionerSecret]
  );

  useEffect(() => {
    if (!leagueKey || !sessionReady) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/commissioner/${encodeURIComponent(leagueKey)}/tournament-window`, {
          headers: commissionerHeaders(false)
        });
        const j = (await readJsonResponse(res)) as { firstRoundThursday?: string | null };
        if (cancelled || !res.ok) return;
        const d = j.firstRoundThursday;
        if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
          setFirstRoundThursday((prev) => (prev.trim() ? prev : d));
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [leagueKey, sessionReady, commissionerHeaders]);

  function persistFirstRoundThursday(value: string) {
    setFirstRoundThursday(value);
    if (!firstRoundStorageKey) return;
    try {
      const t = value.trim();
      if (t && /^\d{4}-\d{2}-\d{2}$/.test(t)) sessionStorage.setItem(firstRoundStorageKey, t);
      else sessionStorage.removeItem(firstRoundStorageKey);
    } catch {
      /* ignore */
    }
  }

  function persistCommissionerSecret(value: string) {
    setCommissionerSecret(value);
    writeCommissionerSecretToSession(value);
  }

  function requireLeagueKey(): string | null {
    if (!leagueKey) {
      setError("Enter a league id (UUID from Draft) or league code (e.g. 365).");
      return null;
    }
    return leagueKey;
  }

  async function syncNow() {
    const key = requireLeagueKey();
    if (!key) return;
    setSyncBusy(true);
    setError(null);
    setMessage(null);
    try {
      const body: Record<string, unknown> = { excludeFirstFour: true };
      if (syncDateISO.trim()) body.dateISO = syncDateISO.trim();
      const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/sync-now`, {
        method: "POST",
        headers: commissionerHeaders(true),
        body: JSON.stringify(body)
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Sync failed: ${res.status}`));
      const j = json as {
        sync?: {
          teamsUpserted?: number;
          bracketDebug?: {
            bracketAllCount: number;
            bracketPlayedCount: number;
            bracketExternalTeamIdsCount: number;
            bracketGamesUpserted: number;
            bracketTeamsUpserted: number;
          };
          bracketError?: string | null;
        };
      };
      const bd = j.sync?.bracketDebug;
      setMessage(
        `Synced games. Teams: ${j.sync?.teamsUpserted ?? "?"}` +
          (bd
            ? ` (Bracket: ${bd.bracketPlayedCount}/${bd.bracketAllCount} games, external teams ${bd.bracketExternalTeamIdsCount}, upserted teams ${bd.bracketTeamsUpserted}, games ${bd.bracketGamesUpserted})`
            : "") +
          (j.sync?.bracketError ? ` [Bracket error: ${j.sync.bracketError}]` : "")
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncBusy(false);
    }
  }

  async function syncTournamentWindow() {
    const key = requireLeagueKey();
    if (!key) return;
    const start = firstRoundThursday.trim();
    if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      setError(null);
      setMessage(null);
      setError("Set First Round Thursday (YYYY-MM-DD) first — the Thursday when the NCAA round of 64 starts.");
      return;
    }
    const today = utcTodayISO();
    const dates = utcDateISOsFromStart(start, TOURNAMENT_SYNC_MAX_CALENDAR_DAYS).filter((d) => d <= today);
    if (dates.length === 0) {
      setError(null);
      setMessage(null);
      setError("That Thursday is in the future (UTC). Check the date.");
      return;
    }

    setTournamentSyncBusy(true);
    setError(null);
    setMessage(null);
    try {
      let daysSynced = 0;
      let sawChampionshipComplete = false;
      for (let i = 0; i < dates.length; i++) {
        const dateISO = dates[i]!;
        const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/sync-now`, {
          method: "POST",
          headers: commissionerHeaders(true),
          body: JSON.stringify({ dateISO, excludeFirstFour: true })
        });
        const json = (await readJsonResponse(res)) as {
          error?: unknown;
          tournamentSync?: { championshipComplete?: boolean };
        };
        if (!res.ok) throw new Error(formatApiError(json, `Sync ${dateISO} failed: ${res.status}`));
        daysSynced += 1;
        if (json.tournamentSync?.championshipComplete) sawChampionshipComplete = true;
        setMessage(`Loading scores: ${dateISO} (${i + 1}/${dates.length})`);
        await new Promise((r) => setTimeout(r, 450));
      }

      setMessage(
        `Done — synced ${daysSynced} calendar day(s) through ${today}. Championship: ${
          sawChampionshipComplete ? "final is in DB" : "not final in DB yet"
        }. If player round columns are still empty, run the next button — Fill player box scores (all R1–R6 games in DB) — then Recompute projections. Daily sync often writes games but skips per-player lines when henrygd box scores fail or names do not match the player pool.`
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Tournament sync failed");
    } finally {
      setTournamentSyncBusy(false);
    }
  }

  async function syncPlayerBoxscoresFromDb() {
    const key = requireLeagueKey();
    if (!key) return;
    setBoxscoreBackfillBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/sync-player-boxscores`, {
        method: "POST",
        headers: commissionerHeaders(true)
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Box score backfill failed: ${res.status}`));
      const b = json as {
        backfill?: {
          gamesAttempted?: number;
          playerGameStatsRowsUpserted?: number;
          gamesWithPlayerStatsRows?: number;
          errors?: string[];
        };
      };
      const bf = b.backfill;
      const errTail =
        bf?.errors?.length ?
          ` First issues: ${bf.errors.slice(0, 3).join(" · ")}${bf.errors.length > 3 ? "…" : ""}`
        : "";
      setMessage(
        `Player box scores: ${bf?.gamesAttempted ?? 0} R1–R6 game row(s) in database, ${bf?.playerGameStatsRowsUpserted ?? 0} player_game_stats row(s) written (${bf?.gamesWithPlayerStatsRows ?? 0} games with stats).${errTail}`
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Backfill failed");
    } finally {
      setBoxscoreBackfillBusy(false);
    }
  }

  async function recompute() {
    const key = requireLeagueKey();
    if (!key) return;
    setRecomputeBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/commissioner/${encodeURIComponent(key)}/projections/recompute`,
        {
          method: "POST",
          headers: commissionerHeaders(true),
          body: JSON.stringify({ reason: "manual_recompute" })
        }
      );
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Recompute failed: ${res.status}`));
      const j = json as { currentRound?: number };
      setMessage(`Projections updated. Round: ${j.currentRound ?? "?"}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Recompute failed");
    } finally {
      setRecomputeBusy(false);
    }
  }

  async function ingestPlayers() {
    const key = requireLeagueKey();
    if (!key) return;
    setPlayersBusy(true);
    setError(null);
    setMessage(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(playersJson);
      } catch {
        throw new Error("Invalid JSON in players box");
      }

      const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/players/ingest`, {
        method: "POST",
        headers: commissionerHeaders(true),
        body: JSON.stringify(parsed)
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Players ingest failed: ${res.status}`));
      const j = json as {
        updatedExternal?: number;
        updatedNoExternal?: number;
        missingTeamCount?: number;
      };
      setMessage(
        `Players ingest complete. Updated: ${j.updatedExternal ?? 0} external, ${j.updatedNoExternal ?? 0} without external. Missing teams: ${j.missingTeamCount ?? 0}.`
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Players ingest failed");
    } finally {
      setPlayersBusy(false);
    }
  }

  async function populateTournamentPlayers() {
    const key = requireLeagueKey();
    if (!key) return;
    setPopulatePlayersBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/players/populate-cbb`, {
        method: "POST",
        headers: commissionerHeaders(true),
        // IMPORTANT: this repopulation must be non-destructive so it can't wipe the current draft.
        // We only upsert missing players (and avoid updating existing ones in the importer).
        body: JSON.stringify({ replace: false, source: "espn_athlete_season_stats" })
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Populate failed: ${res.status}`));
      const j = json as {
        teamsSuccess?: number;
        teamsFailed?: number;
        playersUpserted?: number;
        seasonPpgPopulated?: number;
        rosterFailures?: number;
        statsFailures?: number;
        seasonYear?: number;
        warning?: string;
        debug?: {
          stMarys?: {
            teamLabel: string;
            externalTeamId: string;
            seo: string | null;
            espnTeamId: number | null;
            espnTeamSlug: string | null;
          };
          pauliusMurauskas?: {
            seasonPpg: number | null;
            existingSeasonPpg: number | null;
            existingHadValidPpg: boolean;
            hasExistingExternal: boolean;
            uniqueKeyExists: boolean;
          };
        };
      };
      const base = `Populate complete (ESPN, season ${j.seasonYear ?? "?"}). Teams ok: ${j.teamsSuccess ?? "?"}, failed: ${
        j.teamsFailed ?? "?"
      }. Players upserted: ${j.playersUpserted ?? "?"} (PPG populated: ${j.seasonPpgPopulated ?? "?"}). Roster failures: ${
        j.rosterFailures ?? "?"
      }. Stats failures: ${j.statsFailures ?? "?"}.`;
      const pm = j.debug?.pauliusMurauskas;
      const pmText = pm
        ? ` Paulius Murauskas season_ppg: ${
            pm.seasonPpg != null ? pm.seasonPpg.toFixed(2) : "null"
          } (existingHadValidPpg=${pm.existingHadValidPpg ? "true" : "false"}, hasExistingExternal=${
            pm.hasExistingExternal ? "true" : "false"
          }, uniqueKeyExists=${pm.uniqueKeyExists ? "true" : "false"})`
        : "";
      const sm = j.debug?.stMarys;
      const smText = sm
        ? ` St. Mary's mapping: teamLabel="${sm.teamLabel}", seo="${sm.seo ?? "null"}", espnTeamId=${
            sm.espnTeamId ?? "null"
          }, espnSlug="${sm.espnTeamSlug ?? "null"}".`
        : "";
      const msg = j.warning ? `${base} Warning: ${j.warning}${pmText}${smText}` : `${base}${pmText}${smText}`;
      setMessage(msg);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Populate players failed");
    } finally {
      setPopulatePlayersBusy(false);
    }
  }

  async function runFullTournamentSetup() {
    const key = requireLeagueKey();
    if (!key) return;
    setSetupBusy(true);
    setError(null);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        populatePlayers: setupPopulate,
        replacePlayers: true
      };
      if (syncDateISO.trim()) body.dateISO = syncDateISO.trim();
      const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/tournament-setup`, {
        method: "POST",
        headers: commissionerHeaders(true),
        body: JSON.stringify(body)
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Setup failed: ${res.status}`));
      const j = json as {
        sync?: { teamsUpserted?: number };
        seeds?: { updated?: number; unmatchedCount?: number };
        populate?: { playersUpserted?: number; seasonYear?: number; warning?: string };
        populateSkippedReason?: string;
      };
      const parts = [
        `Sync teams: ${j.sync?.teamsUpserted ?? "?"}`,
        `Seeds: ${j.seeds?.updated ?? "?"} updated, ${j.seeds?.unmatchedCount ?? "?"} unmatched`
      ];
      if (j.populateSkippedReason) parts.push(`Populate skipped: ${j.populateSkippedReason}`);
      else if (j.populate) {
        parts.push(
          `Players upserted: ${j.populate.playersUpserted ?? "?"} (season ${j.populate.seasonYear ?? "?"})`
        );
        if (j.populate.warning) parts.push(`Populate warning: ${j.populate.warning}`);
      }
      setMessage(`Step 1 complete — ${parts.join(". ")}.`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Setup failed");
    } finally {
      setSetupBusy(false);
    }
  }

  async function resetLeagueDraft() {
    const key = requireLeagueKey();
    if (!key) return;
    setDraftResetBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/draft/reset`, {
        method: "POST",
        headers: commissionerHeaders(true),
        body: JSON.stringify({})
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Draft reset failed: ${res.status}`));
      setMessage("Draft reset: picks cleared, back to pick 1.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Draft reset failed");
    } finally {
      setDraftResetBusy(false);
    }
  }

  async function bulkAssignDraft() {
    const key = requireLeagueKey();
    if (!key) return;
    setBulkAssignBusy(true);
    setError(null);
    setMessage(null);
    try {
      let parsed: { assignments?: Record<string, number[]> };
      try {
        parsed = JSON.parse(bulkAssignJson) as typeof parsed;
      } catch {
        throw new Error("Invalid JSON in bulk assign box");
      }
      if (!parsed.assignments || typeof parsed.assignments !== "object") {
        throw new Error('JSON must look like { "assignments": { "uuid": [playerId, ...] } }');
      }
      const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/draft/bulk-assign`, {
        method: "POST",
        headers: commissionerHeaders(true),
        body: JSON.stringify({ assignments: parsed.assignments })
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Bulk assign failed: ${res.status}`));
      const j = json as { picksInserted?: number };
      setMessage(`Bulk assign OK — ${j.picksInserted ?? "?"} picks written, draft marked complete.`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Bulk assign failed");
    } finally {
      setBulkAssignBusy(false);
    }
  }

  async function downloadDraftBulkAssignTemplate() {
    const key = requireLeagueKey();
    if (!key) return;
    setDraftTemplateBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/commissioner/${encodeURIComponent(key)}/draft/bulk-assign-template`,
        { headers: commissionerHeaders(false) }
      );
      if (!res.ok) {
        const text = await res.text();
        let msg = text || `Template download failed: ${res.status}`;
        try {
          const j = JSON.parse(text) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          /* plain text / HTML */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition");
      let filename = "draft-bulk-assign-template.xlsx";
      const m = cd?.match(/filename="([^"]+)"/i) ?? cd?.match(/filename=([^;]+)/i);
      if (m?.[1]) filename = m[1].trim();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setMessage(`Downloaded ${filename}. Fill yellow cells, then upload below or paste JSON.`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Template download failed");
    } finally {
      setDraftTemplateBusy(false);
    }
  }

  async function applyDraftFromExcelFile(file: File) {
    const key = requireLeagueKey();
    if (!key) return;
    setDraftXlsxBusy(true);
    setError(null);
    setMessage(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const headers: Record<string, string> = {};
      const s = commissionerSecret.trim();
      if (s) headers["x-player-pool-commissioner-secret"] = s;
      const res = await fetch(
        `/api/commissioner/${encodeURIComponent(key)}/draft/bulk-assign-from-xlsx`,
        { method: "POST", headers, body: fd }
      );
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Excel bulk assign failed: ${res.status}`));
      const j = json as { picksInserted?: number };
      setMessage(`Bulk assign from Excel OK — ${j.picksInserted ?? "?"} picks written, draft marked complete.`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Excel bulk assign failed");
    } finally {
      setDraftXlsxBusy(false);
    }
  }

  async function ensureOwners() {
    const key = requireLeagueKey();
    if (!key) return;
    setEnsureOwnersBusy(true);
    setError(null);
    setMessage(null);
    try {
      const ownerDisplayNames = ownerNamesCsv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!ownerDisplayNames.length) throw new Error("Enter at least one owner name (comma-separated).");
      const body: { ownerDisplayNames: string[]; passcode?: string } = { ownerDisplayNames };
      const pc = ensureOwnersPasscode.trim();
      if (pc) body.passcode = pc;
      const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/owners/ensure`, {
        method: "POST",
        headers: commissionerHeaders(true),
        body: JSON.stringify(body)
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Ensure owners failed: ${res.status}`));
      const j = json as { createdOrUpdated?: number; hint?: string };
      setMessage(
        `Owners ensured: ${j.createdOrUpdated ?? "?"} rows. ${j.hint ?? ""} Use Draft tab → leagueTeams in API response for UUIDs.`
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ensure owners failed");
    } finally {
      setEnsureOwnersBusy(false);
    }
  }

  async function inviteOwnersByEmail() {
    const key = requireLeagueKey();
    if (!key) return;
    setInviteOwnersBusy(true);
    setError(null);
    setMessage(null);
    try {
      let parsed: { owners?: unknown };
      try {
        parsed = JSON.parse(ownerInvitesJson) as typeof parsed;
      } catch {
        throw new Error("Invalid JSON in owner invites box.");
      }
      if (!parsed.owners || !Array.isArray(parsed.owners)) {
        throw new Error('JSON must look like { "owners": [ { "fullName", "username", "email" }, ... ] }');
      }
      const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/owners/invite`, {
        method: "POST",
        headers: commissionerHeaders(true),
        body: JSON.stringify({ owners: parsed.owners })
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Invite owners failed: ${res.status}`));
      const j = json as {
        leagueCode?: string;
        joinUrl?: string;
        results?: Array<{ email: string; username: string; status: string; detail?: string }>;
      };
      const lines = (j.results ?? []).map(
        (r) => `${r.status}: ${r.email} (${r.username})${r.detail ? ` — ${r.detail}` : ""}`
      );
      const summary =
        lines.length > 0
          ? [`Owner invites (${lines.length}):`, ...lines, `League code: ${j.leagueCode ?? "?"}`, `Join URL: ${j.joinUrl ?? "/join"}`].join(
              "\n"
            )
          : "Owner invites: no rows returned.";
      setMessage(summary.slice(0, 8000));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Invite owners failed");
    } finally {
      setInviteOwnersBusy(false);
    }
  }

  async function applySeedsFromCommitteeArticle() {
    const key = requireLeagueKey();
    if (!key) return;
    const u = committeeReportUrl.trim();
    if (!u) {
      setError(null);
      setMessage(null);
      setError("Paste a CBS Sports or Sports Illustrated article URL (https://…cbssports.com or …si.com).");
      return;
    }
    setCommitteeScrapeBusy(true);
    setError(null);
    setMessage(null);
    try {
      const body: Record<string, unknown> = { scrapeCommitteeReportUrl: u };
      const res = await fetch(`/api/commissioner/${encodeURIComponent(key)}/official-seeds`, {
        method: "POST",
        headers: commissionerHeaders(true),
        body: JSON.stringify(body)
      });
      const json = await readJsonResponse(res);
      if (!res.ok) throw new Error(formatApiError(json, `Committee scrape failed: ${res.status}`));
      const j = json as {
        updated?: number;
        unmatchedCount?: number;
        scrapeWarnings?: string[];
      };
      const warn =
        j.scrapeWarnings?.length && j.scrapeWarnings.join(" ")
          ? ` Warnings: ${j.scrapeWarnings.join(" ")}`
          : "";
      setMessage(
        `Committee article seeds: updated ${j.updated ?? 0}, unmatched ${j.unmatchedCount ?? 0}.${warn}`
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Committee scrape failed");
    } finally {
      setCommitteeScrapeBusy(false);
    }
  }

  return (
    <div className="pool-page-stack pb-24 md:pb-6">
      <div className="pool-hero">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="pool-text-title">Commissioner</div>
            <div className="pool-text-muted mt-1">Commissioner tools status and setup controls</div>
            <div className="mt-1.5 pt-2 border-t border-border/25 pool-text-muted">
              Guided setup, owner/team management, draft controls, score sync, and player-data administration.
            </div>
          </div>
          {leagueIdFromQuery && (
            <div className="pool-text-faint text-right">
              <Link
                href={`/leaderboard?leagueId=${encodeURIComponent(leagueIdFromQuery)}`}
                className="pool-link"
              >
                Leaderboard
              </Link>
            </div>
          )}
        </div>
      </div>

      <div className="pool-panel space-y-3">
        <div className="pool-subpanel space-y-3 rounded-xl border border-accent/25 bg-accent/[0.06] p-4">
          <div className="pool-text-title">Commissioner password</div>
          <p className="pool-text-muted-sm text-sm">
            Must match server env <code className="pool-code">COMMISSIONER_API_SECRET</code>. You can also set it from{" "}
            <strong>Act as commissioner</strong> in the site header — it stays in this browser session only.
          </p>
          <label className="flex flex-col gap-1">
            <span className="pool-label">Password</span>
            <input
              className="pool-field font-mono text-[12px]"
              type="password"
              autoComplete="off"
              value={commissionerSecret}
              onChange={(e) => persistCommissionerSecret(e.target.value)}
              placeholder="Commissioner password"
            />
          </label>
        </div>

        <PreseasonSetupFlow
          leagueId={leagueId}
          setLeagueId={setLeagueId}
          commissionerHeaders={commissionerHeaders}
          sessionReady={sessionReady}
          onGatesChange={onPreseasonGatesChange}
        />

        {!sessionReady && (
          <p className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-sm text-foreground/70">
            Enter the commissioner password above (or set <code className="pool-code">NEXT_PUBLIC_ALLOW_COMMISSIONER_ROUTES_WITHOUT_AUTH=true</code> for local UI unlock with matching server flag).
          </p>
        )}

        {sessionReady && !leagueKey && (
          <p className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-sm text-foreground/70">
            Enter your <strong>league id</strong> or <strong>code</strong> in the checklist above.
          </p>
        )}

        {!preseasonGates.ownersDone && sessionReady && leagueKey && (
          <p className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-sm text-foreground/70">
            New league? Finish <strong>owners &amp; teams</strong> in the steps above. Already running a pool?
            You can still use <strong>Easy commissioner actions</strong> below anytime.
          </p>
        )}

        {sessionReady && leagueKey && (
          <div
            id="commissioner-easy-actions"
            className="pool-subpanel space-y-4 border border-accent/35 rounded-xl p-4 scroll-mt-4 bg-accent/5"
          >
            <div>
              <div className="pool-text-title">Easy commissioner actions</div>
              <p className="pool-text-muted-sm mt-1">
                Uses the league id from the checklist. Runs on the server with your commissioner password. First Four games are
                never scored — only the round of 64 through the championship.
              </p>
            </div>

            <label className="flex flex-col gap-1 max-w-md">
              <span className="pool-label">Game date (optional, UTC)</span>
              <input
                className="pool-field"
                value={syncDateISO}
                onChange={(e) => setSyncDateISO(e.target.value)}
                placeholder="YYYY-MM-DD — blank = today; used for setup and single-day sync"
              />
            </label>

            <div className="space-y-2 rounded-lg border border-border/50 bg-background/40 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-foreground/55">1 · Bracket, seeds &amp; optional rosters</div>
              <p className="pool-text-muted-sm text-sm">
                Loads official 1–68 seeds from the published{" "}
                <a className="pool-link" href="https://github.com/henrygd/ncaa-api" target="_blank" rel="noreferrer">
                  NCAA bracket JSON
                </a>
                , syncs scores for the date above (or today), optionally imports all players from ESPN, then
                recomputes projections. For CBS/SI 1–68 order use <strong>Advanced</strong> below.
              </p>
              <label className="flex items-center gap-2 pool-text-muted-sm">
                <input
                  type="checkbox"
                  checked={setupPopulate}
                  onChange={(e) => setSetupPopulate(e.target.checked)}
                />
                Also import / refresh all players from ESPN (several minutes)
              </label>
              <Button onClick={runFullTournamentSetup} disabled={!leagueKey || anyBusy} size="md" className="w-full sm:w-auto">
                {setupBusy ? "Running…" : "Run full tournament setup"}
              </Button>
            </div>

            <div className="space-y-2 rounded-lg border border-border/50 bg-background/40 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-foreground/55">2 · Fill R1–R6 box scores (every game day)</div>
              <p className="pool-text-muted-sm text-sm">
                After step 1, run this once (or again after more days have been played). We sync each calendar day
                from the <strong>First Round Thursday</strong> through today so early rounds are not missed. That
                updates team scores and <em>tries</em> per-player rows in{" "}
                <code className="pool-code">player_game_stats</code>. That step is fragile (network, rate limits, name
                match vs your ESPN pool). <strong>Always run Fill player box scores below after this</strong> if Stat
                Tracker / Players tab round points are missing — then <strong>Recompute projections</strong>.
              </p>
              <label className="flex flex-col gap-1">
                <span className="pool-label">First Round Thursday (YYYY-MM-DD)</span>
                <input
                  className="pool-field"
                  value={firstRoundThursday}
                  onChange={(e) => persistFirstRoundThursday(e.target.value)}
                  placeholder="e.g. 2026-03-19"
                  inputMode="numeric"
                />
              </label>
              <p className="pool-text-faint text-[11px]">
                Auto-fills when we know your season; you can edit. Saved for this league on this device.
              </p>
              <Button
                onClick={() => void syncTournamentWindow()}
                disabled={!leagueKey || syncBusy || tournamentSyncBusy || boxscoreBackfillBusy || anyBusy}
                size="md"
                variant="outline"
                className="w-full sm:w-auto"
              >
                {tournamentSyncBusy ? "Loading every tournament day…" : "Load every tournament day through today"}
              </Button>
              <Button
                onClick={() => void syncPlayerBoxscoresFromDb()}
                disabled={!leagueKey || syncBusy || tournamentSyncBusy || boxscoreBackfillBusy || anyBusy}
                size="md"
                variant="outline"
                className="w-full sm:w-auto"
              >
                {boxscoreBackfillBusy ? "Filling player box scores…" : "Fill player box scores (all R1–R6 games in DB)"}
              </Button>
            </div>

            <div className="space-y-2 rounded-lg border border-border/50 bg-background/40 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-foreground/55">3 · One day at a time</div>
              <p className="pool-text-muted-sm text-sm">Uses the game date at the top (or today if empty).</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Button onClick={syncNow} disabled={!leagueKey || syncBusy || tournamentSyncBusy} size="md">
                  {syncBusy ? "Syncing…" : "Sync this day only"}
                </Button>
                <Button onClick={recompute} disabled={!leagueKey || recomputeBusy} size="md" variant="outline">
                  {recomputeBusy ? "…" : "Recompute projections"}
                </Button>
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-border/50 bg-background/40 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-foreground/55">4 · Players only (ESPN)</div>
              <p className="pool-text-muted-sm text-sm">
                Refreshes rosters and season PPG for all seeded teams without re-running full setup.
              </p>
              <Button
                onClick={populateTournamentPlayers}
                disabled={!leagueKey || populatePlayersBusy || anyBusy}
                size="md"
                variant="outline"
              >
                {populatePlayersBusy ? "Importing players…" : "Import / refresh players (ESPN)"}
              </Button>
            </div>
          </div>
        )}

        {preseasonGates.dataLoadDone && (
            <div className="pool-subpanel space-y-3 border border-border/60 rounded-xl p-3">
              <div className="pool-text-title">League owners &amp; draft (commissioner)</div>
          <p className="pool-text-muted-sm">
            Creates demo auth users + <code className="pool-code">league_teams</code> in draft order (same
            pattern as Draft Initialize). Get team UUIDs from the Draft tab API (
            <code className="pool-code">leagueTeams</code> in{" "}
            <code className="pool-code">GET /api/draft/…/state</code>) for bulk assign.
          </p>
          <label className="flex flex-col gap-1">
            <span className="pool-label">Owner display names (comma-separated, draft order)</span>
            <input
              className="pool-field"
              value={ownerNamesCsv}
              onChange={(e) => setOwnerNamesCsv(e.target.value)}
              placeholder="Owner1, Owner2, Owner3…"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="pool-label">
              Passcode for new demo users (optional — leave blank for default <code className="pool-code">demo1234</code>
              , or 3+ characters e.g. <code className="pool-code">365</code>)
            </span>
            <input
              className="pool-field"
              type="password"
              autoComplete="off"
              value={ensureOwnersPasscode}
              onChange={(e) => setEnsureOwnersPasscode(e.target.value)}
              placeholder="Default from server if blank"
            />
          </label>
          <Button onClick={ensureOwners} disabled={!leagueKey || ensureOwnersBusy} size="md" variant="outline">
            {ensureOwnersBusy ? "Ensuring…" : "Ensure owners / teams"}
          </Button>

          <div className="border-t border-border/40 pt-3 space-y-2">
            <p className="pool-text-muted-sm">
              <strong>Invite real owners</strong> — one row per person (draft order = array order). Supabase sends
              each a magic link to <code className="pool-code">/join</code> with league metadata; they set a{" "}
              <strong>6-digit PIN</strong> as their password. Add <code className="pool-code">/join</code> to
              Supabase redirect URLs. Set <code className="pool-code">NEXT_PUBLIC_SITE_URL</code> in production so
              the email link points at your domain. Customize the invite template in Supabase (e.g. mention{" "}
              <code className="pool-code">{"{{ .Data.league_code }}"}</code>).
            </p>
            <textarea
              className="pool-textarea min-h-[160px] font-mono text-[11px]"
              value={ownerInvitesJson}
              onChange={(e) => setOwnerInvitesJson(e.target.value)}
              spellCheck={false}
            />
            <Button
              onClick={inviteOwnersByEmail}
              disabled={!leagueKey || inviteOwnersBusy}
              size="md"
              variant="outline"
            >
              {inviteOwnersBusy ? "Sending…" : "Send owner invites (email)"}
            </Button>
          </div>

          <div className="border-t border-border/40 pt-3">
            <p className="pool-text-muted-sm mb-2">
              <strong>Reset draft</strong> — delete all picks and roster slots; pick 1 again.
            </p>
            <Button onClick={resetLeagueDraft} disabled={!leagueKey || draftResetBusy} size="md" variant="outline">
              {draftResetBusy ? "Resetting…" : "Reset draft"}
            </Button>
          </div>

          <div className="border-t border-border/40 pt-3 space-y-2">
            <p className="pool-text-muted-sm">
              <strong>Bulk assign rosters</strong> — each team UUID maps to exactly{" "}
              <code className="pool-code">total_rounds</code> player ids per owner (round 1 = first pick for that
              owner, etc.). Snake order is applied server-side from the draft room.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={downloadDraftBulkAssignTemplate}
                disabled={!leagueKey || anyBusy}
                size="md"
                variant="outline"
              >
                {draftTemplateBusy ? "Building…" : "Download Excel template (.xlsx)"}
              </Button>
              <input
                ref={draftExcelInputRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void applyDraftFromExcelFile(f);
                }}
              />
              <Button
                type="button"
                onClick={() => draftExcelInputRef.current?.click()}
                disabled={!leagueKey || anyBusy}
                size="md"
                variant="outline"
              >
                {draftXlsxBusy ? "Uploading…" : "Assign rosters from Excel…"}
              </Button>
            </div>
            <p className="pool-text-muted-sm text-[11px]">
              Template includes <strong>Rosters</strong> (fill yellow <code className="pool-code">round_N_player_id</code>{" "}
              columns), <strong>Player_pool</strong> (id reference), and <strong>Instructions</strong>. Do not change{" "}
              <code className="pool-code">league_team_id</code> values.
            </p>
            <textarea
              className="pool-textarea min-h-[140px] font-mono text-[11px]"
              value={bulkAssignJson}
              onChange={(e) => setBulkAssignJson(e.target.value)}
              spellCheck={false}
            />
            <Button onClick={bulkAssignDraft} disabled={!leagueKey || bulkAssignBusy} size="md">
              {bulkAssignBusy ? "Assigning…" : "Bulk assign rosters (JSON)"}
            </Button>
          </div>
            </div>
        )}

        {preseasonGates.dataLoadDone && !sessionReady && (
          <p className="rounded-lg border border-border/40 bg-muted/10 px-3 py-2 text-sm text-foreground/65">
            Sign in to use <strong>Advanced</strong> (CBS/SI seeds, JSON ingest) after you mark step 3 complete.
          </p>
        )}

        {sessionReady && leagueKey && preseasonGates.dataLoadDone && (
        <details className="pool-subpanel space-y-3 rounded-xl border border-border/60 p-3">
          <summary className="pool-text-title cursor-pointer select-none">
            Advanced — committee scrape &amp; JSON ingest
          </summary>
          <p className="pool-text-muted-sm pt-2">
            Bracket sync, all tournament days, and ESPN player import live in <strong>Easy commissioner actions</strong>{" "}
            above.
          </p>

        <div className="pool-subpanel space-y-2">
          <div className="pool-text-title">Official committee 1–68 (CBS / SI scrape)</div>
          <p className="pool-text-body">
            The only way to load committee rankings from a news article is this button: paste the{" "}
            <strong>https</strong> URL of a CBS Sports or Sports Illustrated story that lists the full 1–68
            order. The server fetches and parses that page once (rate-limited per minute). Teams match by
            display name to your pool; check the response for unmatched rows.
          </p>
          <label className="flex flex-col gap-1">
            <span className="pool-label">Article URL</span>
            <input
              className="pool-field font-mono text-[11px]"
              type="url"
              value={committeeReportUrl}
              onChange={(e) => setCommitteeReportUrl(e.target.value)}
              placeholder="https://www.cbssports.com/college-basketball/news/…"
              spellCheck={false}
            />
          </label>
          <Button
            onClick={applySeedsFromCommitteeArticle}
            disabled={!leagueKey || anyBusy}
            size="md"
            variant="outline"
          >
            {committeeScrapeBusy ? "Fetching article…" : "Apply seeds from CBS/SI article"}
          </Button>
        </div>

        <div className="pool-subpanel space-y-2">
          <div className="pool-text-title">Ingest tournament players</div>
          <p className="pool-text-body">
            Provide `players` with `name`, `teamSeo` (henrygd slug) or `teamExternalTeamId`, and
            `seasonPpg` (season average, used for Projection). This is intentionally rights-safe:
            you paste/upload the data you’re allowed to use.
          </p>
          <textarea
            className="pool-textarea min-h-[160px]"
            value={playersJson}
            onChange={(e) => setPlayersJson(e.target.value)}
            spellCheck={false}
          />
          <Button onClick={ingestPlayers} disabled={!leagueKey || anyBusy} size="md" variant="outline">
            {playersBusy ? "Ingesting…" : "Ingest players (JSON)"}
          </Button>
        </div>
        </details>
        )}

        {message && <div className="pool-text-body">{message}</div>}
        {error && <div className="pool-alert-danger">{error}</div>}
      </div>
    </div>
  );
}
