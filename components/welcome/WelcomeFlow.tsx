"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { clearStoredActiveLeagueId, writeStoredActiveLeagueId } from "@/lib/player-pool-storage";
import {
  clearPlayerPoolSession,
  PLAYER_POOL_IDENTITY_CHANGE_EVENT,
  readPlayerPoolSession,
  type PlayerPoolSession,
  writePlayerPoolSession
} from "@/lib/player-pool-session";

type TeamRow = { id: string; teamName: string };

export function WelcomeFlow() {
  const router = useRouter();
  const sp = useSearchParams();
  const prefillLeague = useMemo(() => sp.get("league")?.trim() ?? sp.get("code")?.trim() ?? "", [sp]);

  const [step, setStep] = useState<1 | 2>(1);
  const [leagueField, setLeagueField] = useState("");
  const [resolvedLeagueId, setResolvedLeagueId] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [teamId, setTeamId] = useState("");
  const [resolvedSeasonYear, setResolvedSeasonYear] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const existing = readPlayerPoolSession();

  useEffect(() => {
    if (prefillLeague) setLeagueField((prev) => prev || prefillLeague);
  }, [prefillLeague]);

  const loadTeams = useCallback(async () => {
    const key = leagueField.trim();
    if (!key) {
      setErr("Enter your league UUID or short code (from the commissioner).");
      return;
    }
    setBusy(true);
    setErr(null);
    setTeams([]);
    setResolvedLeagueId(null);
    setResolvedSeasonYear(null);
    try {
      const res = await fetch(`/api/leagues/${encodeURIComponent(key)}/teams`);
      const j = (await res.json()) as {
        leagueId?: string;
        teams?: TeamRow[];
        seasonYear?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      const lid = j.leagueId;
      const list = j.teams ?? [];
      if (!lid) throw new Error("Invalid response");
      setResolvedLeagueId(lid);
      setResolvedSeasonYear(
        typeof j.seasonYear === "number" && Number.isFinite(j.seasonYear) ? j.seasonYear : null
      );
      setTeams(list);
      if (list.length === 0) setErr("This league has no teams yet. Ask your commissioner to add owners.");
      else {
        setTeamId(list[0]!.id);
        setStep(2);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not load league");
    } finally {
      setBusy(false);
    }
  }, [leagueField]);

  const finish = useCallback(() => {
    const lid = resolvedLeagueId ?? leagueField.trim();
    if (!lid || !teamId || teams.length === 0) {
      setErr("Select which owner you are.");
      return;
    }
    const row = teams.find((t) => t.id === teamId);
    writePlayerPoolSession({
      leagueId: lid,
      leagueTeamId: teamId,
      teamName: row?.teamName ?? "Owner",
      ...(resolvedSeasonYear != null ? { seasonYear: resolvedSeasonYear } : {})
    });
    writeStoredActiveLeagueId(lid);
    window.dispatchEvent(new Event(PLAYER_POOL_IDENTITY_CHANGE_EVENT));
    router.replace(`/draft?leagueId=${encodeURIComponent(lid)}`);
  }, [resolvedLeagueId, leagueField, teamId, teams, router, resolvedSeasonYear]);

  const switchPool = useCallback(() => {
    clearPlayerPoolSession();
    clearStoredActiveLeagueId();
    setStep(1);
    setLeagueField("");
    setResolvedLeagueId(null);
    setTeams([]);
    setTeamId("");
    setErr(null);
  }, []);

  if (existing) {
    return (
      <div className="pool-page-stack max-w-lg mx-auto">
        <div className="pool-hero">
          <div className="pool-text-title">Welcome back</div>
          <p className="pool-text-muted mt-2">
            You are <span className="font-semibold text-foreground">{existing.teamName}</span> in this browser
            session.
          </p>
          <p className="pool-text-faint text-[11px] mt-1 font-mono truncate" title={existing.leagueId}>
            League: {existing.leagueId.slice(0, 8)}…
          </p>
        </div>
        <div className="pool-panel flex flex-col gap-3">
          <Button
            type="button"
            className="w-full"
            onClick={() =>
              router.push(`/draft?leagueId=${encodeURIComponent(existing.leagueId)}`)
            }
          >
            Continue to Draft
          </Button>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/leaderboard?leagueId=${encodeURIComponent(existing.leagueId)}`}
              className="pool-btn-outline-cta text-xs flex-1 text-center"
            >
              Leaderboard
            </Link>
            <Link
              href={`/stat-tracker?leagueId=${encodeURIComponent(existing.leagueId)}`}
              className="pool-btn-outline-cta text-xs flex-1 text-center"
            >
              StatTracker
            </Link>
            <Link
              href={`/players?leagueId=${encodeURIComponent(existing.leagueId)}`}
              className="pool-btn-outline-cta text-xs flex-1 text-center"
            >
              Players
            </Link>
          </div>
          <button type="button" className="pool-link text-xs text-left w-fit" onClick={switchPool}>
            Switch league or owner…
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pool-page-stack max-w-lg mx-auto">
      <div className="pool-hero">
        <div className="pool-text-title">March Madness Draft</div>
        <p className="pool-text-muted mt-2">
          Enter your pool once per browser session. You will not be asked again until you close this tab or clear
          session storage.
        </p>
      </div>

      <div className="pool-panel space-y-4">
        {step === 1 && (
          <>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">Step 1 of 2</div>
            <label className="flex flex-col gap-1">
              <span className="pool-label text-[12px]">League ID or code</span>
              <input
                className="pool-field font-mono text-[13px]"
                value={leagueField}
                onChange={(e) => setLeagueField(e.target.value)}
                placeholder="UUID or short code (e.g. 365)"
                autoComplete="off"
                autoFocus
              />
            </label>
            <Button type="button" disabled={busy} onClick={() => void loadTeams()}>
              {busy ? "Loading…" : "Next"}
            </Button>
          </>
        )}

        {step === 2 && (
          <>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">Step 2 of 2</div>
            <p className="text-sm pool-text-muted">
              Which team / owner are you? This controls whose picks and view you see in the draft.
            </p>
            <label className="flex flex-col gap-1">
              <span className="pool-label text-[12px]">I am…</span>
              <select
                className="pool-field text-[13px]"
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                disabled={teams.length === 0}
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.teamName}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button type="button" onClick={finish}>
                Enter pool
              </Button>
            </div>
          </>
        )}

        {err && <p className="text-[12px] text-amber-600 dark:text-amber-400/95">{err}</p>}

        <p className="text-[11px] pool-text-faint pt-2 border-t border-border/30">
          Commissioners: after you <strong>Enter pool</strong>, open <strong>Commissioner Tools</strong> from the sidebar
          and set the commissioner password there. This wizard is for owners picking their team in the pool.
        </p>
      </div>
    </div>
  );
}
