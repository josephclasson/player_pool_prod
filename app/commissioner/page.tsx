import { Suspense } from "react";
import { CommissionerForm } from "./CommissionerForm";

export default function CommissionerPage() {
  return (
    <Suspense
      fallback={
        <div className="pool-text-muted px-1 py-6">Loading commissioner tools…</div>
      }
    >
      <CommissionerForm />
    </Suspense>
  );
}
