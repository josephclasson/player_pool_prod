import type { Metadata } from "next";
import { AnalyticsPageClient } from "./AnalyticsPageClient";

export const metadata: Metadata = {
  title: "Analytics"
};

export default function AnalyticsPage() {
  return <AnalyticsPageClient />;
}
