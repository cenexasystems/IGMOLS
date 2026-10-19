"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CalendarDays,
  Download,
  PackagePlus,
  RefreshCw,
  Search,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { StockMovement, StockMovementType } from "@/lib/types";
import { fetchStockMovements } from "@/app/pos/actions";

type Period = "all" | "today" | "week" | "month" | "custom";

const PERIODS: { key: Period; label: string }[] = [
  { key: "all", label: "All Time" },
  { key: "today", label: "Today" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
  { key: "custom", label: "Custom Range" },
];

const TYPE_META: Record<StockMovementType, { label: string; badge: string }> = {
  OPENING: { label: "Opening Stock", badge: "text-[#0F766E] bg-[#0F766E]/10 border-[#0F766E]/25" },
  RESTOCK: { label: "Restock", badge: "text-[#15803D] bg-[#15803D]/10 border-[#15803D]/25" },
  RETURN: { label: "Customer Return", badge: "text-[#1D4ED8] bg-[#1D4ED8]/10 border-[#1D4ED8]/25" },
  SALE: { label: "POS Sale", badge: "text-[var(--accent)] bg-[var(--accent)]/10 border-[var(--accent)]/25" },
  LOSS: { label: "Lost / Damaged", badge: "text-[#B45309] bg-[#B45309]/10 border-[#B45309]/25" },
  RECONCILE: { label: "Stock Count", badge: "text-[#6D28D9] bg-[#6D28D9]/10 border-[#6D28D9]/25" },
  EDIT: { label: "Product Edit", badge: "text-[#475569] bg-[#475569]/10 border-[#475569]/25" },
};

const inPeriod = (iso: string, period: Period, from: string, to: string): boolean => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  if (period === "all") return true;
  if (period === "today") return d.toDateString() === now.toDateString();
  if (period === "week") {
    const start = new Date(now);
    const dow = start.getDay();
    start.setDate(start.getDate() + (dow === 0 ? -6 : 1 - dow)); // Monday start
    start.setHours(0, 0, 0, 0);
    return d >= start;
  }
  if (period === "month")
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  const s = from ? new Date(`${from}T00:00:00`) : null;
  const e = to ? new Date(`${to}T23:59:59.999`) : null;
  return (!s || d >= s) && (!e || d <= e);
};

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

