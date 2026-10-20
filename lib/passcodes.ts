import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { sql } from './db';
import { ensureSchema } from './schema';
import { DEFAULT_STAFF_PANELS, sanitizePanels, type PosPanel } from './posAccess';

export type PosRole = 'admin' | 'staff';

/**
 * POS login passcodes. Once changed from Settings they live in app_meta as
 * salted scrypt hashes; until then the ADMIN_PASSCODE / STAFF_PASSCODE env
 * vars (or the built-in admin123 / staff123) apply.
 */
const META_KEY: Record<PosRole, string> = {
  admin: 'admin_passcode_hash',
  staff: 'staff_passcode_hash',
};

const envPasscode = (role: PosRole): string =>
  role === 'admin'
    ? process.env.ADMIN_PASSCODE || 'admin123'
    : process.env.STAFF_PASSCODE || process.env.NEXT_PUBLIC_STAFF_PASSCODE || 'staff123';

/** Whitespace is ignored at login, so it is stripped everywhere. */
export const normalizePasscode = (code: string): string => (code || '').replace(/\s/g, '');

function hashPasscode(code: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(code, salt, 32);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function matchesHash(code: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(code, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

async function storedHashes(): Promise<Partial<Record<PosRole, string>>> {
  await ensureSchema();
  const rows = (await sql`
    SELECT key, value FROM app_meta WHERE key IN (${META_KEY.admin}, ${META_KEY.staff})
  `) as { key: string; value: string }[];
  const out: Partial<Record<PosRole, string>> = {};
  for (const row of rows) {
    if (row.key === META_KEY.admin) out.admin = row.value;
    if (row.key === META_KEY.staff) out.staff = row.value;
  }
  return out;
}

/** Which role this passcode opens, if any. Admin wins if both somehow match. */
export async function roleForPasscode(entered: string): Promise<PosRole | null> {
  const code = normalizePasscode(entered);
  if (!code) return null;
  const hashes = await storedHashes();
  for (const role of ['admin', 'staff'] as const) {
    const stored = hashes[role];
    if (stored ? matchesHash(code, stored) : code === envPasscode(role)) return role;
  }
  return null;
}

export async function setPasscode(role: PosRole, code: string): Promise<void> {
  await ensureSchema();
  await sql`
    INSERT INTO app_meta (key, value) VALUES (${META_KEY[role]}, ${hashPasscode(normalizePasscode(code))})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

/* ── Per-staff logins and panel access ───────────────────────────── */

const DEFAULT_PANELS_KEY = 'staff_default_panels';

export type PosLogin =
  | { role: 'admin' }
  | {
      role: 'staff';
      staffId: string | null; // null = signed in with the shared staff passcode
      staffName: string | null;
      panels: PosPanel[];
    };

type StaffLoginRow = {
  id: string;
  name: string;
  pos_passcode_hash: string | null;
  pos_panels: string[] | null;
};

/** Panels for the shared staff passcode (and staff with no panels of their own). */
export async function defaultStaffPanels(): Promise<PosPanel[]> {
  await ensureSchema();
  const rows = (await sql`SELECT value FROM app_meta WHERE key = ${DEFAULT_PANELS_KEY}`) as {
    value: string;
  }[];
  if (rows.length === 0) return DEFAULT_STAFF_PANELS;
  try {
    return sanitizePanels(JSON.parse(rows[0].value));
  } catch {
    return DEFAULT_STAFF_PANELS;
  }
}

export async function setDefaultStaffPanels(panels: PosPanel[]): Promise<void> {
  await ensureSchema();
  await sql`
    INSERT INTO app_meta (key, value) VALUES (${DEFAULT_PANELS_KEY}, ${JSON.stringify(sanitizePanels(panels))})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

/** Staff who can sign in: active, POS access switched on, and a passcode set. */
async function activeStaffLogins(): Promise<StaffLoginRow[]> {
  await ensureSchema();
  return (await sql`
    SELECT id, name, pos_passcode_hash, pos_panels FROM staff
    WHERE is_active = true AND pos_enabled = true AND pos_passcode_hash IS NOT NULL
  `) as StaffLoginRow[];
}

/** Every stored staff passcode, signed-in-able or not (for uniqueness checks). */
async function allStaffPasscodes(): Promise<StaffLoginRow[]> {
  await ensureSchema();
  return (await sql`
    SELECT id, name, pos_passcode_hash, pos_panels FROM staff WHERE pos_passcode_hash IS NOT NULL
  `) as StaffLoginRow[];
}

const staffPanels = (row: { pos_panels: string[] | null }, fallback: PosPanel[]): PosPanel[] =>
  row.pos_panels === null ? fallback : sanitizePanels(row.pos_panels);

/**
 * Who this passcode signs in: the admin, a staff member with their own
 * passcode, or the shared staff passcode.
 */
export async function loginForPasscode(entered: string): Promise<PosLogin | null> {
  const code = normalizePasscode(entered);
  if (!code) return null;
  if ((await roleForPasscode(code)) === 'admin') return { role: 'admin' };
  const fallback = await defaultStaffPanels();
  for (const row of await activeStaffLogins()) {
    if (row.pos_passcode_hash && matchesHash(code, row.pos_passcode_hash)) {
      return { role: 'staff', staffId: row.id, staffName: row.name, panels: staffPanels(row, fallback) };
    }
  }
  if ((await roleForPasscode(code)) === 'staff') {
    return { role: 'staff', staffId: null, staffName: null, panels: fallback };
  }
  return null;
}

/**
 * Who already uses this passcode, so one code never opens two logins.
 * `except` skips the login being changed.
 */
export async function passcodeOwner(
  entered: string,
  except: { role?: PosRole; staffId?: string },
): Promise<string | null> {
  const code = normalizePasscode(entered);
  const role = await roleForPasscode(code);
  if (role && role !== except.role) return role === 'admin' ? 'the admin' : 'the shared staff passcode';
  for (const row of await allStaffPasscodes()) {
    if (row.id === except.staffId) continue;
    if (row.pos_passcode_hash && matchesHash(code, row.pos_passcode_hash)) return row.name;
  }
  return null;
}

/** Give a staff member their own passcode, or remove it (null). */
export async function setStaffPasscode(staffId: string, code: string | null): Promise<boolean> {
  await ensureSchema();
  const hash = code === null ? null : hashPasscode(normalizePasscode(code));
  const rows = await sql`UPDATE staff SET pos_passcode_hash = ${hash} WHERE id = ${staffId} RETURNING id`;
  return rows.length > 0;
}

export async function setStaffAccess(
  staffId: string,
  access: { enabled: boolean; panels: PosPanel[] },
): Promise<void> {
  await ensureSchema();
  await sql`
    UPDATE staff SET pos_enabled = ${access.enabled}, pos_panels = ${sanitizePanels(access.panels)}
    WHERE id = ${staffId}
  `;
}

export type StaffAccessRow = {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
  enabled: boolean; // admin's POS access switch
  hasPasscode: boolean;
  panels: PosPanel[];
};

/** Settings → Staff Access: every staff member's login status and panels (no hashes). */
export async function listStaffAccess(): Promise<{ defaultPanels: PosPanel[]; staff: StaffAccessRow[] }> {
  await ensureSchema();
  const defaultPanels = await defaultStaffPanels();
  const rows = (await sql`
    SELECT id, name, role, is_active, pos_enabled, pos_passcode_hash IS NOT NULL AS has_passcode, pos_panels
    FROM staff ORDER BY lower(name) ASC
  `) as {
    id: string;
    name: string;
    role: string;
    is_active: boolean;
    pos_enabled: boolean;
    has_passcode: boolean;
    pos_panels: string[] | null;
  }[];
  return {
    defaultPanels,
    staff: rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      isActive: r.is_active,
      enabled: r.pos_enabled,
      hasPasscode: r.has_passcode,
      panels: staffPanels(r, defaultPanels),
    })),
  };
}

/**
 * Re-check a signed-in staff session (on reload): their current panels, or
 * null when the login no longer works (staff removed or deactivated, POS
 * access switched off, or passcode removed), which signs them out.
 */
export async function currentStaffAccess(
  staffId: string | null,
): Promise<{ staffName: string | null; panels: PosPanel[] } | null> {
  const fallback = await defaultStaffPanels();
  if (!staffId) return { staffName: null, panels: fallback };
  const rows = (await sql`
    SELECT name, pos_panels FROM staff
    WHERE id = ${staffId} AND is_active = true AND pos_enabled = true AND pos_passcode_hash IS NOT NULL
  `) as { name: string; pos_panels: string[] | null }[];
  if (rows.length === 0) return null;
  return { staffName: rows[0].name, panels: staffPanels(rows[0], fallback) };
}
