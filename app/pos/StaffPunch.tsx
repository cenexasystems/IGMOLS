"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Loader2, LogIn, LogOut, CheckCircle2 } from "lucide-react";
import type { AttendanceRecord, Staff } from "@/lib/types";
import { clockInStaff, clockOutStaff, fetchAttendance, fetchStaff } from "@/app/pos/actions";
import { formatTime, todayIST } from "./AttendancePanel";

type Screen =
  | { kind: "list" }
  | { kind: "detail"; staffId: string }
  | { kind: "done"; staffId: string; action: "in" | "out"; at: string };

const fullDate = (d: Date) =>
  d.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });

const clockTime = (d: Date) =>
  d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });

function Avatar({ name, size }: { name: string; size: "sm" | "lg" }) {
  return (
    <span
      className={`rounded-2xl bg-[#FDECE3] text-[var(--accent)] font-black uppercase flex items-center justify-center shrink-0 ${
        size === "lg" ? "w-20 h-20 text-4xl" : "w-14 h-14 text-2xl"
      }`}
    >
      {name.trim().charAt(0) || "?"}
    </span>
  );
}

/** Staff-facing punch in / punch out kiosk for today. */
export default function StaffPunch() {
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [loaded, setLoaded] = useState<{ date: string; records: AttendanceRecord[] } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [isSaving, setIsSaving] = useState(false);

  const today = todayIST();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Reload whenever the day rolls over (the kiosk may stay open overnight).
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchStaff(), fetchAttendance(today, today)])
      .then(([staffRows, records]) => {
        if (cancelled) return;
        setStaff(staffRows.filter((s) => s.is_active));
        setLoaded({ date: today, records });
      })
      .catch((err) => {
        console.error("Failed to load attendance:", err);
        alert("Could not load staff attendance. Please try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [today]);

  const recordFor = useMemo(() => {
    const map = new Map<string, AttendanceRecord>();
    if (loaded?.date === today) for (const r of loaded.records) map.set(r.staff_id, r);
    return map;
  }, [loaded, today]);

  const punch = async (s: Staff, action: "in" | "out") => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      if (action === "in") await clockInStaff(s.id, today);
      else await clockOutStaff(s.id, today);
      const records = await fetchAttendance(today, today);
      setLoaded({ date: today, records });
      const record = records.find((r) => r.staff_id === s.id);
      const at = (action === "in" ? record?.clock_in : record?.clock_out) ?? new Date().toISOString();
      setScreen({ kind: "done", staffId: s.id, action, at });
    } catch (err) {
      console.error("Punch failed:", err);
      alert("Could not record your punch. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  if (!staff) {
    return (
      <div className="flex-1 flex items-center justify-center py-20 text-[#000000]/50">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  const selected =
    screen.kind !== "list" ? staff.find((s) => s.id === screen.staffId) ?? null : null;

  if (screen.kind === "done" && selected) {
    const isIn = screen.action === "in";
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center py-16 animate-in fade-in duration-300">
        <div
          className={`w-24 h-24 rounded-full flex items-center justify-center mb-5 ${
            isIn ? "bg-[#DCFCE7] text-[#16A34A]" : "bg-[#FEE2E2] text-[#DC2626]"
          }`}
        >
          {isIn ? <LogIn className="w-10 h-10" /> : <LogOut className="w-10 h-10" />}
        </div>
        <h2 className="text-2xl font-black text-[#000000]">{isIn ? "Punched In!" : "Punched Out!"}</h2>
        <p className="text-base font-bold text-[#000000]/55 mt-1">{selected.name}</p>
        <p className="text-lg font-black text-[var(--accent)] mt-1">{formatTime(screen.at)}</p>
        <p className="text-sm text-[#000000]/45 font-semibold mt-6">
          {isIn ? "Remember to punch out when you leave!" : "Have a good evening!"}
        </p>
        <button
          type="button"
          autoFocus
          onClick={() => setScreen({ kind: "list" })}
          className="mt-6 bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white font-bold px-9 py-3 rounded-xl cursor-pointer transition-colors"
        >
          Done
        </button>
      </div>
    );
  }

  if (screen.kind === "detail" && selected) {
    const record = recordFor.get(selected.id);
    const canPunchIn = !record?.clock_in;
    const canPunchOut = Boolean(record?.clock_in) && !record?.clock_out;
    return (
      <div className="flex-1 flex flex-col w-full max-w-[1400px] mx-auto animate-in fade-in duration-300">
        <button
          type="button"
          onClick={() => setScreen({ kind: "list" })}
          className="self-start inline-flex items-center gap-1 text-sm font-bold text-[var(--accent)] hover:underline cursor-pointer mb-6"
        >
          <ChevronLeft className="w-4 h-4" /> Back
        </button>
        <div className="w-full max-w-md mx-auto space-y-6">
          <div className="bg-white border border-[#000000]/10 rounded-2xl shadow-sm p-7 flex flex-col items-center text-center">
            <Avatar name={selected.name} size="lg" />
            <h2 className="text-3xl font-black text-[#000000] mt-4">{selected.name}</h2>
            {selected.role && (
              <p className="text-lg font-bold text-[#000000]/55">{selected.role}</p>
            )}
            <p className="text-sm text-[#000000]/45 font-semibold mt-2">{fullDate(now)}</p>
            {record?.clock_in && (
              <div className="mt-4 flex gap-6 text-sm font-bold">
                <span className="text-[#15803D]">In: {formatTime(record.clock_in)}</span>
                {record.clock_out && (
                  <span className="text-[#DC2626]">Out: {formatTime(record.clock_out)}</span>
                )}
              </div>
            )}
          </div>

          {canPunchIn || canPunchOut ? (
            <button
              type="button"
              disabled={isSaving}
              onClick={() => punch(selected, canPunchIn ? "in" : "out")}
              className={`w-full inline-flex items-center justify-center gap-3 text-white text-xl font-black uppercase py-5 rounded-2xl shadow-lg cursor-pointer transition-colors disabled:opacity-60 ${
                canPunchIn
                  ? "bg-[var(--accent)] hover:bg-[var(--accent-strong)]"
                  : "bg-[#DC2626] hover:bg-[#B91C1C]"
              }`}
            >
              {isSaving ? (
                <Loader2 className="w-6 h-6 animate-spin" />
              ) : canPunchIn ? (
                <LogIn className="w-6 h-6" />
              ) : (
                <LogOut className="w-6 h-6" />
              )}
              {canPunchIn ? "Punch In" : "Punch Out"}
            </button>
          ) : (
            <div className="w-full flex items-center justify-center gap-2 bg-[#DCFCE7] text-[#15803D] font-black uppercase py-5 rounded-2xl">
              <CheckCircle2 className="w-5 h-5" /> Shift complete for today
            </div>
          )}

          <button
            type="button"
            onClick={() => setScreen({ kind: "list" })}
            className="w-full text-sm font-bold text-[#000000]/55 hover:text-[#000000] cursor-pointer"
          >
            Back to staff list
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col w-full max-w-[1400px] mx-auto gap-5 animate-in fade-in duration-300">
      <div className="bg-white border border-[#000000]/10 rounded-2xl shadow-sm px-6 py-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <span className="block text-[10px] font-black uppercase tracking-widest text-[var(--accent)]">
            Attendance
          </span>
          <h2 className="text-xl sm:text-2xl font-black text-[#000000]">{fullDate(now)}</h2>
          <p className="text-sm text-[#000000]/55 font-semibold">Select your name to punch</p>
        </div>
        <span className="text-2xl sm:text-3xl font-black text-[var(--accent)] tabular-nums">
          {clockTime(now)}
        </span>
      </div>

      {staff.length === 0 ? (
        <p className="text-center text-sm text-[#000000]/50 font-semibold py-12">
          No staff have been added yet. Ask the admin to add staff under Attendance → Staff Management.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {staff.map((s) => {
            const record = recordFor.get(s.id);
            const badge = record?.clock_out
              ? { text: `Out ${formatTime(record.clock_out)}`, cls: "bg-[#FEE2E2] text-[#B91C1C]" }
              : record?.clock_in
                ? { text: `In ${formatTime(record.clock_in)}`, cls: "bg-[#DCFCE7] text-[#15803D]" }
                : null;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setScreen({ kind: "detail", staffId: s.id })}
                className="text-left bg-white border border-[#000000]/10 rounded-2xl shadow-sm p-5 hover:border-[var(--accent)]/50 hover:shadow-md transition-all cursor-pointer"
              >
                <div className="flex items-start justify-between gap-2">
                  <Avatar name={s.name} size="sm" />
                  {badge && (
                    <span className={`text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full ${badge.cls}`}>
                      {badge.text}
                    </span>
                  )}
                </div>
                <p className="text-base font-black text-[#000000] mt-4">{s.name}</p>
                <p className="text-xs font-semibold text-[#000000]/45">{s.role || "Staff"}</p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
