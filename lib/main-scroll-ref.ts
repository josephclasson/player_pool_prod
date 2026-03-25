import type { RefObject } from "react";

/**
 * Shared type for the main app scroll container ref (pull-to-refresh + identity bar scroll).
 *
 * Use **`RefObject<HTMLDivElement>`** only — not `RefObject<HTMLDivElement | null>`.
 * In `@types/react`, `RefObject<T>` already models `current` as `T | null`. Putting
 * `null` inside `T` breaks assignability to JSX `ref` (`RefObject<HTMLDivElement>`).
 */
export type MainScrollContainerRef = RefObject<HTMLDivElement>;
