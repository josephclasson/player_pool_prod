"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Briefcase, Pause, Play, Menu, ShieldCheck } from "lucide-react";
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
import { hrefWithLeagueId } from "@/lib/pool-navigation";

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
  const [menuOpen, setMenuOpen] = useState(false);
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

  const openCommissionerTools = useCallback(() => {
    const s = readPlayerPoolSession();
    if (s?.leagueId) {
      router.push(hrefWithLeagueId("/commissioner", s.leagueId));
    } else {
      router.push("/commissioner");
    }
  }, [router]);

  const menuItems = useMemo(
    () =>
      [
        { href: "/analytics", label: "Advanced Analytics", subtitle: "Under construction" },
        { href: "/history", label: "Player Pool History", subtitle: "Under construction" }
      ] as const,
    []
  );

  const openMenuHref = useCallback(
    (href: string) => {
      const s = readPlayerPoolSession();
      setMenuOpen(false);
      if (s?.leagueId) {
        router.push(hrefWithLeagueId(href, s.leagueId));
      } else {
        router.push(href);
      }
    },
    [router]
  );

  if (pathname === "/") {
    return null;
  }

  const labelCls = "text-foreground/50 shrink-0 hidden md:inline";
  const sepCls = "text-foreground/30 select-none shrink-0 max-md:opacity-80";

  const commissionerFormFields = (
    <>
      {commUnlocked && (
        <p className="hidden sm:block text-[11px] pool-text-muted-sm leading-snug">
          Same value as server env <code className="pool-code">COMMISSIONER_API_SECRET</code>. Unlocks commissioner APIs,
          tools, and proxy draft picks.
        </p>
      )}
      {commUnlocked && (
        <div className="flex flex-wrap gap-1 sm:gap-1.5">
          <Button type="button" size="sm" variant="outline" className="h-6 text-[10px] px-1.5 sm:h-7 sm:text-xs sm:px-2" onClick={openCommissionerTools}>
            Open tools
          </Button>
        </div>
      )}
      {!commUnlocked && (
        <p className="text-[9px] text-foreground/50 leading-tight sm:text-[10px] sm:leading-snug">
          Commissioner password for this browser.
        </p>
      )}
      <input
        className="pool-field font-mono text-[10px] !h-7 sm:!h-8"
        type="password"
        autoComplete="off"
        value={commPw}
        onChange={(e) => setCommPw(e.target.value)}
        placeholder="Password"
      />
      <div className="flex flex-wrap gap-1 sm:gap-1.5">
        <Button type="button" size="sm" className="h-6 text-[10px] px-1.5 sm:h-7 sm:text-xs sm:px-2" onClick={saveCommissionerPassword}>
          Save
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-6 text-[10px] px-1.5 sm:h-7 sm:text-xs sm:px-2" onClick={clearCommissionerPassword}>
          Clear
        </Button>
      </div>
    </>
  );

  return (
    <>
      <BossModeOverlay open={bossOpen} onClose={() => setBossOpen(false)} />
      <div className="relative mb-0 md:mb-1.5 rounded-md border border-border/35 bg-muted/[0.07] px-0 py-0 text-[8px] leading-tight md:px-2 md:py-1.5 md:text-xs md:leading-normal">
        <div className="flex flex-nowrap items-center gap-x-1 md:flex-wrap md:gap-x-2 md:gap-y-1.5">
          {session ? (
            <div className="hidden md:flex min-w-0 flex-1 flex flex-nowrap items-center gap-x-0.5 overflow-hidden md:gap-x-1.5 md:overflow-x-auto md:leading-snug">
              <span className={`${labelCls}`}>Current League:</span>
              <span className="min-w-0 max-w-[28vw] sm:max-w-[32vw] md:max-w-[11rem] truncate font-semibold text-foreground">
                {leagueMetaLoading ? "…" : resolvedLeagueName ?? "—"}
              </span>
              <span className={sepCls} aria-hidden>
                ·
              </span>
              <span className={labelCls}>User:</span>
              <span className="min-w-0 max-w-[22vw] sm:max-w-[26vw] md:max-w-[9rem] truncate font-medium text-foreground">
                {session.teamName}
              </span>
              <span className={sepCls} aria-hidden>
                ·
              </span>
              <span className={labelCls}>League ID:</span>
              <code
                className="min-w-0 max-w-[2.65rem] shrink-0 truncate font-mono text-[7px] text-foreground/85 md:max-w-[10rem] md:text-[10px] md:text-foreground/90"
                title={session.leagueId}
              >
                {session.leagueId}
              </code>
              <span className={sepCls} aria-hidden>
                ·
              </span>
              <button
                type="button"
                className="pool-link max-w-[2.85rem] shrink-0 truncate font-medium whitespace-nowrap md:max-w-none md:whitespace-normal"
                onClick={switchPool}
              >
                <span className="md:hidden">Switch</span>
                <span className="hidden md:inline">Switch pool or user…</span>
              </button>
            </div>
          ) : (
            <div className="hidden md:block min-w-0 flex-1 text-[8px] text-foreground/65 sm:text-[10px] md:text-[11px]">
              No pool —{" "}
              <button type="button" className="pool-link font-medium" onClick={() => router.push("/")}>
                Home
              </button>
            </div>
          )}

          <div className="hidden md:flex shrink-0 flex-wrap items-center gap-1.5">
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

          <div className="hidden md:flex shrink-0 flex-nowrap items-center gap-0.5 md:ml-auto md:gap-2">
            <AppearancePicker triggerClassName="max-md:!h-[1.35rem] max-md:!w-[1.35rem] max-md:!min-w-[1.35rem] max-md:!p-0 max-md:[&_svg]:!h-2.5 max-md:[&_svg]:!w-2.5 shrink-0" />
            <div className="relative hidden shrink-0 md:block">
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                aria-pressed={menuOpen}
                aria-label="Open menu"
                className={[
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold transition",
                  menuOpen
                    ? "border-accent/45 bg-accent/15 text-accent"
                    : "border-border/55 bg-background/45 text-foreground/85 hover:bg-muted/50"
                ].join(" ")}
              >
                <Menu className="h-3 w-3" aria-hidden />
                Menu
              </button>
              {menuOpen ? (
                <div className="absolute right-0 top-[calc(100%+0.35rem)] z-[100] w-[min(calc(100vw-1.5rem),18rem)] rounded-md border border-border/50 bg-background/95 p-1.5 shadow-lg backdrop-blur-md">
                  {menuItems.map((i) => (
                    <button
                      key={i.href}
                      type="button"
                      onClick={() => openMenuHref(i.href)}
                      className="w-full text-left rounded-md px-2 py-1.5 hover:bg-muted/40 transition"
                    >
                      <div className="text-[11px] font-semibold text-foreground/85 leading-tight">{i.label}</div>
                      <div className="text-[10px] text-foreground/45 leading-tight mt-0.5">{i.subtitle}</div>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="hidden min-w-0 flex-1 rounded-md border border-border/35 bg-background/35 px-1 py-0.5 sm:flex-initial sm:px-1.5 sm:py-1 sm:max-w-[260px] md:block">
              <button
                type="button"
                onClick={() => setCommOpen((o) => !o)}
                className="flex w-full min-w-0 items-center gap-1 flex-nowrap text-left text-[10px] font-semibold text-foreground/75 sm:gap-1.5 sm:text-[11px]"
              >
                <span className="min-w-0 flex-1 truncate">Commissioner</span>
                <span className="text-foreground/40 shrink-0 text-[10px]">{commOpen ? "▾" : "▸"}</span>
                {commUnlocked ? (
                  <span className="shrink-0 text-[9px] font-medium text-emerald-600/90 dark:text-emerald-400/90 sm:text-[10px]">
                    Unlocked.
                  </span>
                ) : null}
              </button>
              {commOpen ? (
                <div className="mt-1 space-y-1 border-t border-border/30 pt-1 sm:mt-1.5 sm:space-y-1.5 sm:pt-1.5">
                  {commissionerFormFields}
                </div>
              ) : null}
            </div>
            <div className="relative shrink-0 md:hidden">
              <button
                type="button"
                onClick={() => setCommOpen((o) => !o)}
                aria-expanded={commOpen}
                aria-label="Commissioner login"
                title="Commissioner"
                className={[
                  "inline-flex h-[1.35rem] w-[1.35rem] items-center justify-center rounded-md border transition",
                  commOpen ? "border-accent/45 bg-accent/15 text-accent" : "border-border/55 bg-background/45 text-foreground/80",
                  commUnlocked && !commOpen ? "text-emerald-600/95 dark:text-emerald-400/90" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <ShieldCheck className="h-2.5 w-2.5 shrink-0" strokeWidth={2.25} aria-hidden />
              </button>
              {commOpen ? (
                <div className="absolute right-0 top-[calc(100%+3px)] z-[120] w-[min(18rem,calc(100vw-0.75rem))] space-y-1.5 rounded-md border border-border/50 bg-background/98 p-2 text-[10px] shadow-xl backdrop-blur-md">
                  <div className="flex items-center justify-between gap-2 border-b border-border/25 pb-1.5">
                    <span className="font-semibold text-foreground/85">Commissioner</span>
                    {commUnlocked ? (
                      <span className="text-[9px] font-medium text-emerald-600/90 dark:text-emerald-400/90">Unlocked</span>
                    ) : null}
                  </div>
                  {commissionerFormFields}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
