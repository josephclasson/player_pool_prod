"use client";

import { createContext, useContext, type RefObject } from "react";

export const MainScrollContainerRefContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function useMainScrollContainerRef(): RefObject<HTMLDivElement | null> | null {
  return useContext(MainScrollContainerRefContext);
}
