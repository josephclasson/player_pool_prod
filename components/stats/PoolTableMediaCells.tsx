"use client";

import { useEffect, useState } from "react";

const CIRCLE_CLIP =
  "mx-auto h-8 w-8 shrink-0 overflow-hidden rounded-full bg-black/25 ring-1 ring-[rgb(var(--pool-stats-border)/0.4)]";

function MediaFallback({ title, label }: { title: string; label?: string }) {
  const text =
    label && label.trim()
      ? (() => {
          const parts = label.trim().split(/\s+/).filter(Boolean);
          if (parts.length === 0) return "—";
          if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
          return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
        })()
      : "—";
  return (
    <div
      className={`${CIRCLE_CLIP} flex items-center justify-center text-[9px] font-semibold text-[rgb(var(--pool-stats-header-label)/0.55)] bg-[rgb(var(--pool-stats-header-bg)/0.55)]`}
      title={title}
      aria-hidden
    >
      {text}
    </div>
  );
}

type CellProps = {
  url?: string | null | undefined;
  label: string;
  /** Shown to screen readers when url present */
  alt: string;
  /**
   * `cover` fills the circle (typical for headshots).
   * `contain` fits the whole logo inside the circle (typical for team marks).
   */
  fit: "cover" | "contain";
};

function PoolTableImageCell({
  url,
  urls,
  label,
  alt,
  fit,
  initialsFromLabel,
  cellClassName
}: CellProps & {
  urls?: string[];
  /** When all image URLs fail, show initials from this name instead of "—". */
  initialsFromLabel?: string;
  cellClassName?: string;
}) {
  const list = urls?.length
    ? urls
    : url?.trim()
      ? [url.trim()]
      : [];
  const listKey = list.join("\0");
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
  }, [listKey]);
  const current = list[index] ?? null;
  const showImg = Boolean(current) && index < list.length;

  const imgClass =
    fit === "contain"
      ? "block h-full w-full rounded-full object-contain object-center p-0.5"
      : "block h-full w-full rounded-full object-cover object-center";

  return (
    <td className={["w-10 max-w-[2.5rem] px-1 py-1 align-middle", cellClassName].filter(Boolean).join(" ")}>
      {showImg ? (
        <div className={CIRCLE_CLIP}>
          {/* eslint-disable-next-line @next/next/no-img-element -- external CDNs; avoid next/image domain config for now */}
          <img
            key={current}
            src={current!}
            alt={alt}
            width={32}
            height={32}
            referrerPolicy="no-referrer"
            className={imgClass}
            loading="lazy"
            decoding="async"
            onError={() => {
              setIndex((i) => (i + 1 < list.length ? i + 1 : list.length));
            }}
          />
        </div>
      ) : (
        <MediaFallback title={label} label={initialsFromLabel ?? label} />
      )}
    </td>
  );
}

export function PoolTableTeamLogoCell({
  url,
  teamName,
  cellClassName
}: {
  url: string | null | undefined;
  teamName: string;
  cellClassName?: string;
}) {
  return (
    <PoolTableImageCell
      url={url}
      label={teamName}
      alt={`${teamName} logo`}
      fit="contain"
      cellClassName={cellClassName}
    />
  );
}

export function PoolTablePlayerPhotoCell({
  url,
  urls,
  playerName,
  cellClassName
}: {
  url?: string | null | undefined;
  /** Tried in order until one loads (e.g. roster CDN URL then ESPN PNG/JPG fallbacks). */
  urls?: string[] | null | undefined;
  playerName: string;
  cellClassName?: string;
}) {
  const merged =
    urls?.filter((u) => typeof u === "string" && u.trim()) ??
    (url?.trim() ? [url.trim()] : []);
  return (
    <PoolTableImageCell
      urls={merged}
      label={playerName}
      alt={`${playerName} headshot`}
      fit="cover"
      cellClassName={cellClassName}
    />
  );
}
