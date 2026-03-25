"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  patchPlayerPoolSessionSeasonYear,
  PLAYER_POOL_IDENTITY_CHANGE_EVENT,
  readCommissionerSecretFromSession,
  readPlayerPoolSession
} from "@/lib/player-pool-session";
import { hrefWithLeagueId, poolRouteIsPublic } from "@/lib/pool-navigation";
import { AppearancePicker } from "@/components/theme/AppearancePicker";
import {
  type LucideIcon,
  BarChart3,
  GraduationCap,
  History,
  Menu,
  Radio,
  ShieldCheck,
  Trophy,
  UsersRound
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Suspense } from "react";
import { LeagueIdentityBar } from "@/components/layout/LeagueIdentityBar";
import { MainScrollContainerRefContext } from "@/components/layout/MainScrollContainerContext";
import { PullToRefreshContainer } from "@/components/layout/PullToRefreshContainer";
import { PoolSessionRoutes } from "@/components/layout/PoolSessionRoutes";

/** Minimum content width used when layout has not measured yet (avoids absurd zoom). */
const MOBILE_ZOOM_MIN_CONTENT_PX = 320;

/** Match `max-w-6xl` (72rem) so mobile lays out like desktop, then shell zoom fits the canvas to the viewport. */
const MOBILE_DESKTOP_CANVAS_MIN_PX = 1152;

/**
 * Icons aligned with databallr.com/stats nav (same Lucide glyphs they ship) where applicable:
 * Live → Radio, NBA Draft → GraduationCap, WOWY Lineups → UsersRound; Leaderboard → Trophy (pool standings).
 */
const navTabs: readonly { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/draft", label: "Draft", icon: GraduationCap },
  { href: "/stat-tracker", label: "StatTracker", icon: Radio },
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/players", label: "Player Statistics", icon: UsersRound },
  { href: "/analytics", label: "Advanced Analytics", icon: BarChart3 },
  { href: "/history", label: "Player Pool History", icon: History },
  { href: "/commissioner", label: "Commissioner Tools", icon: ShieldCheck }
];

/** Mobile bottom bar: four primary destinations + “More” (ESPN-style). Labels shortened to fit fixed slots. */
const mobilePrimaryNav: readonly { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/draft", label: "Draft", icon: GraduationCap },
  { href: "/stat-tracker", label: "Scores", icon: Radio },
  { href: "/leaderboard", label: "Leaders", icon: Trophy },
  { href: "/players", label: "Players", icon: UsersRound }
];

type MobileMoreItem = { href: string; label: string; subtitle: string; icon: LucideIcon };

