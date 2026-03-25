"use client";

import { createContext, useContext } from "react";
import type { MainScrollContainerRef } from "@/lib/main-scroll-ref";

export const MainScrollContainerRefContext = createContext<MainScrollContainerRef | null>(null);

export function useMainScrollContainerRef(): MainScrollContainerRef | null {
  return useContext(MainScrollContainerRefContext);
}
