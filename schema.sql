-- =====================================================================
--  IGMOLS — POS & INVENTORY SCHEMA
--  Target: PostgreSQL 15+ (Neon serverless)
--
--  HOW TO USE
--  1. Neon Console -> SQL Editor -> New Query
--  2. Paste this file and click Run
--  3. Copy the pooled connection string into .env.local as DATABASE_URL
--
--  Safe on a brand-new database. For an EXISTING database run the
--  UPGRADE block at the very bottom instead.
-- =====================================================================

-- CATEGORIES ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- PRODUCTS & SERVICES ---------------------------------------------------
--   item_type = 'PRODUCT' -> physical item, tracks stock
--   item_type = 'SERVICE' -> delivery / packing / add-on, stock is NULL
CREATE TABLE IF NOT EXISTS products (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT,
  category           TEXT NOT NULL DEFAULT 'General',
  gst_rate           NUMERIC NOT NULL DEFAULT 0,
  hsn_code           TEXT,
  selling_price      NUMERIC NOT NULL DEFAULT 0,

  item_type          TEXT NOT NULL DEFAULT 'PRODUCT'
                     CHECK (item_type IN ('PRODUCT', 'SERVICE')),
  cost_price         NUMERIC NOT NULL DEFAULT 0,   -- records only
  current_stock      NUMERIC,                      -- NULL for services
  low_stock_alert    NUMERIC,                      -- NULL for services
  offer_discount_pct NUMERIC NOT NULL DEFAULT 0,
  offer_price        NUMERIC,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);
CREATE INDEX IF NOT EXISTS idx_products_active   ON products (is_active);
CREATE INDEX IF NOT EXISTS idx_products_type     ON products (item_type);

-- CUSTOMERS -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  address    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UNIQUE is required: the POS upserts customers with ON CONFLICT (phone).
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone ON customers (phone);

-- ORDERS (invoices) -----------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT NOT NULL REFERENCES customers (id),
  source           TEXT NOT NULL DEFAULT 'OFFLINE'
                   CHECK (source IN ('ONLINE', 'OFFLINE')),
  status           TEXT NOT NULL DEFAULT 'COMPLETED'
                   CHECK (status IN ('COMPLETED', 'PENDING')),
  is_gst           BOOLEAN NOT NULL DEFAULT FALSE,

  -- subtotal is GST-exclusive; grand_total = subtotal - discount + gst_amount + delivery_fee
  subtotal         NUMERIC NOT NULL DEFAULT 0,
  discount_type    TEXT NOT NULL DEFAULT 'FIXED'
                   CHECK (discount_type IN ('PERCENT', 'FIXED')),
  discount_value   NUMERIC NOT NULL DEFAULT 0,
  discount_amount  NUMERIC NOT NULL DEFAULT 0,
  gst_percentage   NUMERIC NOT NULL DEFAULT 0,
  gst_amount       NUMERIC NOT NULL DEFAULT 0,
  delivery_fee     NUMERIC NOT NULL DEFAULT 0,
  grand_total      NUMERIC NOT NULL DEFAULT 0,

  cash_received    NUMERIC NOT NULL DEFAULT 0,
  split_cash       NUMERIC NOT NULL DEFAULT 0,
  split_gpay       NUMERIC NOT NULL DEFAULT 0,
  split_card       NUMERIC NOT NULL DEFAULT 0,
  payment_mode     TEXT NOT NULL DEFAULT 'CASH'
                   CHECK (payment_mode IN ('CASH', 'GPAY', 'CARD', 'SPLIT')),

  bill_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer  ON orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_bill_date ON orders (bill_date DESC);
CREATE INDEX IF NOT EXISTS idx_orders_created   ON orders (created_at DESC);

-- ORDER ITEMS (invoice lines - name/price are snapshotted) --------------
CREATE TABLE IF NOT EXISTS order_items (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id     TEXT REFERENCES products (id) ON DELETE SET NULL,
  snapshot_name  TEXT NOT NULL,
  snapshot_price NUMERIC NOT NULL DEFAULT 0,
  quantity       NUMERIC NOT NULL DEFAULT 1,
  offer_pct      NUMERIC NOT NULL DEFAULT 0,
  original_price NUMERIC  -- catalogue price before the offer
);