function SidebarNav({
  pathname,
  onNavigate,
  navItems,
  compactFooter
}: {
  pathname: string;
  onNavigate: (href: string) => void;
  navItems: readonly { href: string; label: string; icon: LucideIcon }[];
  compactFooter?: boolean;
}) {
  const [identityRev, setIdentityRev] = useState(0);
  /** Session lives in sessionStorage — must match SSR (no storage) on first paint to avoid hydration mismatch. */
  const [tournamentSubtitle, setTournamentSubtitle] = useState("March Madness");

  useEffect(() => {
    const onIdent = () => setIdentityRev((n) => n + 1);
    window.addEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, onIdent);
    return () => window.removeEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, onIdent);
  }, []);

  useEffect(() => {
    const poolSession = readPlayerPoolSession();
    setTournamentSubtitle(
      poolSession?.seasonYear != null && Number.isFinite(poolSession.seasonYear)
        ? `March Madness ${Math.trunc(poolSession.seasonYear)}`
        : "March Madness"
    );
  }, [identityRev]);

  useEffect(() => {
    const s = readPlayerPoolSession();
    if (!s?.leagueId || s.seasonYear != null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/leagues/${encodeURIComponent(s.leagueId)}/teams`);
        const j = (await res.json()) as { seasonYear?: number };
        if (cancelled || !res.ok) return;
        if (typeof j.seasonYear === "number" && Number.isFinite(j.seasonYear)) {
          patchPlayerPoolSessionSeasonYear(j.seasonYear);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identityRev]);

  return (
    <aside className="hidden md:flex md:w-56 shrink-0 flex-col border-r border-border/50 bg-background py-4 pl-2 pr-2">
      {/* databallr-style header strip */}
      <div className="px-3 pb-4 mb-1 border-b border-border/20">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-8 min-w-[2.35rem] px-1 rounded-lg bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
            <span className="text-[8px] font-bold tracking-tight text-accent leading-none text-center">PP</span>
          </div>
          <div className="leading-tight min-w-0">
            <div className="text-sm font-semibold text-foreground truncate">Player Pool</div>
            <div className="text-[10px] font-medium text-foreground/45 tracking-wide leading-snug">
              {tournamentSubtitle}
            </div>
          </div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 flex-1 pt-2">
        {navItems.map((t) => {
          const active = pathname.startsWith(t.href);
          const Icon = t.icon;
          return (
            <button
              key={t.href}
              type="button"
              onClick={() => onNavigate(t.href)}
              className={[
                "group w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-left",
                "border transition-[background-color,color,border-color] duration-300 ease-out",
                active
                  ? "rounded-lg bg-accent/15 text-foreground border-accent/25"
                  : "rounded-md border-transparent text-foreground/55 hover:bg-muted/40 hover:text-foreground"
              ].join(" ")}
            >
              <Icon
                className={[
                  "h-4 w-4 shrink-0 transition-colors duration-300",
                  active ? "text-accent" : "text-foreground/40 group-hover:text-accent"
                ].join(" ")}
              />
              <span className="truncate">{t.label}</span>
            </button>
          );
        })}
      </nav>

      {!compactFooter ? (
        <div className="mt-auto pt-4 border-t border-border/20 px-3 text-[10px] text-foreground/40 leading-relaxed">
          Choose your pool once on the home page. Use the bar for commissioner password or switching pools.
        </div>
      ) : (
        <div className="mt-auto pt-2 border-t border-border/15 px-3 text-[9px] text-foreground/30">
          Pool &amp; commissioner → top bar
        </div>
      )}
    </aside>
  );
}

function MobileBottomTabNav({
  pathname,
  onNavigate,
  moreItems
}: {
  pathname: string;
  onNavigate: (href: string) => void;
  moreItems: readonly MobileMoreItem[];
}) {
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (!moreOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [moreOpen]);

  const moreActive = moreItems.some((t) => pathname.startsWith(t.href));

  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  return (
    <>
      <nav
        className="app-mobile-tab-bar md:hidden fixed bottom-0 left-0 right-0 z-40 flex flex-col bg-background/95 border-t border-border/70 backdrop-blur-xl"
        aria-label="Primary"
      >
        <div className="grid h-[52px] grid-cols-5 w-full">
          {mobilePrimaryNav.map((t) => {
            const active = pathname.startsWith(t.href);
            const Icon = t.icon;
            return (
              <button
                key={t.href}
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  onNavigate(t.href);
                }}
                className={[
                  "flex flex-col items-center justify-center gap-0.5 px-0.5 transition-colors",
                  active ? "text-accent" : "text-foreground/50"
                ].join(" ")}
              >
                <span
                  className={[
                    "flex h-8 w-10 items-center justify-center rounded-full border",
                    active ? "border-accent/35 bg-accent/15" : "border-border/50 bg-background/30"
                  ].join(" ")}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                </span>
                <span className="max-w-full truncate text-[10px] font-semibold leading-none tracking-tight">{t.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            aria-controls="mobile-nav-more-sheet"
            className={[
              "flex flex-col items-center justify-center gap-0.5 px-0.5 transition-colors",
              moreOpen || moreActive ? "text-accent" : "text-foreground/50"
            ].join(" ")}
          >
            <span
              className={[
                "flex h-8 w-10 items-center justify-center rounded-full border",
                moreOpen || moreActive ? "border-accent/35 bg-accent/15" : "border-border/50 bg-background/30"
              ].join(" ")}
            >
              <Menu className="h-[18px] w-[18px] shrink-0" aria-hidden />
            </span>
            <span className="max-w-full truncate text-[10px] font-semibold leading-none tracking-tight">More</span>
          </button>
        </div>
        <div
          className="shrink-0 bg-background/95"
          style={{ height: "env(safe-area-inset-bottom, 0px)" }}
          aria-hidden
        />
      </nav>

      {moreOpen ? (
        <div className="md:hidden fixed inset-0 z-[45] flex flex-col justify-end" role="presentation">
          <button
            type="button"
            className="absolute inset-0 bg-black/55"
            aria-label="Close menu"
            onClick={() => setMoreOpen(false)}
          />
          <div
            id="mobile-nav-more-sheet"
            className="relative max-h-[min(72vh,520px)] overflow-y-auto rounded-t-2xl border border-border/60 border-b-0 bg-background px-2 pb-3 pt-2 shadow-2xl"
            style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
          >
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-foreground/20" aria-hidden />
            <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-foreground/45">More</div>
            <ul className="flex flex-col gap-0.5">
              {moreItems.map((t) => {
                const Icon = t.icon;
                const active = pathname.startsWith(t.href);
                return (
                  <li key={t.href}>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        onNavigate(t.href);
                      }}
                      className={[
                        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                        active ? "bg-accent/15 text-accent" : "hover:bg-muted/40 text-foreground"
                      ].join(" ")}
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background/40">
                        <Icon className="h-4 w-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold leading-tight">{t.label}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-foreground/45">{t.subtitle}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}

function measureMobileContentWidthPx(el: HTMLElement): number {
  const prevZoom = el.style.zoom;
  el.style.zoom = "1";
  void el.offsetWidth;
  let w = el.scrollWidth;
  for (const t of el.querySelectorAll("table.pool-table")) {
    w = Math.max(w, (t as HTMLElement).scrollWidth);
  }
  if (prevZoom) el.style.zoom = prevZoom;
  else el.style.removeProperty("zoom");
  return Math.max(w, MOBILE_ZOOM_MIN_CONTENT_PX);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const mainScrollRef = useRef<HTMLDivElement>(null);
  const mobileZoomContentRef = useRef<HTMLDivElement>(null);
  const mobileZoomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [commUnlocked, setCommUnlocked] = useState(() => readCommissionerSecretFromSession().length > 0);
  const [mobileFitZoom, setMobileFitZoom] = useState(1);

  useEffect(() => {
    const sync = () => setCommUnlocked(readCommissionerSecretFromSession().length > 0);
    window.addEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, sync);
    window.addEventListener("focus", sync);
    sync();
    return () => {
      window.removeEventListener(PLAYER_POOL_IDENTITY_CHANGE_EVENT, sync);
      window.removeEventListener("focus", sync);
    };
  }, []);

  const scheduleMobileZoomMeasure = useCallback(() => {
    if (mobileZoomDebounceRef.current) clearTimeout(mobileZoomDebounceRef.current);
    mobileZoomDebounceRef.current = setTimeout(() => {
      mobileZoomDebounceRef.current = null;
      const mobileMq = window.matchMedia("(max-width: 767px)");
      if (!mobileMq.matches) {
        setMobileFitZoom(1);
        return;
      }
      const outer = mainScrollRef.current;
      const inner = mobileZoomContentRef.current;
      if (!outer || !inner) return;
      const avail = Math.max(160, outer.clientWidth);
      const needed = measureMobileContentWidthPx(inner);
      /* Slightly aggressive so full desktop-width tables fit without horizontal pan; pinch-zoom reads detail. */
      const z = Math.min(1, Math.max(0.05, (avail * 0.96) / needed));
      setMobileFitZoom((cur) => (Math.abs(cur - z) < 0.004 ? cur : z));
    }, 50);
  }, []);

  useLayoutEffect(() => {
    scheduleMobileZoomMeasure();
  }, [pathname, scheduleMobileZoomMeasure]);

  useLayoutEffect(() => {
    const mobileMq = window.matchMedia("(max-width: 767px)");
    if (!mobileMq.matches) return;
    const outer = mainScrollRef.current;
    const inner = mobileZoomContentRef.current;
    if (!inner) return;
    const ro = new ResizeObserver(() => scheduleMobileZoomMeasure());
    ro.observe(inner);
    if (outer) ro.observe(outer);
    window.addEventListener("resize", scheduleMobileZoomMeasure);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", scheduleMobileZoomMeasure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", scheduleMobileZoomMeasure);
      vv?.removeEventListener("resize", scheduleMobileZoomMeasure);
      if (mobileZoomDebounceRef.current) clearTimeout(mobileZoomDebounceRef.current);
    };
  }, [pathname, scheduleMobileZoomMeasure]);

  const navTabsEffective = commUnlocked
    ? navTabs
    : navTabs.filter((t) => t.href !== "/commissioner");

  const mobileMoreItems: MobileMoreItem[] = [
    { href: "/analytics", label: "Advanced Analytics", subtitle: "Under construction", icon: BarChart3 },
    { href: "/history", label: "Player Pool History", subtitle: "Under construction", icon: History }
  ];
  if (commUnlocked) {
    mobileMoreItems.push({
      href: "/commissioner",
      label: "Commissioner Tools",
      subtitle: "Sync, draft admin, invites",
      icon: ShieldCheck
    });
  }

  const navigateWithLeague = (href: string) => {
    const pathOnly = href.split("?")[0] ?? href;
    if (poolRouteIsPublic(pathOnly)) {
      router.push(href);
      return;
    }
    const s = readPlayerPoolSession();
    if (s?.leagueId) {
      router.push(hrefWithLeagueId(href, s.leagueId));
    } else {
      router.push(href);
    }
  };

  const mobileShellZoomStyle: CSSProperties | undefined =
    mobileFitZoom < 0.999 ? { zoom: mobileFitZoom } : undefined;

  return (
    <div className="safe-area-wrapper flex h-dvh min-h-0 w-full flex-col overflow-hidden text-foreground md:min-h-screen md:h-auto md:overflow-visible">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row md:overflow-visible">
        <SidebarNav
          pathname={pathname}
          onNavigate={navigateWithLeague}
          navItems={navTabsEffective}
          compactFooter={pathname !== "/"}
        />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            className={
              pathname === "/"
                ? "flex min-h-0 flex-1 flex-col px-3 pb-[calc(52px+env(safe-area-inset-bottom,0px))] pt-4 max-w-6xl mx-auto w-full md:px-6 md:pb-4"
                : "flex min-h-0 flex-1 flex-col px-3 pb-[calc(52px+env(safe-area-inset-bottom,0px))] pt-1.5 max-w-6xl mx-auto w-full md:px-5 md:py-2 md:pb-2"
            }
          >
            {pathname === "/" ? (
              <div className="flex justify-end items-center gap-2 mb-1 min-h-[2.25rem] shrink-0">
                <AppearancePicker />
              </div>
            ) : null}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:min-w-0 md:overflow-visible">
              <Suspense fallback={null}>
                <PoolSessionRoutes />
                <LeagueIdentityBar />
              </Suspense>
              <MainScrollContainerRefContext.Provider value={mainScrollRef}>
                <PullToRefreshContainer
                  scrollRef={mainScrollRef}
                  className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden md:min-h-0 md:overflow-x-visible md:overflow-visible"
                >
                  <div
                    ref={mobileZoomContentRef}
                    className={[
                      "flex min-h-0 flex-col",
                      /* Mobile: full desktop-width layout plane (not shrink-to-fit to viewport — `self-start` caused that). */
                      "max-md:min-w-[72rem] max-md:w-max max-md:flex-none max-md:shrink-0",
                      "md:min-h-0 md:min-w-0 md:flex-1 md:w-full"
                    ].join(" ")}
                    style={mobileShellZoomStyle}
                  >
                    {children}
                  </div>
                </PullToRefreshContainer>
              </MainScrollContainerRefContext.Provider>
            </div>
          </div>
        </main>
      </div>

      <MobileBottomTabNav pathname={pathname} onNavigate={navigateWithLeague} moreItems={mobileMoreItems} />
    </div>
  );
}
