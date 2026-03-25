import type { Metadata } from "next";
import { HistoryPageClient } from "./HistoryPageClient";

export const metadata: Metadata = {
  title: "Player Pool History"
};

export default function HistoryPage() {
  return <HistoryPageClient />;
}
