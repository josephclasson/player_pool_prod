import type { Metadata } from "next";
import { HistoryPageClient } from "./HistoryPageClient";

export const metadata: Metadata = {
  title: "History"
};

export default function HistoryPage() {
  return <HistoryPageClient />;
}
