"use client";

import { useEffect, useRef, useState } from "react";
import { PaintBucket } from "lucide-react";

export type ThemeKey = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

const THEME_KEYS = new Set<ThemeKey>([
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple"
]);

/** Red → purple spectrum; yellow is the default in layout + normalizeStoredTheme. */
const THEMES: Array<{ key: ThemeKey; label: string }> = [
  { key: "red", label: "Red" },
  { key: "orange", label: "Orange" },
  { key: "yellow", label: "Yellow" },
  { key: "green", label: "Green" },
  { key: "blue", label: "Blue" },
  { key: "purple", label: "Purple" }
];

/** Map removed theme keys so returning users land on a valid palette. */
function normalizeStoredTheme(raw: string | null): ThemeKey {
  if (!raw) return "yellow";
  if (raw === "indigo" || raw === "violet") return "purple";
  if (THEME_KEYS.has(raw as ThemeKey)) return raw as ThemeKey;
  const legacy: Record<string, ThemeKey> = {
    databallr: "yellow",
    sleeper: "yellow",
    espn: "red",
    yahoo: "blue",
    microsoft: "green"
  };
  return legacy[raw] ?? "yellow";
}

function applyTheme(theme: ThemeKey) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme-preference", theme);
}

/** Top-bar control: paint bucket opens theme list. */
export function AppearancePicker({ triggerClassName }: { triggerClassName?: string } = {}) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeKey>("yellow");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = normalizeStoredTheme(localStorage.getItem("theme-preference"));
    setTheme(stored);
    applyTheme(stored);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const el = wrapRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (key: ThemeKey) => {
    setTheme(key);
    applyTheme(key);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative z-50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={[
          "inline-flex items-center justify-center gap-1 rounded-md border border-border/55 bg-background/45 px-2 py-1 text-[10px] font-semibold text-foreground/85 transition hover:bg-muted/50",
          triggerClassName
        ]
          .filter(Boolean)
          .join(" ")}
        title="Appearance — color theme"
        aria-label="Appearance — choose color theme"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <PaintBucket className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />
      </button>
      {open ? (
        <div
          className="absolute right-0 top-full mt-1 min-w-[11rem] rounded-lg border border-border/60 bg-background/95 py-1 shadow-lg backdrop-blur-md"
          role="listbox"
          aria-label="Themes"
        >
          <div className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-foreground/45">
            Appearance
          </div>
          {THEMES.map((t) => (
            <button
              key={t.key}
              type="button"
              role="option"
              aria-selected={theme === t.key}
              onClick={() => pick(t.key)}
              className={[
                "flex w-full items-center px-2.5 py-1.5 text-left text-xs font-medium transition-colors",
                theme === t.key
                  ? "bg-accent/15 text-accent"
                  : "text-foreground/80 hover:bg-muted/50 hover:text-foreground"
              ].join(" ")}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