CREATE INDEX IF NOT EXISTS idx_order_items_order   ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);

-- EXPENSES --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  category      TEXT NOT NULL,
  amount        NUMERIC NOT NULL DEFAULT 0,
  payment_mode  TEXT NOT NULL DEFAULT 'CASH',
  notes         TEXT,
  expense_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (expense_date DESC);

-- ADVANCE ORDERS (partial-payment holds, revenue only once finalized) ----
CREATE TABLE IF NOT EXISTS advance_orders (
  id                   TEXT PRIMARY KEY,
  customer_id          TEXT NOT NULL REFERENCES customers (id),
  status               TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'READY', 'COMPLETED', 'CANCELLED')),
  subtotal             NUMERIC NOT NULL DEFAULT 0,
  total_amount         NUMERIC NOT NULL DEFAULT 0,
  deposit_amount       NUMERIC NOT NULL DEFAULT 0,
  deposit_payment_mode TEXT NOT NULL DEFAULT 'CASH'
                       CHECK (deposit_payment_mode IN ('CASH', 'GPAY', 'CARD', 'SPLIT')),
  delivery_date        DATE,
  notes                TEXT,
  -- bill-level charges at booking (NULL on orders booked before they were stored)
  discount_type        TEXT,
  discount_value       NUMERIC,
  discount_amount      NUMERIC,
  delivery_fee         NUMERIC,
  is_gst               BOOLEAN,
  gst_percentage       NUMERIC,
  gst_amount           NUMERIC,
  finalized_order_id   TEXT,
  finalized_at         TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_advance_customer ON advance_orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_advance_status   ON advance_orders (status);

