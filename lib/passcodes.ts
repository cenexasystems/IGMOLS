import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { sql } from './db';
import { ensureSchema } from './schema';

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
