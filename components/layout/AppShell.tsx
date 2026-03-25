"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  patchPlayerPoolSessionSeasonYear,
  PLAYER_POOL_IDENTITY_CHANGE_EVENT,
  readPlayerPoolSession
} from "@/lib/player-pool-session";
import { hrefWithLeagueId, poolRouteIsPublic } from "@/lib/pool-navigation";
import { AppearancePicker } from "@/components/theme/AppearancePicker";
import {
  type LucideIcon,
  BarChart3,
  GraduationCap,
  History,
  Radio,
  ShieldCheck,
  Trophy,
  UsersRound
} from "lucide-react";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { LeagueIdentityBar } from "@/components/layout/LeagueIdentityBar";
import { PoolSessionRoutes } from "@/components/layout/PoolSessionRoutes";

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

function BottomTabNav({
  pathname,
  onNavigate,
  navItems
}: {
  pathname: string;
  onNavigate: (href: string) => void;
  navItems: readonly { href: string; label: string; icon: LucideIcon }[];
}) {
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-background/80 border-t border-border/70 backdrop-blur-xl z-40">
      <div className="flex overflow-x-auto">
        {navItems.map((t) => {
          const active = pathname.startsWith(t.href);
          const Icon = t.icon;
          return (
            <button
              key={t.href}
              type="button"
              onClick={() => onNavigate(t.href)}
              className="flex-1 min-w-[4.25rem] py-2 flex flex-col items-center justify-center gap-1 transition-colors shrink-0"
            >
              <div
                className={[
                  "rounded-full px-2.5 py-1 flex items-center justify-center border transition-all duration-300",
                  active
                    ? "bg-accent/15 border-accent/25 text-accent"
                    : "bg-background/10 border-border/60 text-foreground/45"
                ].join(" ")}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div
                className={[
                  "text-[9px] font-semibold tracking-tight text-center px-0.5 leading-tight",
                  active ? "text-accent" : "text-foreground/50"
                ].join(" ")}
              >
                {t.label}
              </div>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

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

  return (
    <div className="flex min-h-screen text-foreground">
      <SidebarNav
        pathname={pathname}
        onNavigate={navigateWithLeague}
        navItems={navTabs}
        compactFooter={pathname !== "/"}
      />

      <main className="flex-1">
        <div
          className={
            pathname === "/"
              ? "px-3 md:px-6 py-4 max-w-6xl mx-auto"
              : "px-3 md:px-5 py-1.5 md:py-2 max-w-6xl mx-auto"
          }
        >
          {pathname === "/" ? (
            <div className="flex justify-end items-center gap-2 mb-1 min-h-[2.25rem]">
              <AppearancePicker />
            </div>
          ) : null}
          <Suspense fallback={null}>
            <PoolSessionRoutes />
            <LeagueIdentityBar />
          </Suspense>
          {children}
        </div>
      </main>

      <BottomTabNav pathname={pathname} onNavigate={navigateWithLeague} navItems={navTabs} />
    </div>
  );
}
