/** Best-effort light feedback (mobile). No-op on unsupported platforms. */
export function poolHapticsLight(): void {
  if (typeof navigator === "undefined") return;
  const v = navigator.vibrate;
  if (typeof v === "function") {
    try {
      // lib.dom types use `Iterable<number>` / pattern form; single-ms overload is not always present.
      v.call(navigator, [12]);
    } catch {
      /* unsupported or blocked */
    }
  }
}
