"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { AlertTriangle, Package, Volume2, VolumeX } from "lucide-react";

export type LowStockItem = {
  id: string;
  name: string;
  category?: string;
  stock: number;
  alertAt: number;
};

// Product ids whose low-stock alarm has been acknowledged. An id is dropped
// once the product is restocked, so it alarms again if it runs low later.
const ACK_KEY = "pos_low_stock_ack";

function readAcknowledged(): Set<string> {
  try {
    const raw = localStorage.getItem(ACK_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeAcknowledged(ids: string[]) {
  try {
    localStorage.setItem(ACK_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailable (private mode) — the alarm simply sounds next time.
  }
}

/** Two-tone beep repeated every 1.2s until stopped. */
function startAlarmSound(): () => void {
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
  } catch {
    return () => {};
  }
  const audio = ctx;
  const beep = (freq: number, at: number) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.15, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.26);
  };
  const ring = () => {
    const t = audio.currentTime;
    beep(880, t);
    beep(660, t + 0.3);
  };
  ring();
  const interval = window.setInterval(ring, 1200);
  return () => {
    window.clearInterval(interval);
    audio.close().catch(() => {});
  };
}

export default function LowStockAlarm({
  items,
  onClose,
}: {
  items: LowStockItem[];
  onClose: () => void;
}) {
  // Sound only for items that have not been acknowledged yet.
  const hasNewItems = useMemo(() => {
    const acknowledged = readAcknowledged();
    return items.some((i) => !acknowledged.has(i.id));
  }, [items]);

  const stopSound = useRef<() => void>(() => {});

  useEffect(() => {
    if (!hasNewItems) return;
    stopSound.current = startAlarmSound();
    return () => stopSound.current();
  }, [hasNewItems]);

  const acknowledge = () => {
    stopSound.current();
    writeAcknowledged(items.map((i) => i.id));
    onClose();
  };

  const sorted = [...items].sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name));

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div
        role="alertdialog"
        aria-labelledby="low-stock-title"
        className="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden border-2 border-[#FCA5A5] flex flex-col max-h-[90vh]"
      >
        <div className="bg-gradient-to-r from-[#DC2626] to-[#F97316] px-6 py-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-full bg-white/20 flex items-center justify-center shrink-0">
              <AlertTriangle className={`w-5 h-5 text-white ${hasNewItems ? "animate-pulse" : ""}`} />
            </div>
            <div className="min-w-0">
              <h3 id="low-stock-title" className="text-lg font-black text-white leading-tight">
                Low Stock Alarm Active
              </h3>
              <p className="text-xs font-bold text-white/90">
                {items.length} {items.length === 1 ? "item requires" : "items require"} immediate restocking
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 bg-white/20 text-white text-[10px] font-black uppercase tracking-wider px-3 py-1.5 rounded-full shrink-0">
            {hasNewItems ? (
              <>
                <Volume2 className="w-3.5 h-3.5" /> Alarm Sounding
              </>
            ) : (
              <>
                <VolumeX className="w-3.5 h-3.5" /> Silenced
              </>
            )}
          </span>
        </div>

        <div className="px-6 pt-4 pb-2 text-xs font-semibold text-[#000000]/60">
          {hasNewItems
            ? "The audible alarm and visual alert will sound until acknowledged."
            : "These items were already acknowledged and are still low on stock."}
        </div>

        <div className="px-6 py-2 space-y-2.5 overflow-y-auto">
          {sorted.map((item) => {
            const isOut = item.stock <= 0;
            return (
              <div
                key={item.id}
                className="flex items-center gap-3 bg-[#FEF2F2]/60 border border-[#FECACA] rounded-2xl px-4 py-3"
              >
                <div className="w-10 h-10 rounded-xl bg-white border border-[#FECACA] flex items-center justify-center shrink-0">
                  <Package className="w-4 h-4 text-[#DC2626]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-[#000000] leading-snug">{item.name}</p>
                  {item.category && (
                    <p className="text-xs text-[#000000]/50 font-semibold truncate">{item.category}</p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <span
                    className={`inline-block text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full ${
                      isOut ? "bg-[#DC2626] text-white" : "bg-[#FFEDD5] text-[#C2410C]"
                    }`}
                  >
                    {item.stock} in stock
                  </span>
                  <p className="text-[10px] font-semibold text-[#000000]/45 mt-1">
                    Alert limit: {item.alertAt}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-6 py-5 flex items-center justify-between gap-4">
          <p className="text-[11px] font-semibold text-[#000000]/45 max-w-[180px]">
            Silences sound until the next new low-stock item.
          </p>
          <button
            type="button"
            autoFocus
            onClick={acknowledge}
            className="inline-flex items-center gap-2 bg-[#DC2626] hover:bg-[#B91C1C] text-white text-sm font-black px-6 py-3.5 rounded-2xl shadow-lg cursor-pointer transition-colors"
          >
            <VolumeX className="w-4 h-4" />
            {hasNewItems ? "Silence Alarm & Acknowledge" : "Acknowledge"}
          </button>
        </div>
      </div>
    </div>
  );
}