CREATE TABLE IF NOT EXISTS advance_order_items (
  id               TEXT PRIMARY KEY,
  advance_order_id TEXT NOT NULL REFERENCES advance_orders (id) ON DELETE CASCADE,
  product_id       TEXT REFERENCES products (id) ON DELETE SET NULL,
  snapshot_name    TEXT NOT NULL,
  snapshot_desc    TEXT,
  snapshot_price   NUMERIC NOT NULL DEFAULT 0,
  quantity         NUMERIC NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_advance_items_order
  ON advance_order_items (advance_order_id);

-- STAFF & ATTENDANCE ------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  base_salary  NUMERIC NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per staff member per day. status is NULL until it is set or the
-- staff member clocks in.
CREATE TABLE IF NOT EXISTS staff_attendance (
  id               TEXT PRIMARY KEY,
  staff_id         TEXT NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  attendance_date  DATE NOT NULL,
  status           TEXT CHECK (status IN ('PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE')),
  clock_in         TIMESTAMPTZ,
  clock_out        TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (staff_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS idx_staff_attendance_date ON staff_attendance (attendance_date);

-- PRODUCT VARIANTS (sizes / colours / SKUs; options for services) ---------
-- products.tamil_name, products.barcode, products.has_variants and the
-- variant_id columns on order_items / advance_order_items are added by the
-- app on first run (lib/dbStore.ts ensureProductSchema).
CREATE TABLE IF NOT EXISTS product_variants (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  price       NUMERIC,                  -- NULL = product price
  cost_price  NUMERIC,                  -- NULL = product cost
  stock       NUMERIC,                  -- NULL for service options
  barcode     TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants (product_id);

-- STOCK MOVEMENTS (audit ledger; quantity is signed: + in / − out) --------
CREATE TABLE IF NOT EXISTS stock_movements (
  id            TEXT PRIMARY KEY,
  product_id    TEXT REFERENCES products (id) ON DELETE SET NULL,
  product_name  TEXT NOT NULL,          -- snapshot, survives product deletion
  movement_type TEXT NOT NULL,          -- OPENING | RESTOCK | RETURN | SALE | LOSS | RECONCILE | EDIT
  quantity      NUMERIC NOT NULL,
  stock_before  NUMERIC NOT NULL,
  stock_after   NUMERIC NOT NULL,
  reference     TEXT,                   -- invoice number for SALE rows
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements (created_at DESC);

-- SHOP SETTINGS (single row, id = 'default') -----------------------------
CREATE TABLE IF NOT EXISTS shop_settings (
  id             TEXT PRIMARY KEY,
  owner_name     TEXT NOT NULL DEFAULT '',
  shop_name      TEXT NOT NULL DEFAULT '',
  tagline        TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  address        TEXT NOT NULL DEFAULT '',
  location       TEXT NOT NULL DEFAULT '',
  instagram_url  TEXT NOT NULL DEFAULT '',
  business_hours TEXT NOT NULL DEFAULT '',
  services       TEXT NOT NULL DEFAULT '',
  gstin          TEXT NOT NULL DEFAULT '',
  accent_color   TEXT NOT NULL DEFAULT '#C50303',
  logo_data_url  TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO shop_settings (
  id, owner_name, shop_name, tagline, phone, email,
  address, location, instagram_url, business_hours, services, gstin, logo_data_url, accent_color
) VALUES (
  'default',
  'Maha Gowtham',
  'IGMOLS',
  '',
  '8148094377',
  'igmolstrends@gmail.com',
  '34, Thiruvallur main road, pondavakkam, uthukottai, Thiruvallur - 602026',
  'Thiruvallur, Tamil Nadu',
  'https://www.instagram.com/igmols.latest',
  'Open Daily',
  '',
  '',
  NULL,
  '#C50303'
)
ON CONFLICT (id) DO NOTHING;

-- Starter categories ----------------------------------------------------
-- Removed to give a blank slate. Add your own from the POS category
-- manager (Sidebar -> Categories). Products fall back to 'General'.
-- INSERT INTO categories (id, name) VALUES
--   (gen_random_uuid()::text, 'Blouses'),
--   (gen_random_uuid()::text, 'Sarees'),
--   (gen_random_uuid()::text, 'Kurtis'),
--   (gen_random_uuid()::text, 'Alterations'),
--   (gen_random_uuid()::text, 'Services')
-- ON CONFLICT (name) DO NOTHING;

-- =====================================================================
--  UPGRADE BLOCK - run these on an EXISTING database
--  (safe to re-run; the app also applies this automatically)
-- =====================================================================
-- ALTER TABLE products    ADD COLUMN IF NOT EXISTS item_type          TEXT NOT NULL DEFAULT 'PRODUCT';
-- ALTER TABLE products    ADD COLUMN IF NOT EXISTS cost_price         NUMERIC NOT NULL DEFAULT 0;
-- ALTER TABLE products    ADD COLUMN IF NOT EXISTS current_stock      NUMERIC;
-- ALTER TABLE products    ADD COLUMN IF NOT EXISTS low_stock_alert    NUMERIC;
-- ALTER TABLE products    ADD COLUMN IF NOT EXISTS offer_discount_pct NUMERIC NOT NULL DEFAULT 0;
-- ALTER TABLE products    ADD COLUMN IF NOT EXISTS offer_price        NUMERIC;
-- ALTER TABLE products    ADD COLUMN IF NOT EXISTS is_active          BOOLEAN NOT NULL DEFAULT TRUE;
-- ALTER TABLE order_items ADD COLUMN IF NOT EXISTS offer_pct          NUMERIC NOT NULL DEFAULT 0;
-- CREATE TABLE IF NOT EXISTS shop_settings ( ...same definition as above... );
-- CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);
-- CREATE INDEX IF NOT EXISTS idx_products_active   ON products (is_active);
-- CREATE INDEX IF NOT EXISTS idx_products_type     ON products (item_type);
-- CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);

-- SANITY CHECK: expect 9 tables, and 'IGMOLS' in shop_settings
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' ORDER BY table_name;
-- SELECT shop_name, phone, email FROM shop_settings WHERE id = 'default';
