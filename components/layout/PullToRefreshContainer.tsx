"use client";

import type { ReactNode } from "react";
import type { MainScrollContainerRef } from "@/lib/main-scroll-ref";

type Props = {
  scrollRef: MainScrollContainerRef;
  children: ReactNode;
  className?: string;
};

/** Main scroll surface; pull-to-refresh was removed for mobile (rely on explicit refresh controls). */
export function PullToRefreshContainer({ scrollRef, children, className }: Props) {
  return (
    <div ref={scrollRef} className={className ?? ""} style={{ touchAction: "pan-y" }}>
      {children}
    </div>
  );
}