export default function StockMovementsPanel({
  onExportSnapshot,
}: {
  onExportSnapshot: () => void;
}) {
  // Bumping the tick refetches; the previous rows stay on screen meanwhile.
  const [reloadTick, setReloadTick] = useState(0);
  const [loaded, setLoaded] = useState<{
    tick: number;
    rows: StockMovement[];
    error: string | null;
  } | null>(null);
  const [period, setPeriod] = useState<Period>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<StockMovementType | "ALL">("ALL");

  useEffect(() => {
    let cancelled = false;
    fetchStockMovements()
      .then((rows) => {
        if (!cancelled) setLoaded({ tick: reloadTick, rows, error: null });
      })
      .catch((err) => {
        console.error("Failed to load stock movements:", err);
        if (!cancelled)
          setLoaded((prev) => ({
            tick: reloadTick,
            rows: prev?.rows ?? [],
            error: "Could not load stock movements. Check your connection and refresh.",
          }));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const loading = loaded?.tick !== reloadTick;
  const error = loaded?.error ?? null;
  const movements = useMemo(() => loaded?.rows ?? [], [loaded]);
  const load = () => setReloadTick((t) => t + 1);

  // Summary cards follow the period only; search and type filter narrow the ledger.
  const inRange = useMemo(
    () => movements.filter((m) => inPeriod(m.created_at, period, fromDate, toDate)),
    [movements, period, fromDate, toDate],
  );

  const totals = useMemo(() => {
    let incoming = 0;
    let sold = 0;
    let lost = 0;
    for (const m of inRange) {
      if (m.movement_type === "SALE") sold += -m.quantity;
      else if (m.quantity > 0) incoming += m.quantity;
      else lost += -m.quantity;
    }
    return { incoming, sold, lost, net: incoming - sold - lost };
  }, [inRange]);

  const ledger = useMemo(() => {
    const q = search.trim().toLowerCase();
    return inRange.filter(
      (m) =>
        (typeFilter === "ALL" || m.movement_type === typeFilter) &&
        (!q ||
          m.product_name.toLowerCase().includes(q) ||
          (m.reference ?? "").toLowerCase().includes(q) ||
          (m.note ?? "").toLowerCase().includes(q)),
    );
  }, [inRange, search, typeFilter]);

  const exportMovementsCSV = () => {
    if (ledger.length === 0) return;
    const headers = ["Date & Time", "Product", "Type", "Change", "Stock Before", "Stock After", "Reference", "Note"];
    const rows = ledger.map((m) => [
      formatWhen(m.created_at),
      m.product_name,
      TYPE_META[m.movement_type]?.label ?? m.movement_type,
      signed(m.quantity),
      m.stock_before,
      m.stock_after,
      m.reference ?? "",
      m.note ?? "",
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `stock-movements-${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const cards = [
    {
      label: "Incoming Stock",
      value: `+${totals.incoming}`,
      Icon: PackagePlus,
      tile: "bg-[#15803D]/10 border-[#15803D]/20 text-[#15803D]",
      text: "text-[#15803D]",
    },
    {
      label: "Units Sold (POS)",
      value: `${totals.sold}`,
      Icon: ShoppingCart,
      tile: "bg-[var(--accent)]/10 border-[var(--accent)]/20 text-[var(--accent)]",
      text: "text-[var(--accent)]",
    },
    {
      label: "Lost / Damaged",
      value: `${totals.lost}`,
      Icon: AlertCircle,
      tile: "bg-[#B45309]/10 border-[#B45309]/20 text-[#B45309]",
      text: "text-[#B45309]",
    },
    {
      label: "Net Stock Change",
      value: signed(totals.net),
      Icon: totals.net < 0 ? TrendingDown : TrendingUp,
      tile: "bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-on)]",
      text: "text-[#000000]",
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-[28px] font-black text-[#000000] tracking-tight">Stock Movements</h2>
        <p className="text-xs text-[#000000] font-semibold mt-1">
          Every change to stock — restocks, sales, returns, losses and counts — with before and after levels.
        </p>
      </div>

      {/* Period + actions */}
      <div className="bg-white border border-black/10 rounded-2xl p-3 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center bg-[#FAFAFA] border border-black/10 rounded-xl p-1 gap-1">
            {PERIODS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setPeriod(key)}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 ${
                  period === key
                    ? "bg-[var(--accent)] text-[var(--accent-on)] shadow-sm"
                    : "text-[#000000] hover:bg-[var(--accent-softer)]"
                }`}
              >
                {key === "custom" && <CalendarDays className="w-3.5 h-3.5" />}
                {label}
              </button>
            ))}
          </div>
          {period === "custom" && (
            <div className="flex flex-wrap items-center border rounded-xl px-3 py-1.5 gap-3 bg-white border-black/10">
              <label className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-[#000000]">
                From:
                <input
                  type="date"
                  value={fromDate}
                  max={toDate || undefined}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="text-xs font-bold bg-transparent border-none outline-none cursor-pointer text-[#000000] w-[115px]"
                />
              </label>
              <label className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-[#000000]">
                To:
                <input
                  type="date"
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(e) => setToDate(e.target.value)}
                  className="text-xs font-bold bg-transparent border-none outline-none cursor-pointer text-[#000000] w-[115px]"
                />
              </label>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh stock movements"
            className="w-9 h-9 rounded-lg border border-black/10 bg-white hover:bg-[#FAFAFA] flex items-center justify-center cursor-pointer disabled:cursor-wait"
          >
            <RefreshCw className={`w-4 h-4 text-[#000000]/70 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={onExportSnapshot}
            className="text-[10px] font-bold text-[#15803D] bg-[#15803D]/5 border border-[#15803D]/30 hover:bg-[#15803D]/10 px-3 py-2.5 rounded-lg uppercase tracking-wider flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" /> Stock Snapshot CSV
          </button>
          <button
            onClick={exportMovementsCSV}
            disabled={ledger.length === 0}
            className="text-[10px] font-bold text-[var(--accent-on)] bg-[var(--accent)] hover:bg-[var(--accent-strong)] px-3 py-2.5 rounded-lg uppercase tracking-wider flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" /> Movements CSV
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {cards.map(({ label, value, Icon, tile, text }) => (
          <div key={label} className="bg-white border border-black/10 rounded-2xl p-5 flex items-center gap-4">
            <div className={`w-12 h-12 rounded-xl border flex items-center justify-center shrink-0 ${tile}`}>
              <Icon className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-black uppercase tracking-wider text-[#000000]/60">{label}</div>
              <div className={`text-2xl font-black tracking-tight ${text}`}>
                {value} <span className="text-base">Units</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Ledger */}
      <div className="bg-white border border-black/10 rounded-2xl overflow-hidden">
        <div className="bg-[#FAFAFA] border-b border-black/10 p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <h3 className="text-sm font-black uppercase tracking-wider text-[#000000]">
            Movement Audit Ledger ({ledger.length})
          </h3>
          <div className="flex flex-col sm:flex-row gap-2 w-full md:w-auto">
            <div className="relative flex-1 sm:flex-none">
              <Search className="w-3.5 h-3.5 text-[#000000]/40 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search product, bill no. or note…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-3 py-2 bg-white border border-black/10 rounded-lg text-xs font-semibold focus:outline-none focus:border-[var(--accent)] w-full sm:w-64"
              />
            </div>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as StockMovementType | "ALL")}
              className="px-3 py-2 bg-white border border-black/10 rounded-lg text-xs font-bold focus:outline-none focus:border-[var(--accent)] cursor-pointer"
            >
              <option value="ALL">All Types</option>
              {(Object.keys(TYPE_META) as StockMovementType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_META[t].label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error ? (
          <div className="p-10 text-center text-xs font-bold text-[#B91C1C]">{error}</div>
        ) : loading && movements.length === 0 ? (
          <div className="p-10 text-center text-xs font-semibold text-[#000000]/50">Loading movements…</div>
        ) : ledger.length === 0 ? (
          <div className="p-12 text-center text-xs font-semibold text-[#000000]/50">
            {movements.length === 0
              ? "No stock movements yet. They appear here as you add products, restock, sell or adjust stock."
              : "No stock movements recorded for the selected period."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[860px]">
              <thead className="border-b border-black/10 select-none">
                <tr>
                  {["Date & Time", "Product", "Type", "Change", "Stock Level", "Reference / Note"].map((h, i) => (
                    <th
                      key={h}
                      className={`p-3 text-[10px] font-black text-[#000000] uppercase tracking-wider ${
                        i === 3 || i === 4 ? "text-right" : ""
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {ledger.map((m) => {
                  const meta = TYPE_META[m.movement_type];
                  return (
                    <tr key={m.id} className="hover:bg-[#FAFAFA] transition-colors">
                      <td className="p-3 text-xs font-semibold text-[#000000]/70 whitespace-nowrap">
                        {formatWhen(m.created_at)}
                      </td>
                      <td className="p-3 text-sm font-bold text-[#000000]">
                        {m.product_name}
                        {!m.product_id && (
                          <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wider text-[#000000]/40">
                            deleted
                          </span>
                        )}
                      </td>
                      <td className="p-3">
                        <span
                          className={`text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded border inline-block whitespace-nowrap ${
                            meta?.badge ?? "text-[#475569] bg-[#475569]/10 border-[#475569]/25"
                          }`}
                        >
                          {meta?.label ?? m.movement_type}
                        </span>
                      </td>
                      <td
                        className={`p-3 text-right text-sm font-black ${
                          m.quantity > 0 ? "text-[#15803D]" : "text-[#B91C1C]"
                        }`}
                      >
                        {signed(m.quantity)}
                      </td>
                      <td className="p-3 text-right text-xs font-bold text-[#000000]/70 whitespace-nowrap">
                        {m.stock_before} → <span className="text-[#000000] font-black">{m.stock_after}</span>
                      </td>
                      <td className="p-3 text-xs font-semibold text-[#000000]/70">
                        {m.reference && (
                          <span className="font-bold text-[#000000]">Bill #{m.reference}</span>
                        )}
                        {m.reference && m.note && " · "}
                        {m.note}
                        {!m.reference && !m.note && <span className="text-[#000000]/30">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
