import { Suspense } from "react";
import { WelcomeFlow } from "@/components/welcome/WelcomeFlow";

export default function HomePage() {
  return (
    <Suspense fallback={<div className="pool-text-muted text-[11px] py-2 px-2">Loading…</div>}>
      <WelcomeFlow />
    </Suspense>
  );
}
