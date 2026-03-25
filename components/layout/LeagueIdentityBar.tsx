"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Briefcase, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BossModeOverlay } from "@/components/layout/BossModeOverlay";
import { AppearancePicker } from "@/components/theme/AppearancePicker";
import { clearStoredActiveLeagueId } from "@/lib/player-pool-storage";
import {
  clearPlayerPoolSession,
  readCommissionerSecretFromSession,
  readPlayerPoolSession,
  type PlayerPoolSession,
  writeCommissionerSecretToSession,
  PLAYER_POOL_IDENTITY_CHANGE_EVENT
} from "@/lib/player-pool-session";

/** “One Shining Moment 30” on Bandcamp — track 1 is the original. */
const ONE_SHINING_MOMENT_BANDCAMP_EMBED =
  "https://bandcamp.com/EmbeddedPlayer/album=4167384688/size=small/bgcol=1b212c/linkcol=facc15/tracklist=false/artwork=small/track=1/transparent=true/";

const ONE_SHINING_MOMENT_BANDCAMP_TRACK_URL =
  "https://davidbarrett.bandcamp.com/track/one-shining-moment-original";

export function LeagueIdentityBar() {
  const router = useRouter();
  const pathname = usePathname();

  const [session, setSession] = useState<PlayerPoolSession | null>(null);
  const [resolvedLeagueName, setResolvedLeagueName] = useState<string | null>(null);
  const [leagueMetaLoading, setLeagueMetaLoading] = useState(false);
  const [commPw, setCommPw] = useState("");
  const [commOpen, setCommOpen] = useState(false);
  const [commUnlocked, setCommUnlocked] = useState(false);
  const [bossOpen, setBossOpen] = useState(false);
  const [oneShiningOpen, setOneShiningOpen] = useState(false);

  const refreshCommissioner = useCallback(() => {
    setCommUnlocked(readCommissionerSecretFromSession().length > 0);
    setCommPw("");
  }, []);

  const syncSession = useCallback(() => {
    setSession(readPlayerPoolSession());
  }, []);

  useEffect(() => {
    syncSession();
    refreshCommissioner();
    const onIdent = () => {
      syncSession();
      refreshCommissioner();
    };
    window.addEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, onIdent);
    window.addEventListener("focus", onIdent);
    return () => {
      window.removeEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, onIdent);
      window.removeEventListener("focus", onIdent);
    };
  }, [syncSession, refreshCommissioner]);

  useEffect(() => {
    if (!oneShiningOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOneShiningOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [oneShiningOpen]);

  useEffect(() => {
    if (!session?.leagueId) {
      setResolvedLeagueName(null);
      setLeagueMetaLoading(false);
      return;
    }
    let cancelled = false;
    setLeagueMetaLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/leagues/${encodeURIComponent(session.leagueId)}/teams`);
        const j = (await res.json()) as { leagueName?: string; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setResolvedLeagueName(null);
          return;
        }
        const n = typeof j.leagueName === "string" ? j.leagueName.trim() : "";
        setResolvedLeagueName(n || null);
      } catch {
        if (!cancelled) setResolvedLeagueName(null);
      } finally {
        if (!cancelled) setLeagueMetaLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.leagueId]);

  const switchPool = useCallback(() => {
    clearPlayerPoolSession();
    clearStoredActiveLeagueId();
    setSession(null);
    router.push("/");
  }, [router]);

  const saveCommissionerPassword = useCallback(() => {
    writeCommissionerSecretToSession(commPw);
    refreshCommissioner();
    setCommOpen(false);
  }, [commPw, refreshCommissioner]);

  const clearCommissionerPassword = useCallback(() => {
    writeCommissionerSecretToSession("");
    refreshCommissioner();
  }, [refreshCommissioner]);

  if (pathname === "/") {
    return null;
  }

  const barText = "text-[10px] sm:text-[11px]";
  const labelCls = "text-foreground/50 shrink-0";
  const sepCls = "text-foreground/30 select-none shrink-0";

  return (
    <>
      <BossModeOverlay open={bossOpen} onClose={() => setBossOpen(false)} />
      <div className="mb-1.5 rounded-md border border-border/35 bg-muted/[0.07] px-2 py-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {session ? (
            <div
              className={`min-w-0 flex-1 flex flex-nowrap items-center gap-x-1.5 overflow-x-auto leading-snug ${barText}`}
            >
              <span className={labelCls}>Current League:</span>
              <span className="min-w-0 max-w-[28%] sm:max-w-[11rem] truncate font-semibold text-foreground">
                {leagueMetaLoading ? "Loading…" : resolvedLeagueName ?? "—"}
              </span>
              <span className={sepCls} aria-hidden>
                ·
              </span>
              <span className={labelCls}>User:</span>
              <span className="min-w-0 max-w-[22%] sm:max-w-[9rem] truncate font-medium text-foreground">
                {session.teamName}
              </span>
              <span className={sepCls} aria-hidden>
                ·
              </span>
              <span className={labelCls}>League ID:</span>
              <code
                className="min-w-0 max-w-[26%] sm:max-w-[10rem] truncate font-mono text-[9px] sm:text-[10px] text-foreground/90"
                title={session.leagueId}
              >
                {session.leagueId}
              </code>
              <span className={sepCls} aria-hidden>
                ·
              </span>
              <button type="button" className="pool-link shrink-0 font-medium whitespace-nowrap" onClick={switchPool}>
                Switch pool or user…
              </button>
            </div>
          ) : (
            <div className={`min-w-0 flex-1 ${barText} pool-text-muted`}>
              No pool —{" "}
              <button type="button" className="pool-link font-medium" onClick={() => router.push("/")}>
                Home
              </button>
            </div>
          )}

          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setOneShiningOpen((o) => !o)}
                aria-pressed={oneShiningOpen}
                title={
                  oneShiningOpen
                    ? "Hide player and stop playback"
                    : "Play One Shining Moment (Original) — embedded from Bandcamp"
                }
                aria-label={
                  oneShiningOpen
                    ? "Stop One Shining Moment and hide Bandcamp player"
                    : "Play One Shining Moment from Bandcamp in page"
                }
                className={[
                  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold transition",
                  oneShiningOpen
                    ? "border-accent/45 bg-accent/15 text-accent"
                    : "border-border/55 bg-background/45 text-foreground/85 hover:bg-muted/50"
                ].join(" ")}
              >
                {oneShiningOpen ? (
                  <Pause className="h-3 w-3 shrink-0" aria-hidden strokeWidth={2.5} />
                ) : (
                  <Play className="h-3 w-3 shrink-0" aria-hidden fill="currentColor" />
                )}
                One Shining Moment
              </button>
              {oneShiningOpen ? (
                <div className="absolute left-0 top-[calc(100%+0.35rem)] z-[100] w-[min(calc(100vw-1.5rem),22rem)] rounded-md border border-border/50 bg-background/95 p-2 shadow-lg backdrop-blur-md">
                  <iframe
                    className="h-[120px] w-full max-w-[22rem] rounded border-0 bg-black/20"
                    src={ONE_SHINING_MOMENT_BANDCAMP_EMBED}
                    title="One Shining Moment (Original) by David Barrett — Bandcamp player"
                    allow="encrypted-media; autoplay"
                  />
                  <p className="mt-1.5 text-[9px] leading-snug text-foreground/50">
                    <a
                      href={ONE_SHINING_MOMENT_BANDCAMP_TRACK_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="pool-link font-medium"
                    >
                      One Shining Moment (Original)
                    </a>
                    {" · "}
                    David Barrett on Bandcamp
                  </p>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setBossOpen(true)}
              title="Hide the pool behind a work screen (like March Madness Boss)"
              aria-label="Boss Button — show work screen"
              className="inline-flex items-center gap-1 rounded-md border border-border/55 bg-background/45 px-2 py-1 text-[10px] font-semibold text-foreground/85 transition hover:bg-muted/50"
            >
              <Briefcase className="h-3 w-3" aria-hidden />
              Boss Button
            </button>
          </div>

          <div className="flex w-full shrink-0 flex-nowrap items-center justify-end gap-2 sm:ml-auto sm:w-auto">
            <AppearancePicker />
            <div className="min-w-0 flex-1 rounded-md border border-border/35 bg-background/35 px-1.5 py-1 sm:flex-initial sm:max-w-[260px]">
            <button
              type="button"
              onClick={() => setCommOpen((o) => !o)}
              className="flex w-full min-w-0 items-center gap-1.5 flex-nowrap text-left text-[11px] font-semibold text-foreground/75"
            >
              <span className="min-w-0 flex-1 truncate">Commissioner</span>
              <span className="text-foreground/40 shrink-0">{commOpen ? "▾" : "▸"}</span>
              {commUnlocked ? (
                <span className="shrink-0 text-[10px] font-medium text-emerald-600/90 dark:text-emerald-400/90">
                  Unlocked.
                </span>
              ) : null}
            </button>
            {commOpen && (
              <div className="mt-1.5 space-y-1.5 border-t border-border/30 pt-1.5">
                {commUnlocked && (
                  <p className="text-[11px] pool-text-muted-sm leading-snug">
                    Same value as server env <code className="pool-code">COMMISSIONER_API_SECRET</code>. Unlocks commissioner
                    APIs, tools, and proxy draft picks.
                  </p>
                )}
                {!commUnlocked && (
                  <p className="text-[10px] text-foreground/50 leading-snug">Enter the commissioner password for this browser.</p>
                )}
                <input
                  className="pool-field font-mono text-[10px] !h-8"
                  type="password"
                  autoComplete="off"
                  value={commPw}
                  onChange={(e) => setCommPw(e.target.value)}
                  placeholder="Password"
                />
                <div className="flex flex-wrap gap-1.5">
                  <Button type="button" size="sm" className="h-7 text-xs px-2" onClick={saveCommissionerPassword}>
                    Save
                  </Button>
                  <Button type="button" size="sm" variant="outline" className="h-7 text-xs px-2" onClick={clearCommissionerPassword}>
                    Clear
                  </Button>
                </div>
              </div>
            )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
