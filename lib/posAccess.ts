/**
 * POS panels an admin can grant to staff. Settings is deliberately not here:
 * whoever can open Settings can change everyone's access, so it stays admin-only.
 *
 * Shared by server and client (no server-only imports).
 */
export const POS_PANELS = [
  { key: 'billing', label: 'Billing Panel' },
  { key: 'advance', label: 'Advance Orders' },
  { key: 'orders', label: 'Order History' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'analytics', label: 'Analytics Dashboard' },
  { key: 'expenses', label: 'Expense Tracker' },
  { key: 'attendance', label: 'Attendance (punch in / out)' },
] as const;

export type PosPanel = (typeof POS_PANELS)[number]['key'];

/** What staff could see before per-staff access existed. */
export const DEFAULT_STAFF_PANELS: PosPanel[] = ['billing', 'advance', 'orders', 'attendance'];

/** Keep only known panels, in menu order, without duplicates. */
export const sanitizePanels = (value: unknown): PosPanel[] => {
  const wanted = new Set(Array.isArray(value) ? value.map(String) : []);
  return POS_PANELS.map((p) => p.key).filter((key) => wanted.has(key));
};
