"use client";

import React, { useState } from "react";
import {
  Settings2,
  Store,
  User,
  Phone,
  Mail,
  MapPin,
  Clock,
  Camera,
  Scissors,
  Hash,
  ImageIcon,
  Upload,
  Trash2,
  Save,
  Loader2,
  Check,
  AlertCircle,
  Palette,
  Lock,
  KeyRound,
  Eye,
  EyeOff,
  Users,
} from "lucide-react";
import type { ShopSettings } from "@/lib/types";
import {
  updateShopSettings,
  changePasscode,
  changeStaffPasscode,
  fetchStaffAccess,
  saveStaffAccess,
} from "@/app/pos/actions";
import { POS_PANELS, sanitizePanels, type PosPanel } from "@/lib/posAccess";
import type { StaffAccessRow } from "@/lib/passcodes";

type PasscodeRole = "admin" | "staff";

import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  accentCssVars,
  isLightColor,
  normalizeHex,
} from "@/lib/shopProfile";

const MAX_LOGO_EDGE = 512;

interface SettingsPanelProps {
  shop: ShopSettings;
  onSaved: (settings: ShopSettings) => void;
}

const inputCls =
  "w-full bg-white border border-[#000000]/15 rounded-lg px-3 py-2.5 text-sm font-semibold text-[#000000] placeholder:text-[#000000]/30 focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 transition-colors";

const labelCls =
  "block text-[10px] font-extrabold uppercase tracking-widest text-[#000000]/50 mb-1.5";

/** Downscale + re-encode an uploaded image so the stored data URL stays small. */
const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("That file is not a valid image."));
      image.onload = () => {
        const scale = Math.min(1, MAX_LOGO_EDGE / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Image processing is not supported here."));
          return;
        }
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });

/* ── Labelled field helpers ──────────────────────────────────────── */

function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  icon,
  className = "",
  mono = false,
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  icon?: React.ReactNode;
  className?: string;
  mono?: boolean;
  inputMode?: "text" | "tel" | "email" | "url" | "numeric";
}) {
  return (
    <div className={className}>
      <label className={labelCls} htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        {icon && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#000000]/30 pointer-events-none">
            {icon}
          </span>
        )}
        <input
          id={id}
          value={value}
          inputMode={inputMode}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`${inputCls} ${icon ? "pl-9" : ""} ${mono ? "font-mono" : ""}`}
        />
      </div>
    </div>
  );
}

function TextAreaField({
  id,
  label,
  value,
  onChange,
  placeholder,
  icon,
  className = "",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className={labelCls} htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        {icon && (
          <span className="absolute left-3 top-3 text-[#000000]/30 pointer-events-none">
            {icon}
          </span>
        )}
        <textarea
          id={id}
          rows={2}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`${inputCls} ${icon ? "pl-9" : ""} resize-none`}
        />
      </div>
    </div>
  );
}

/* ── Accent colour picker ───────────────────────────────────────── */

/**
 * Picks the single accent colour used across the entire app. Selecting a swatch
 * applies the derived CSS variables to <html> immediately (live preview) so the
 * admin sees the whole POS — and any open invoice tab — repaint before saving.
 */
function ThemePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex: string) => void;
}) {
  const current = normalizeHex(value) || DEFAULT_ACCENT;
  const [custom, setCustom] = React.useState(current);

  // Keep the hex box in sync when a preset is chosen.
  React.useEffect(() => {
    setCustom(current);
  }, [current]);

  const previewVars = accentCssVars(current) as React.CSSProperties;

  const commitCustom = (raw: string) => {
    setCustom(raw);
    const normalized = normalizeHex(raw);
    if (normalized) onChange(normalized);
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        {ACCENT_PRESETS.map((preset) => {
          const active = normalizeHex(preset) === current;
          return (
            <button
              key={preset}
              type="button"
              title={preset}
              aria-label={`Use accent ${preset}`}
              aria-pressed={active}
              onClick={() => onChange(preset)}
              style={{ backgroundColor: preset }}
              className={`w-7 h-7 rounded-md transition-transform cursor-pointer ${
                active
                  ? "ring-2 ring-offset-2 ring-[var(--accent)] scale-110"
                  : "hover:scale-110"
              }`}
            />
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label
          className="relative w-11 h-9 rounded-lg overflow-hidden border border-[#000000]/15 cursor-pointer shrink-0"
          style={{ backgroundColor: current }}
          title="Pick a custom colour"
        >
          <input
            type="color"
            value={current}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            aria-label="Custom accent colour"
          />
        </label>
        <input
          value={custom}
          onChange={(e) => commitCustom(e.target.value)}
          placeholder="#C50303"
          spellCheck={false}
          className="w-32 bg-white border border-[#000000]/15 rounded-lg px-3 py-2 text-sm font-mono font-semibold text-[#000000] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 transition-colors"
        />
        <button
          type="button"
          onClick={() => onChange(DEFAULT_ACCENT)}
          className="text-[10px] font-extrabold uppercase tracking-wider text-[#000000]/50 hover:text-[var(--accent)] underline underline-offset-2 cursor-pointer transition-colors"
        >
          Reset
        </button>
      </div>

      {/* Live preview card */}
      <div
        style={previewVars}
        className="mt-4 rounded-xl overflow-hidden border border-[#000000]/10"
      >
        <div className="p-4 text-center" style={{ backgroundColor: current, color: isLightColor(current) ? "#1C1917" : "#FFFFFF" }}>
          <p className="text-sm font-black uppercase tracking-tight">Card Preview</p>
          <p className="text-[10px] font-semibold opacity-80 mt-0.5">
            Buttons, links, totals and invoice headers use this colour.
          </p>
        </div>
        <div className="bg-white p-3 flex items-center gap-2">
          <span
            className="px-3 py-1.5 rounded-md text-[10px] font-extrabold uppercase tracking-wider"
            style={{ backgroundColor: current, color: isLightColor(current) ? "#1C1917" : "#FFFFFF" }}
          >
            Button
          </span>
          <span className="text-[10px] font-bold" style={{ color: current }}>
            Accent link
          </span>
          <span
            className="ml-auto text-[10px] font-extrabold px-2.5 py-1 rounded-md"
            style={{ backgroundColor: `color-mix(in srgb, ${current} 14%, #FFFFFF)`, color: current }}
          >
            Total ₹1,250
          </span>
        </div>
      </div>
    </div>
  );
}

export default function SettingsPanel({
  shop,
  onSaved,
}: SettingsPanelProps) {
  const [form, setForm] = useState<ShopSettings>(shop);
  const [status, setStatus] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const logoInputRef = React.useRef<HTMLInputElement | null>(null);

  const setField = <K extends keyof ShopSettings>(key: K, value: ShopSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setStatus(null);
  };

  /**
   * Live theme preview: write the derived accent variables onto <html> the moment
   * a colour is picked, so the admin sees the entire POS repaint instantly. The
   * persisted value only changes on Save.
   */
  // Leaving Settings repaints with the saved colour (updated by onSaved). The
  // server-injected vars live on the same inline style, so removing them would
  // drop the page back to the globals.css fallback until the next reload.
  const savedAccentRef = React.useRef(shop.accent_color);
  React.useEffect(() => {
    savedAccentRef.current = shop.accent_color;
  }, [shop.accent_color]);

  React.useEffect(() => {
    const root = document.documentElement;
    const apply = (accent: string) =>
      Object.entries(accentCssVars(accent)).forEach(([key, value]) =>
        root.style.setProperty(key, value),
      );
    apply(form.accent_color);
    return () => apply(savedAccentRef.current);
  }, [form.accent_color]);

  const handleLogoPick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setStatus({ tone: "err", text: "Please choose an image file (PNG or JPG)." });
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      setField("logo_data_url", dataUrl);
      setStatus({ tone: "ok", text: "Logo updated — remember to save your changes." });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    }
  };

  const handleSave = async () => {
    if (isSaving) return;
    if (!form.shop_name.trim()) {
      setStatus({ tone: "err", text: "Shop name is required." });
      return;
    }
    setIsSaving(true);
    setStatus(null);
    try {
      const saved = await updateShopSettings(form);
      setForm(saved);
      onSaved(saved);
      setStatus({ tone: "ok", text: "Shop details saved." });
    } catch (err) {
      console.error("Failed to save shop settings:", err);
      setStatus({ tone: "err", text: "Could not save settings. Please try again." });
    } finally {
      setIsSaving(false);
    }
  };

  const logoPreview = form.logo_data_url || "/logo.png";

  return (
    <div className="flex-1 flex flex-col max-w-[1400px] mx-auto w-full pb-8 pr-2 animate-in fade-in duration-300 gap-6">
      <div className="bg-[#FFFFFF] border border-[#000000]/10 rounded-2xl px-5 py-4 flex items-center gap-3 shadow-sm">
        <div className="w-9 h-9 rounded-xl bg-[var(--accent)] text-white flex items-center justify-center shrink-0">
          <Settings2 className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-sm font-black text-[#000000] uppercase tracking-tight">
            Shop Settings
          </h2>
          <p className="text-[10px] text-[#000000]/50 font-semibold">
            Update the shop profile, logo, login passcodes and staff access. Products are
            managed in Inventory.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
        {/* Appearance / theme */}
        <div className="bg-[#FFFFFF] border border-[#000000]/10 rounded-2xl p-5 sm:p-6 shadow-sm">
          <h3 className="text-xs font-black uppercase tracking-widest text-[var(--accent)] flex items-center gap-2 mb-1">
            <Palette className="w-4 h-4" /> Appearance
          </h3>
          <p className="text-[10px] text-[#000000]/50 font-semibold mb-5">
            One accent colour drives the whole app — POS, storefront, invoices,
            receipts and the installed app.
          </p>
          <ThemePicker
            value={form.accent_color}
            onChange={(v) => setField("accent_color", v)}
          />
        </div>

        {/* ── Shop profile ─────────────────────────────────────────── */}
        <div className="bg-[#FFFFFF] border border-[#000000]/10 rounded-2xl p-5 sm:p-6 shadow-sm">
          <h3 className="text-xs font-black uppercase tracking-widest text-[var(--accent)] flex items-center gap-2 mb-5">
            <Store className="w-4 h-4" /> Shop Profile
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <TextField
              id="set-owner"
              label="Shop Owner Name"
              icon={<User className="w-3.5 h-3.5" />}
              value={form.owner_name}
              placeholder="Maha Gowtham"
              onChange={(v) => setField("owner_name", v)}
            />
            <TextField
              id="set-shop"
              label="Shop Name"
              icon={<Store className="w-3.5 h-3.5" />}
              value={form.shop_name}
              placeholder="IGMOLS"
              onChange={(v) => setField("shop_name", v)}
            />
            <TextField
              id="set-tagline"
              label="Tagline / Sub-heading"
              value={form.tagline}
              placeholder="A short line under your shop name"
              onChange={(v) => setField("tagline", v)}
              className="sm:col-span-2"
            />
            <TextField
              id="set-phone"
              label="Contact Number"
              icon={<Phone className="w-3.5 h-3.5" />}
              value={form.phone}
              placeholder="8148094377"
              inputMode="tel"
              onChange={(v) => setField("phone", v)}
            />
            <TextField
              id="set-email"
              label="Email ID"
              icon={<Mail className="w-3.5 h-3.5" />}
              value={form.email}
              placeholder="shop@example.com"
              onChange={(v) => setField("email", v)}
            />
            <TextAreaField
              id="set-address"
              label="Shop Address"
              icon={<MapPin className="w-3.5 h-3.5" />}
              value={form.address}
              placeholder="34, Thiruvallur main road, pondavakkam, uthukottai, Thiruvallur - 602026"
              onChange={(v) => setField("address", v)}
              className="sm:col-span-2"
            />
            <TextField
              id="set-location"
              label="City / Location"
              value={form.location}
              placeholder="Thiruvallur, Tamil Nadu"
              onChange={(v) => setField("location", v)}
            />
            <TextField
              id="set-hours"
              label="Business Hours"
              icon={<Clock className="w-3.5 h-3.5" />}
              value={form.business_hours}
              placeholder="Open Daily"
              onChange={(v) => setField("business_hours", v)}
            />
            <TextField
              id="set-instagram"
              label="Instagram Link"
              icon={<Camera className="w-3.5 h-3.5" />}
              value={form.instagram_url}
              placeholder="https://www.instagram.com/yourhandle"
              onChange={(v) => setField("instagram_url", v)}
              className="sm:col-span-2"
            />
            <TextAreaField
              id="set-services"
              label="Catalogue Headline / Services"
              icon={<Scissors className="w-3.5 h-3.5" />}
              value={form.services}
              placeholder="What you sell, separated by •"
              onChange={(v) => setField("services", v)}
              className="sm:col-span-2"
            />
            <TextField
              id="set-gstin"
              label="GSTIN (on GST invoices)"
              icon={<Hash className="w-3.5 h-3.5" />}
              value={form.gstin}
              placeholder="Optional"
              mono
              onChange={(v) => setField("gstin", v)}
            />
          </div>

          {/* Logo uploader */}
          <div className="mt-6 pt-5 border-t border-[#000000]/10">
            <p className={`${labelCls} flex items-center gap-1.5`}>
              <ImageIcon className="w-3.5 h-3.5" /> Shop Logo
            </p>
            <div className="flex items-center gap-4">
              <div className="w-20 h-20 rounded-2xl bg-white border border-[var(--accent)]/30 shadow-sm flex items-center justify-center p-2 shrink-0">
                <img
                  src={logoPreview}
                  alt="Shop logo preview"
                  className="w-full h-full object-contain"
                />
              </div>
              <div className="flex flex-col gap-2 min-w-0">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => logoInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white text-[10px] font-extrabold uppercase tracking-wider px-3 py-2 rounded-lg cursor-pointer transition-colors"
                  >
                    <Upload className="w-3.5 h-3.5" /> Upload Logo
                  </button>
                  {form.logo_data_url && (
                    <button
                      type="button"
                      onClick={() => setField("logo_data_url", null)}
                      className="inline-flex items-center gap-1.5 bg-[#000000]/5 hover:bg-[#000000]/10 text-[#000000] text-[10px] font-extrabold uppercase tracking-wider px-3 py-2 rounded-lg cursor-pointer transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Reset Logo
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-[#000000]/45 font-semibold">
                  PNG or JPG, auto-resized to 512px. Used on the store page,
                  invoices, receipts and the installed app icon.
                </p>
              </div>
              <input
                ref={logoInputRef}
                type="file"
                accept="image/*"
                onChange={handleLogoPick}
                className="hidden"
              />
            </div>
          </div>

          {/* Save */}
          <div className="mt-6 pt-5 border-t border-[#000000]/10 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="inline-flex items-center gap-2 bg-[#000000] hover:bg-[#000000]/85 disabled:opacity-50 text-white text-[11px] font-extrabold uppercase tracking-wider px-4 py-2.5 rounded-lg cursor-pointer transition-colors"
            >
              {isSaving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              {isSaving ? "Saving..." : "Save Shop Details"}
            </button>
            {status && (
              <span
                className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${
                  status.tone === "ok" ? "text-[#15803D]" : "text-[#B91C1C]"
                }`}
              >
                {status.tone === "ok" ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <AlertCircle className="w-3.5 h-3.5" />
                )}
                {status.text}
              </span>
            )}
          </div>
        </div>

        <PasscodeSettings />

        <StaffAccessSettings />
      </div>
    </div>
  );
}

/* ── Staff access: which panels each login can open ──────────────── */

const SHARED_ROW = "__shared__";

function PanelToggles({
  value,
  onChange,
  disabled,
}: {
  value: PosPanel[];
  onChange: (next: PosPanel[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {POS_PANELS.map(({ key, label }) => {
        const on = value.includes(key);
        return (
          <button
            key={key}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() =>
              onChange(sanitizePanels(on ? value.filter((k) => k !== key) : [...value, key]))
            }
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider border transition-colors cursor-pointer disabled:opacity-50 ${
              on
                ? "bg-[var(--accent)] text-[var(--accent-on)] border-[var(--accent)]"
                : "bg-white text-[#000000]/55 border-[#000000]/15 hover:border-[var(--accent)]"
            }`}
          >
            {on && <Check className="w-3 h-3" />}
            {label}
          </button>
        );
      })}
    </div>
  );
}

function StaffAccessSettings() {
  const [loaded, setLoaded] = useState<{
    defaultPanels: PosPanel[];
    staff: StaffAccessRow[];
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  // Edited panels per row (SHARED_ROW = shared staff passcode); unsaved until Save.
  const [drafts, setDrafts] = useState<Record<string, PosPanel[]>>({});
  const [enabledDrafts, setEnabledDrafts] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const [adminCode, setAdminCode] = useState("");
  const [newCodes, setNewCodes] = useState<Record<string, string>>({});
  const [codeBusy, setCodeBusy] = useState<string | null>(null);
  const [codeStatus, setCodeStatus] = useState<{ id: string; tone: "ok" | "err"; text: string } | null>(
    null,
  );

  React.useEffect(() => {
    let cancelled = false;
    fetchStaffAccess()
      .then((data) => {
        if (cancelled) return;
        setLoaded(data);
        setLoadError(null);
      })
      .catch((err) => {
        console.error("Failed to load staff access:", err);
        if (!cancelled) setLoadError("Could not load staff. Check your connection.");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const panelsFor = (id: string, saved: PosPanel[]) => drafts[id] ?? saved;
  const enabledFor = (s: StaffAccessRow) => enabledDrafts[s.id] ?? s.enabled;
  const dirty = Object.keys(drafts).length > 0 || Object.keys(enabledDrafts).length > 0;

  const saveAccess = async () => {
    if (!loaded) return;
    setSaving(true);
    setStatus(null);
    try {
      const result = await saveStaffAccess({
        defaultPanels: panelsFor(SHARED_ROW, loaded.defaultPanels),
        staff: loaded.staff.map((s) => ({
          id: s.id,
          enabled: enabledFor(s),
          panels: panelsFor(s.id, s.panels),
        })),
      });
      if (!result.ok) {
        setStatus({ tone: "err", text: result.error });
        return;
      }
      setDrafts({});
      setEnabledDrafts({});
      setReloadTick((t) => t + 1);
      setStatus({ tone: "ok", text: "Access saved. Staff see changes next time the POS loads." });
    } catch (err) {
      console.error("Failed to save staff access:", err);
      setStatus({ tone: "err", text: "Could not save. Check your connection and try again." });
    } finally {
      setSaving(false);
    }
  };

  const savePasscode = async (staffId: string, remove: boolean) => {
    const fail = (text: string) => setCodeStatus({ id: staffId, tone: "err", text });
    if (!adminCode.trim()) return fail("Enter the admin passcode above first.");
    const next = (newCodes[staffId] || "").trim();
    if (!remove && !next) return fail("Type the new passcode.");
    setCodeBusy(staffId);
    try {
      const result = await changeStaffPasscode({
        staffId,
        currentAdminPasscode: adminCode,
        newPasscode: remove ? null : next,
      });
      if (!result.ok) return fail(result.error);
      setNewCodes((prev) => ({ ...prev, [staffId]: "" }));
      setCodeStatus({
        id: staffId,
        tone: "ok",
        text: remove ? "Own passcode removed." : "Passcode saved.",
      });
      setReloadTick((t) => t + 1);
    } catch (err) {
      console.error("Failed to set staff passcode:", err);
      fail("Could not save. Check your connection and try again.");
    } finally {
      setCodeBusy(null);
    }
  };

  return (
    <div className="bg-[#FFFFFF] border border-[#000000]/10 rounded-2xl p-5 sm:p-6 shadow-sm xl:col-span-2">
      <h3 className="text-xs font-black uppercase tracking-widest text-[var(--accent)] flex items-center gap-2 mb-1">
        <Users className="w-4 h-4" /> Staff Access
      </h3>
      <p className="text-[10px] text-[#000000]/50 font-semibold mb-5">
        Switch on POS access for each staff member, give them their own passcode, and choose the
        panels they see. Staff without their own login use the shared staff passcode and its
        panels. Remember to press Save Access. Settings always stays admin-only.
      </p>

      {loadError ? (
        <p className="text-xs font-bold text-[#B91C1C]">{loadError}</p>
      ) : !loaded ? (
        <p className="text-xs font-semibold text-[#000000]/50 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading staff…
        </p>
      ) : (
        <>
          <div className="max-w-sm mb-5">
            <PasscodeField
              id="access-admin-code"
              label="Admin Passcode (needed to set staff passcodes)"
              value={adminCode}
              onChange={(v) => {
                setAdminCode(v);
                setCodeStatus(null);
              }}
              show={false}
              autoComplete="current-password"
            />
          </div>

          <div className="divide-y divide-[#000000]/10 border-y border-[#000000]/10">
            <div className="py-4">
              <p className="text-[11px] font-black uppercase tracking-wider text-[#000000]">
                Shared Staff Passcode
              </p>
              <p className="text-[10px] text-[#000000]/50 font-semibold mb-2.5">
                Anyone signing in with the shared staff passcode. Also the starting panels for staff
                you haven&apos;t customised.
              </p>
              <PanelToggles
                value={panelsFor(SHARED_ROW, loaded.defaultPanels)}
                onChange={(next) => {
                  setDrafts((prev) => ({ ...prev, [SHARED_ROW]: next }));
                  setStatus(null);
                }}
              />
            </div>

            {loaded.staff.length === 0 && (
              <p className="py-4 text-[11px] font-semibold text-[#000000]/55">
                No staff yet. Add staff in Attendance → Staff, then give each one a passcode and
                panels here.
              </p>
            )}

            {loaded.staff.map((s) => {
              const enabled = enabledFor(s);
              const canSignIn = s.isActive && enabled && s.hasPasscode;
              return (
              <div key={s.id} className="py-4">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={`POS access for ${s.name}`}
                    onClick={() => {
                      setEnabledDrafts((prev) => ({ ...prev, [s.id]: !enabled }));
                      setStatus(null);
                    }}
                    className={`relative w-9 h-5 rounded-full shrink-0 transition-colors cursor-pointer ${
                      enabled ? "bg-[var(--accent)]" : "bg-[#000000]/20"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                        enabled ? "translate-x-4" : ""
                      }`}
                    />
                  </button>
                  <p className="text-[11px] font-black uppercase tracking-wider text-[#000000]">
                    {s.name}
                  </p>
                  {s.role && (
                    <span className="text-[10px] font-semibold text-[#000000]/45">{s.role}</span>
                  )}
                  <span
                    className={`text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border ${
                      canSignIn
                        ? "text-[#15803D] border-[#15803D]/30 bg-[#15803D]/5"
                        : !s.isActive || !enabled
                          ? "text-[#000000]/45 border-[#000000]/15"
                          : "text-[#B45309] border-[#B45309]/30 bg-[#B45309]/5"
                    }`}
                  >
                    {!s.isActive
                      ? "Inactive staff"
                      : !enabled
                        ? "POS access off"
                        : s.hasPasscode
                          ? "Can sign in"
                          : "Needs a passcode"}
                  </span>
                </div>
                {s.isActive && enabled && !s.hasPasscode && (
                  <p className="text-[10px] text-[#B45309] font-semibold mb-2">
                    Set a passcode below so {s.name} can sign in with these panels.
                  </p>
                )}
                {s.isActive && !enabled && (
                  <p className="text-[10px] text-[#000000]/50 font-semibold mb-2">
                    Switch on to let {s.name} sign in with their own passcode.
                  </p>
                )}
                <div className={`mt-2 ${enabled ? "" : "opacity-50"}`}>
                  <PanelToggles
                    disabled={!enabled}
                    value={panelsFor(s.id, s.panels)}
                    onChange={(next) => {
                      setDrafts((prev) => ({ ...prev, [s.id]: next }));
                      setStatus(null);
                    }}
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    autoComplete="new-password"
                    aria-label={`New passcode for ${s.name}`}
                    placeholder={s.hasPasscode ? "New passcode" : "Set a passcode"}
                    value={newCodes[s.id] || ""}
                    onChange={(e) => {
                      setNewCodes((prev) => ({ ...prev, [s.id]: e.target.value }));
                      setCodeStatus(null);
                    }}
                    className={`${inputCls} font-mono max-w-[200px] py-2`}
                  />
                  <button
                    type="button"
                    onClick={() => savePasscode(s.id, false)}
                    disabled={codeBusy !== null}
                    className="inline-flex items-center gap-1.5 bg-[#000000] hover:bg-[#000000]/85 disabled:opacity-50 text-white text-[10px] font-extrabold uppercase tracking-wider px-3 py-2 rounded-lg cursor-pointer transition-colors"
                  >
                    {codeBusy === s.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <KeyRound className="w-3.5 h-3.5" />
                    )}
                    {s.hasPasscode ? "Change" : "Set"} Passcode
                  </button>
                  {s.hasPasscode && (
                    <button
                      type="button"
                      onClick={() => savePasscode(s.id, true)}
                      disabled={codeBusy !== null}
                      className="text-[10px] font-bold uppercase tracking-wider text-[#B91C1C] hover:underline px-2 py-2 cursor-pointer disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                  {codeStatus?.id === s.id && (
                    <span
                      role="status"
                      className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${
                        codeStatus.tone === "ok" ? "text-[#15803D]" : "text-[#B91C1C]"
                      }`}
                    >
                      {codeStatus.tone === "ok" ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <AlertCircle className="w-3.5 h-3.5" />
                      )}
                      {codeStatus.text}
                    </span>
                  )}
                </div>
              </div>
              );
            })}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={saveAccess}
              disabled={saving || !dirty}
              className="inline-flex items-center gap-2 bg-[#000000] hover:bg-[#000000]/85 disabled:opacity-50 text-white text-[11px] font-extrabold uppercase tracking-wider px-4 py-2.5 rounded-lg cursor-pointer transition-colors"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save Access
            </button>
            {dirty && !status && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#B45309]">
                Unsaved changes
              </span>
            )}
            {status && (
              <span
                role="status"
                className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${
                  status.tone === "ok" ? "text-[#15803D]" : "text-[#B91C1C]"
                }`}
              >
                {status.tone === "ok" ? <Check className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                {status.text}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Login passcodes (admin / staff) ─────────────────────────────── */

function PasscodeField({
  id,
  label,
  value,
  onChange,
  show,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  show: boolean;
  autoComplete: "current-password" | "new-password";
}) {
  return (
    <div>
      <label className={labelCls} htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#000000]/30 pointer-events-none">
          <KeyRound className="w-3.5 h-3.5" />
        </span>
        <input
          id={id}
          type={show ? "text" : "password"}
          value={value}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputCls} pl-9 font-mono`}
        />
      </div>
    </div>
  );
}

function PasscodeSettings() {
  const [current, setCurrent] = useState("");
  const [show, setShow] = useState(false);
  const [drafts, setDrafts] = useState<Record<PasscodeRole, { next: string; confirm: string }>>({
    admin: { next: "", confirm: "" },
    staff: { next: "", confirm: "" },
  });
  const [busy, setBusy] = useState<PasscodeRole | null>(null);
  const [status, setStatus] = useState<{ role: PasscodeRole; tone: "ok" | "err"; text: string } | null>(
    null,
  );

  const setDraft = (role: PasscodeRole, field: "next" | "confirm", value: string) => {
    setDrafts((prev) => ({ ...prev, [role]: { ...prev[role], [field]: value } }));
    setStatus(null);
  };

  const save = async (role: PasscodeRole) => {
    const { next, confirm } = drafts[role];
    const fail = (text: string) => setStatus({ role, tone: "err", text });
    if (!current.trim()) return fail("Enter the current admin passcode first.");
    if (!next.trim()) return fail("Enter the new passcode.");
    if (next.replace(/\s/g, "") !== confirm.replace(/\s/g, "")) {
      return fail("The new passcode and confirmation don't match.");
    }
    setBusy(role);
    try {
      const result = await changePasscode({
        role,
        currentAdminPasscode: current,
        newPasscode: next,
      });
      if (!result.ok) return fail(result.error);
      setDrafts((prev) => ({ ...prev, [role]: { next: "", confirm: "" } }));
      // After changing the admin passcode, the old one no longer works.
      if (role === "admin") setCurrent("");
      setStatus({
        role,
        tone: "ok",
        text: role === "admin" ? "Admin passcode changed." : "Staff passcode changed.",
      });
    } catch (err) {
      console.error("Failed to change passcode:", err);
      fail("Could not save. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-[#FFFFFF] border border-[#000000]/10 rounded-2xl p-5 sm:p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3 mb-1">
        <h3 className="text-xs font-black uppercase tracking-widest text-[var(--accent)] flex items-center gap-2">
          <Lock className="w-4 h-4" /> Login Passcodes
        </h3>
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[#000000]/60 hover:text-[var(--accent)] cursor-pointer"
        >
          {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          {show ? "Hide" : "Show"}
        </button>
      </div>
      <p className="text-[10px] text-[#000000]/50 font-semibold mb-5">
        Change the passcodes used to sign in to the POS. Every change needs the current admin
        passcode. People already signed in stay signed in.
      </p>

      <PasscodeField
        id="pass-current"
        label="Current Admin Passcode"
        value={current}
        onChange={(v) => {
          setCurrent(v);
          setStatus(null);
        }}
        show={show}
        autoComplete="current-password"
      />

      {(
        [
          { role: "admin", title: "Admin Passcode", hint: "Full access, including Settings and reports." },
          {
            role: "staff",
            title: "Shared Staff Passcode",
            hint: "For staff without their own passcode. Their panels are set in Staff Access.",
          },
        ] as const
      ).map(({ role, title, hint }) => (
        <div key={role} className="mt-5 pt-5 border-t border-[#000000]/10">
          <p className="text-[11px] font-black uppercase tracking-wider text-[#000000]">
            New {title}
          </p>
          <p className="text-[10px] text-[#000000]/50 font-semibold mb-3">{hint}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <PasscodeField
              id={`pass-${role}-new`}
              label="New Passcode"
              value={drafts[role].next}
              onChange={(v) => setDraft(role, "next", v)}
              show={show}
              autoComplete="new-password"
            />
            <PasscodeField
              id={`pass-${role}-confirm`}
              label="Confirm New Passcode"
              value={drafts[role].confirm}
              onChange={(v) => setDraft(role, "confirm", v)}
              show={show}
              autoComplete="new-password"
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => save(role)}
              disabled={busy !== null}
              className="inline-flex items-center gap-2 bg-[#000000] hover:bg-[#000000]/85 disabled:opacity-50 text-white text-[11px] font-extrabold uppercase tracking-wider px-4 py-2.5 rounded-lg cursor-pointer transition-colors"
            >
              {busy === role ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              Change {role === "admin" ? "Admin" : "Staff"} Passcode
            </button>
            {status?.role === role && (
              <span
                role="status"
                className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${
                  status.tone === "ok" ? "text-[#15803D]" : "text-[#B91C1C]"
                }`}
              >
                {status.tone === "ok" ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <AlertCircle className="w-3.5 h-3.5" />
                )}
                {status.text}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
