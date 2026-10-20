import { sql } from './db';

/**
 * Every idempotent table/column change the app has needed since schema.sql.
 *
 * These used to run one statement per round trip on every cold start (~30
 * sequential queries before the first page could load). Now a cold start does
 * a single version lookup, and only when SCHEMA_VERSION is newer than the
 * database's does it send the whole list in one transaction.
 *
 * Adding a migration: append statements to `migrations()` and bump
 * SCHEMA_VERSION. Statements must stay idempotent (IF NOT EXISTS etc.).
 */
const SCHEMA_VERSION = 1;

const migrations = () => [
  sql`
    CREATE TABLE IF NOT EXISTS app_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `,

  // Shop profile (single row).
  sql`
    CREATE TABLE IF NOT EXISTS shop_settings (
      id TEXT PRIMARY KEY,
      owner_name TEXT NOT NULL DEFAULT '',
      shop_name TEXT NOT NULL DEFAULT '',
      tagline TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      instagram_url TEXT NOT NULL DEFAULT '',
      business_hours TEXT NOT NULL DEFAULT '',
      services TEXT NOT NULL DEFAULT '',
      gstin TEXT NOT NULL DEFAULT '',
      logo_data_url TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  sql`ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS accent_color TEXT NOT NULL DEFAULT '#C50303'`,

  // Products / services, offers, Tamil name, barcode, variants.
  sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'PRODUCT'`,
  sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC NOT NULL DEFAULT 0`,
  sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS current_stock NUMERIC`,
  sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_alert NUMERIC`,
  sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_discount_pct NUMERIC NOT NULL DEFAULT 0`,
  sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_price NUMERIC`,
  sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`,
  sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS tamil_name TEXT`,
  sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode TEXT`,
  sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS has_variants BOOLEAN NOT NULL DEFAULT false`,
  sql`
    CREATE TABLE IF NOT EXISTS product_variants (
      id          TEXT PRIMARY KEY,
      product_id  TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      price       NUMERIC,
      cost_price  NUMERIC,
      stock       NUMERIC,
      barcode     TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  sql`CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants (product_id)`,

  // Invoice lines: offer snapshot and variant link (no FK, history survives deletes).
  sql`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS offer_pct NUMERIC NOT NULL DEFAULT 0`,
  sql`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS original_price NUMERIC`,
  sql`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_id TEXT`,
  sql`ALTER TABLE advance_order_items ADD COLUMN IF NOT EXISTS variant_id TEXT`,

  // Customers: upsertCustomer needs phone to be UNIQUE. Collapse historical
  // duplicates onto the oldest row first, then promote the index.
  sql`
    DELETE FROM customers c
    USING customers d
    WHERE c.phone = d.phone
      AND c.id > d.id
  `,
  sql`DROP INDEX IF EXISTS idx_customers_phone`,
  sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone ON customers (phone)`,

  // Card payments and split across cash / QR / card.
  sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS split_card NUMERIC NOT NULL DEFAULT 0`,
  sql`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_mode_check`,
  sql`
    ALTER TABLE orders ADD CONSTRAINT orders_payment_mode_check
    CHECK (payment_mode IN ('CASH', 'GPAY', 'CARD', 'SPLIT'))
  `,
  sql`ALTER TABLE advance_orders DROP CONSTRAINT IF EXISTS advance_orders_deposit_payment_mode_check`,
  sql`
    ALTER TABLE advance_orders ADD CONSTRAINT advance_orders_deposit_payment_mode_check
    CHECK (deposit_payment_mode IN ('CASH', 'GPAY', 'CARD', 'SPLIT'))
  `,

  // Advance orders: bill-level charges stored at booking.
  sql`ALTER TABLE advance_orders ADD COLUMN IF NOT EXISTS discount_type TEXT`,
  sql`ALTER TABLE advance_orders ADD COLUMN IF NOT EXISTS discount_value NUMERIC`,
  sql`ALTER TABLE advance_orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC`,
  sql`ALTER TABLE advance_orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC`,
  sql`ALTER TABLE advance_orders ADD COLUMN IF NOT EXISTS is_gst BOOLEAN`,
  sql`ALTER TABLE advance_orders ADD COLUMN IF NOT EXISTS gst_percentage NUMERIC`,
  sql`ALTER TABLE advance_orders ADD COLUMN IF NOT EXISTS gst_amount NUMERIC`,

  // Staff & attendance.
  sql`
    CREATE TABLE IF NOT EXISTS staff (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT '',
      phone        TEXT NOT NULL DEFAULT '',
      base_salary  NUMERIC NOT NULL DEFAULT 0,
      is_active    BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  sql`
    CREATE TABLE IF NOT EXISTS staff_attendance (
      id               TEXT PRIMARY KEY,
      staff_id         TEXT NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
      attendance_date  DATE NOT NULL,
      status           TEXT CHECK (status IN ('PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE')),
      clock_in         TIMESTAMPTZ,
      clock_out        TIMESTAMPTZ,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (staff_id, attendance_date)
    )
  `,
  sql`CREATE INDEX IF NOT EXISTS idx_staff_attendance_date ON staff_attendance (attendance_date)`,

  // Stock movement ledger.
  sql`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id            TEXT PRIMARY KEY,
      product_id    TEXT REFERENCES products (id) ON DELETE SET NULL,
      product_name  TEXT NOT NULL,
      movement_type TEXT NOT NULL,
      quantity      NUMERIC NOT NULL,
      stock_before  NUMERIC NOT NULL,
      stock_after   NUMERIC NOT NULL,
      reference     TEXT,
      note          TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
  sql`CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements (created_at DESC)`,

  sql`
    INSERT INTO app_meta (key, value) VALUES ('schema_version', ${String(SCHEMA_VERSION)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `,
];

async function currentVersion(): Promise<number> {
  try {
    const rows = (await sql`SELECT value FROM app_meta WHERE key = 'schema_version'`) as {
      value: string;
    }[];
    return Number(rows[0]?.value) || 0;
  } catch {
    return 0; // app_meta does not exist yet
  }
}

let ready: Promise<void> | null = null;

/**
 * Resolves once the database is on SCHEMA_VERSION. Shared by every caller in
 * this server process, so concurrent requests wait on the same check. Never
 * throws: on failure it logs, lets the request continue, and retries next call.
 */
export function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      if ((await currentVersion()) >= SCHEMA_VERSION) return;
      await sql.transaction(migrations());
    })().catch((err) => {
      console.error('Failed to migrate database schema:', err);
      ready = null;
    });
  }
  return ready;
}
