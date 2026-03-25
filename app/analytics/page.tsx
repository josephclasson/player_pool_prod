import type { Metadata } from "next";
import { AnalyticsPageClient } from "./AnalyticsPageClient";

export const metadata: Metadata = {
  title: "Advanced Analytics"
};

export default function AnalyticsPage() {
  return <AnalyticsPageClient />;
}
