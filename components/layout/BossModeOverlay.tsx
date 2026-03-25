"use client";

import { useEffect, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * March Madness–style “boss button” overlay: corporate ops dashboard + dense grid
 * so you can quickly hide the pool from someone walking by.
 * @see https://www.ncaa.com/news/basketball-men/article/2023-03-19/march-madness-boss-button-discrete-history
 */

const COL_LETTERS = ["", ..."ABCDEFGHIJKLMNOP".split("")] as const;

const ENVS = ["Prod", "Staging", "DR", "Sandbox"] as const;
const SQUADS = ["Core-API", "Data", "Edge", "Billing", "Identity", "Search", "Mobile", "Analytics"] as const;
const REGIONS = ["us-east-1", "us-west-2", "eu-west-1", "ap-south-1", "ca-central"] as const;
const APPS = ["checkout-svc", "ledger-api", "notify-worker", "auth-gw", "catalog-ro", "report-jobs", "stream-ingest"] as const;
const STATUSES = ["Healthy", "Degraded", "Maint", "Watch"] as const;
const OWNERS = ["oncall-a", "oncall-b", "sre-east", "sre-west", "platform"] as const;

function hashSeed(n: number): number {
  let x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Large deterministic corporate-style ops grid (header + many rows). */
function buildSpreadsheetRows(): string[][] {
  const header = [
    "Service ID",
    "Environment",
    "Squad",
    "Workload",
    "Region",
    "AZ",
    "CPU %",
    "Mem %",
    "RPS k",
    "Err %",
    "P95 ms",
    "7d Tickets",
    "MTTR h",
    "Cost $K",
    "Owner",
    "Last deploy"
  ];
  const rows: string[][] = [header];
  for (let i = 0; i < 52; i++) {
    const h = hashSeed(i);
    const h2 = hashSeed(i + 100);
    const h3 = hashSeed(i + 200);
    const cpu = (35 + h * 55).toFixed(1);
    const mem = (40 + h2 * 50).toFixed(1);
    const rps = (0.2 + h3 * 8).toFixed(2);
    const err = (h * 0.35).toFixed(2);
    const p95 = Math.round(40 + h2 * 420);
    const tix = String(Math.floor(h * 14));
    const mttr = (0.5 + h3 * 6).toFixed(1);
    const cost = (1.2 + h * 18).toFixed(1);
    rows.push([
      `SVC-${String(20400 + i)}`,
      ENVS[i % ENVS.length],
      SQUADS[i % SQUADS.length],
      APPS[i % APPS.length],
      REGIONS[i % REGIONS.length],
      `${String.fromCharCode(97 + (i % 3))}`,
      cpu,
      mem,
      rps,
      err,
      String(p95),
      tix,
      mttr,
      cost,
      OWNERS[i % OWNERS.length],
      `2024-${String(1 + (i % 9)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")} ${String(8 + (i % 10)).padStart(2, "0")}:00`
    ]);
  }
  rows.push([
    "—",
    "All",
    "Blended",
    "—",
    "Global",
    "—",
    "62.4",
    "58.1",
    "142.6",
    "0.11",
    "186",
    "312",
    "2.4",
    "487.3",
    "—",
    "Rolling 7d"
  ]);
  return rows;
}

const DATA_ROWS = buildSpreadsheetRows();

type PieSlice = { label: string; pct: number; fill: string };

const PIE_CLOUD: readonly PieSlice[] = [
  { label: "AWS", pct: 0.44, fill: "#f59e0b" },
  { label: "Azure", pct: 0.28, fill: "#3b82f6" },
  { label: "GCP", pct: 0.18, fill: "#22c55e" },
  { label: "Colo", pct: 0.1, fill: "#94a3b8" }
];

const PIE_INCIDENT: readonly PieSlice[] = [
  { label: "Sev1", pct: 0.08, fill: "#dc2626" },
  { label: "Sev2", pct: 0.22, fill: "#ea580c" },
  { label: "Sev3", pct: 0.38, fill: "#ca8a04" },
  { label: "Sev4+", pct: 0.32, fill: "#64748b" }
];

const PIE_SLA: readonly PieSlice[] = [
  { label: "Met", pct: 0.972, fill: "#16a34a" },
  { label: "Breached", pct: 0.028, fill: "#b91c1c" }
];

const BAR_REGION = [
  { label: "US-East", value: 94, color: "#1e40af" },
  { label: "US-West", value: 78, color: "#2563eb" },
  { label: "EU-West", value: 61, color: "#3b82f6" },
  { label: "APAC", value: 45, color: "#60a5fa" },
  { label: "CA", value: 33, color: "#93c5fd" }
] as const;

const BAR_SQUAD = [
  { label: "Core-API", value: 112, color: "#0f766e" },
  { label: "Data", value: 86, color: "#0d9488" },
  { label: "Edge", value: 71, color: "#14b8a6" },
  { label: "Billing", value: 54, color: "#2dd4bf" },
  { label: "Identity", value: 48, color: "#5eead4" }
] as const;

const BAR_QUEUE = [
  { label: "Kafka", value: 88, color: "#7c3aed" },
  { label: "Redis", value: 72, color: "#8b5cf6" },
  { label: "Rabbit", value: 41, color: "#a78bfa" },
  { label: "SQS", value: 65, color: "#c4b5fd" }
] as const;

function PieChart({ slices, size = 100, title }: { slices: readonly PieSlice[]; size?: number; title?: string }) {
  const { paths, legend } = useMemo(() => {
    let angle = -90;
    const center = size / 2;
    const r = size / 2 - 5;
    const pathEls: ReactNode[] = [];
    slices.forEach((s, i) => {
      const sweep = s.pct * 360;
      const startRad = (angle * Math.PI) / 180;
      const endRad = ((angle + sweep) * Math.PI) / 180;
      const x1 = center + r * Math.cos(startRad);
      const y1 = center + r * Math.sin(startRad);
      const x2 = center + r * Math.cos(endRad);
      const y2 = center + r * Math.sin(endRad);
      const large = sweep > 180 ? 1 : 0;
      const d = `M ${center} ${center} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
      pathEls.push(<path key={i} d={d} fill={s.fill} stroke="#fff" strokeWidth={0.75} />);
      angle += sweep;
    });
    const leg = slices.map((s) => (
      <div key={s.label} className="flex items-center gap-1 text-[9px] text-slate-700">
        <span className="h-1.5 w-1.5 shrink-0 rounded-[1px]" style={{ backgroundColor: s.fill }} />
        <span className="truncate">{s.label}</span>
        <span className="tabular-nums text-slate-500">{(s.pct * 100).toFixed(0)}%</span>
      </div>
    ));
    return { paths: pathEls, legend: leg };
  }, [size, slices]);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {title ? <div className="text-[9px] font-bold uppercase tracking-wide text-slate-600">{title}</div> : null}
      <div className="flex items-center gap-2">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
          {paths}
        </svg>
        <div className="grid min-w-0 flex-1 gap-0.5">{legend}</div>
      </div>
    </div>
  );
}

function MiniBarChart({
  items,
  title,
  subtitle
}: {
  items: readonly { label: string; value: number; color: string }[];
  title: string;
  subtitle?: string;
}) {
  const max = Math.max(...items.map((b) => b.value), 1);
  return (
    <div className="min-w-0 space-y-1">
      <div>
        <div className="text-[9px] font-bold uppercase tracking-wide text-slate-600">{title}</div>
        {subtitle ? <div className="text-[8px] text-slate-500">{subtitle}</div> : null}
      </div>
      <div className="space-y-1">
        {items.map((b) => (
          <div key={b.label} className="grid grid-cols-[3.25rem_1fr_1.65rem] items-center gap-1 text-[8px]">
            <span className="truncate text-slate-600">{b.label}</span>
            <div className="h-2.5 rounded-[2px] bg-slate-200/90">
              <div
                className="h-full rounded-[2px]"
                style={{ width: `${(b.value / max) * 100}%`, backgroundColor: b.color }}
              />
            </div>
            <span className="text-right tabular-nums text-slate-800">{b.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function KpiCard({ label, value, sub, trend }: { label: string; value: string; sub: string; trend?: string }) {
  return (
    <div className="rounded border border-slate-200/80 bg-white/90 px-2 py-1.5 shadow-sm">
      <div className="text-[8px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 text-lg font-bold tabular-nums leading-none text-slate-900">{value}</div>
      <div className="mt-0.5 flex items-baseline justify-between gap-1">
        <span className="text-[8px] text-slate-500">{sub}</span>
        {trend ? <span className="text-[8px] font-semibold text-emerald-600">{trend}</span> : null}
      </div>
    </div>
  );
}

function DashboardTopBand() {
  return (
    <div className="shrink-0 border-b border-slate-300/90 bg-gradient-to-b from-[#eef2f7] via-[#e2e8f0] to-[#d8dee9] px-2 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2 border-b border-slate-300/60 pb-2">
        <div>
          <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-[#0f2942]">
            Enterprise Technology Operations
          </div>
          <div className="text-[11px] font-semibold text-slate-800">Live service health · Cost &amp; reliability snapshot</div>
          <div className="text-[8px] text-slate-500">Source: CMDB + Observability lake · Refreshed 09:14 UTC · FY24 Q3 W12</div>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[8px] text-slate-600">
          <span className="rounded border border-slate-300 bg-white/80 px-1.5 py-0.5 font-medium">SOC 2</span>
          <span className="rounded border border-slate-300 bg-white/80 px-1.5 py-0.5 font-medium">ISO 27001</span>
          <span className="rounded border border-emerald-300/60 bg-emerald-50 px-1.5 py-0.5 font-semibold text-emerald-800">
            All regions nominal
          </span>
        </div>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        <KpiCard label="Platform uptime (30d)" value="99.982%" sub="Target 99.95%" trend="▲ 0.01%" />
        <KpiCard label="Active incidents" value="3" sub="P1: 0 · P2: 1" />
        <KpiCard label="Mean time to resolve" value="2.4h" sub="Rolling 7d" trend="▼ 18%" />
        <KpiCard label="API error budget" value="94%" sub="Month to date" />
        <KpiCard label="Infra spend MTD" value="$487K" sub="vs plan −2.1%" trend="▼ under" />
        <KpiCard label="Changes (7d)" value="128" sub="Failed: 2 (1.6%)" />
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <div className="rounded border border-slate-200 bg-white/95 p-2 shadow-sm">
          <MiniBarChart
            title="Traffic index"
            subtitle="Normalized RPS by region"
            items={BAR_REGION}
          />
        </div>
        <div className="rounded border border-slate-200 bg-white/95 p-2 shadow-sm">
          <MiniBarChart
            title="Ticket volume"
            subtitle="Opened tickets by squad (7d)"
            items={BAR_SQUAD}
          />
        </div>
        <div className="rounded border border-slate-200 bg-white/95 p-2 shadow-sm">
          <MiniBarChart
            title="Queue depth"
            subtitle="Broker lag index"
            items={BAR_QUEUE}
          />
        </div>
        <div className="rounded border border-slate-200 bg-white/95 p-2 shadow-sm">
          <PieChart slices={PIE_CLOUD} size={88} title="Spend by cloud" />
        </div>
        <div className="rounded border border-slate-200 bg-white/95 p-2 shadow-sm">
          <PieChart slices={PIE_INCIDENT} size={88} title="Incidents by severity" />
        </div>
        <div className="rounded border border-slate-200 bg-white/95 p-2 shadow-sm">
          <PieChart slices={PIE_SLA} size={88} title="SLA attainment (MTD)" />
        </div>
      </div>
    </div>
  );
}

export function BossModeOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const colCount = DATA_ROWS[0]?.length ?? 0;
  const letters = COL_LETTERS.slice(0, colCount + 1);

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-[#e7e6e6] text-neutral-800 shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="Work screen"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[#1a5c38] bg-[#217346] px-2 text-[12px] font-medium text-white shadow-sm sm:px-3">
        <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide">XLSX</span>
        <span className="min-w-0 truncate">
          ITOPS_Service_Inventory_Live.xlsx — [Dashboard + Grid] · Read-only (SharePoint)
        </span>
        <span className="ml-auto hidden text-[10px] text-white/80 sm:inline">Autosaved</span>
      </header>

      <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-300 bg-[#f3f3f2] px-2 text-[10px] text-neutral-600">
        {["File", "Home", "Insert", "Page Layout", "Formulas", "Data", "Review", "View", "Automate", "Developer"].map((t, i) => (
          <button
            key={t}
            type="button"
            tabIndex={-1}
            className={`shrink-0 rounded px-2 py-1 ${i === 1 ? "bg-[#d4d4d4] font-semibold text-neutral-800" : "hover:bg-neutral-200/80"}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex h-8 shrink-0 items-stretch gap-1 border-b border-neutral-300 bg-white px-2">
        <div className="flex w-14 shrink-0 items-center justify-center border border-neutral-300 bg-[#f2f2f2] text-[11px] font-medium text-neutral-600">
          AD52
        </div>
        <div className="flex w-8 shrink-0 items-center justify-center border border-l-0 border-neutral-300 bg-[#f2f2f2] text-[11px] italic text-neutral-500">
          fx
        </div>
        <div className="flex min-w-0 flex-1 items-center border border-l-0 border-neutral-300 bg-white px-2 text-[11px] text-neutral-800">
          <span className="truncate font-mono">
            =LET(r,$G$2:$G$54,AVERAGE(r))&amp;&quot; % avg CPU · &quot;&amp;TEXT(NOW(),&quot;yyyy-mm-dd hh:mm&quot;)
          </span>
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <DashboardTopBand />

        <div className="min-h-0 flex-1 overflow-auto bg-[#e7e6e6] p-1.5 sm:p-2">
          <div className="inline-block min-w-full rounded-sm border border-neutral-300 bg-white shadow-sm">
            <div className="border-b border-neutral-200 bg-[#f8fafc] px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-600">
              Sheet: <span className="text-slate-900">Service_Inventory</span>
              <span className="mx-2 text-slate-300">|</span>
              {DATA_ROWS.length} rows × {colCount} cols
              <span className="mx-2 text-slate-300">|</span>
              Table: <span className="font-mono text-slate-800">tbl_prod_services</span>
            </div>
            <table className="w-max min-w-full border-collapse text-left text-[10px] leading-tight">
              <thead>
                <tr className="bg-[#f2f2f2]">
                  {letters.map((c) => (
                    <th
                      key={c || "corner"}
                      className={`sticky top-0 z-[1] border border-neutral-300 px-1 py-0.5 text-center text-[9px] font-semibold text-neutral-600 shadow-[0_1px_0_rgba(0,0,0,0.06)] ${
                        c === "" ? "w-7 min-w-[1.75rem] bg-[#e8e8e8]" : "min-w-[4.5rem] whitespace-nowrap sm:min-w-[5.25rem]"
                      }`}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DATA_ROWS.map((cells, ri) => {
                  const isHeader = ri === 0;
                  const isTotal = ri === DATA_ROWS.length - 1;
                  return (
                    <tr
                      key={ri}
                      className={
                        isHeader
                          ? "bg-[#e8e8e8] font-semibold text-neutral-800"
                          : isTotal
                            ? "bg-[#fff2cc] font-semibold text-neutral-900"
                            : ri % 2 === 0
                              ? "bg-white hover:bg-[#f9fafb]"
                              : "bg-[#fafafa] hover:bg-[#f3f4f6]"
                      }
                    >
                      <td className="border border-neutral-300 bg-[#f2f2f2] px-0.5 py-0.5 text-center text-[9px] font-medium text-neutral-500 tabular-nums">
                        {ri + 1}
                      </td>
                      {cells.map((c, ci) => {
                        const isErr = ci === 9 && !isHeader && !isTotal;
                        const v = c.trim();
                        const errNum = isErr && parseFloat(v) > 0.25;
                        const cpuHigh = ci === 6 && !isHeader && !isTotal && parseFloat(v) > 85;
                        return (
                          <td
                            key={ci}
                            className={`max-w-[10rem] border border-neutral-200 px-1.5 py-0.5 tabular-nums sm:max-w-none ${
                              errNum ? "bg-red-50 text-red-800"
                              : cpuHigh ? "bg-amber-50 text-amber-900"
                              : "text-neutral-800"
                            }`}
                          >
                            <span className="line-clamp-2 sm:line-clamp-none">{c}</span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 px-1 text-[9px] text-neutral-500">
            Protected ranges: A1:P54 · Data validation on columns C, E · External data connections disabled in shared view
          </p>
        </div>
      </div>

      <div className="flex h-7 shrink-0 items-end gap-0 overflow-x-auto border-t border-neutral-300 bg-[#d4d4d4] px-1">
        {["Dashboard_Grid", "Service_Inventory", "Cost_Alloc", "Incidents", "Changes", "Archive"].map((name, i) => (
          <button
            key={name}
            type="button"
            tabIndex={-1}
            className={`shrink-0 rounded-t border border-b-0 border-neutral-400 px-2.5 py-1 text-[9px] font-medium ${
              i === 1 ? "relative top-px bg-white text-neutral-900" : "bg-[#e1e1e1] text-neutral-600 hover:bg-[#ececec]"
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      <footer className="flex shrink-0 flex-col gap-2 border-t border-neutral-300 bg-[#217346] px-2 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-3">
        <p className="text-[10px] text-white/85 sm:max-w-[55%]">
          Press <kbd className="rounded bg-white/20 px-1 font-mono text-[9px]">Esc</kbd> to leave this work screen.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-white/40 bg-white px-4 py-2 text-[13px] font-bold text-[#217346] shadow-md transition hover:bg-[#f0fdf4] sm:w-auto"
        >
          <X className="h-4 w-4 shrink-0" strokeWidth={2.5} aria-hidden />
          Return to Player Pool
        </button>
      </footer>
    </div>,
    document.body
  );
}
