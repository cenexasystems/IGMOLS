export type Category = {
  id: string;
  name: string;
  created_at: string;
};

/** Every catalogue item is a stocked product (services were removed). */
export type ItemType = 'PRODUCT';

export type Product = {
  id: string;
  name: string;
  description: string | null;
  category: string;
  gst_rate: number; // Default GST % for this product (editable at billing)
  hsn_code: string | null; // HSN/SAC code shown on GST invoices
  selling_price: number; // GST-exclusive catalog price (GST added at billing)
  item_type: ItemType;
  cost_price: number; // Records only — never used in billing maths
  current_stock: number | null;
  low_stock_alert: number | null; // null when low-stock alerts don't apply
  offer_discount_pct: number; // 0 = no automatic offer
  offer_price: number | null; // Price billed when an offer is active
  is_active: boolean; // Visible in the Billing Panel picker
  created_at: string;
  tamil_name?: string | null; // shown under the name in pickers and search
  barcode?: string | null; // scannable code; variants carry their own
  has_variants?: boolean; // stock then lives on the variants; current_stock is their total
  variants?: ProductVariant[];
};

/**
 * A size / colour / SKU of a product. Blank price or cost falls back to the
 * product's.
 */
export type ProductVariant = {
  id: string;
  product_id: string;
  name: string;
  price: number | null;
  cost_price: number | null;
  stock: number | null;
  barcode: string | null;
  sort_order: number;
};

/** A variant as sent from the product form; no id means a new row. */
export type ProductVariantInput = {
  id?: string;
  name: string;
  price: number | null;
  cost_price: number | null;
  stock: number | null;
  barcode: string | null;
};

/** The price a catalogue row should bill at, honouring an automatic offer. */
export const effectivePrice = (p: {
  selling_price: number;
  offer_discount_pct: number;
  offer_price: number | null;
}): number => {
  if (p.offer_discount_pct > 0 && p.offer_price !== null && p.offer_price > 0) {
    return p.offer_price;
  }
  return p.selling_price;
};

/**
 * Why a product's stock changed. OPENING is the count entered when the product
 * was created; EDIT is a stock change made from the product form; SALE is
 * written automatically by a completed POS bill.
 */
export type StockMovementType =
  | 'OPENING'
  | 'RESTOCK'
  | 'RETURN'
  | 'SALE'
  | 'LOSS'
  | 'RECONCILE'
  | 'EDIT';

/** One row in the stock movement ledger. `quantity` is signed (+in / −out). */
export type StockMovement = {
  id: string;
  product_id: string | null; // movements are deleted with their product
  product_name: string; // "Name (Variant)" at the time of the movement
  movement_type: StockMovementType;
  quantity: number;
  stock_before: number;
  stock_after: number;
  reference: string | null; // invoice number for SALE rows
  note: string | null;
  created_at: string;
};

export type Customer = {
  id: string;
  name: string;
  phone: string;
  address: string | null;
  created_at: string;
};

/** GPAY is shown as "QR / GPay". SPLIT spreads the bill across any of the other three. */
export type PaymentMode = 'CASH' | 'GPAY' | 'CARD' | 'SPLIT';

export type OrderRow = {
  id: string;
  customer_id: string;
  source: 'ONLINE' | 'OFFLINE';
  status: 'COMPLETED' | 'PENDING';
  is_gst: boolean; // true = GST invoice, false = non-GST bill
  subtotal: number; // GST-exclusive (line price × qty); older bills stored it GST-inclusive
  discount_type: 'PERCENT' | 'FIXED';
  discount_value: number;
  discount_amount: number;
  gst_percentage: number;
  gst_amount: number; // GST charged on (subtotal - discount), added on top
  delivery_fee: number;
  grand_total: number; // = subtotal - discount + delivery
  cash_received: number; // total amount tendered (the single mode's amount, or the sum of the split parts)
  split_cash: number; // cash portion when payment_mode = SPLIT
  split_gpay: number; // QR / GPay portion when payment_mode = SPLIT
  split_card: number; // card portion when payment_mode = SPLIT
  payment_mode: PaymentMode;
  bill_date: string;
  created_at: string;
};

export type OrderItemRow = {
  id: string;
  order_id: string;
  product_id: string | null;
  variant_id?: string | null;
  snapshot_name: string;
  snapshot_price: number;
  quantity: number;
  offer_pct: number; // automatic offer applied to this line (0 = none)
  original_price: number | null; // catalogue price before the offer (NULL on older lines)
};

export type OrderWithRelations = OrderRow & {
  customer_name: string;
  customer_phone: string;
  customer_address: string | null;
  items: OrderItemRow[];
};

export type Expense = {
  id: string;
  title: string;
  category: string;
  amount: number;
  payment_mode: string; // CASH | UPI | CARD | BANK | OTHER
  notes: string | null;
  expense_date: string;
  created_at: string;
};

/** A category in the Expense Tracker; inactive ones are hidden from the add form. */
export type ExpenseCategory = {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
};

export type AdvanceOrderStatus = 'PENDING' | 'READY' | 'COMPLETED' | 'CANCELLED';

export type AdvanceOrderRow = {
  id: string;
  customer_id: string;
  status: AdvanceOrderStatus;
  subtotal: number;
  total_amount: number;
  deposit_amount: number;
  deposit_payment_mode: PaymentMode;
  delivery_date: string | null;
  notes: string | null;
  // Bill-level charges at booking; NULL on orders booked before they were stored
  // (see lib/advanceCharges.ts).
  discount_type: 'PERCENT' | 'FIXED' | null;
  discount_value: number | null;
  discount_amount: number | null;
  delivery_fee: number | null;
  is_gst: boolean | null;
  gst_percentage: number | null;
  gst_amount: number | null;
  finalized_order_id: string | null;
  finalized_at: string | null;
  cancelled_at: string | null;
  created_at: string;
};

export type AdvanceOrderItemRow = {
  id: string;
  advance_order_id: string;
  product_id: string | null;
  variant_id?: string | null;
  snapshot_name: string;
  snapshot_desc: string | null;
  snapshot_price: number;
  quantity: number;
};

export type AdvanceOrderWithRelations = AdvanceOrderRow & {
  customer_name: string;
  customer_phone: string;
  customer_address: string | null;
  items: AdvanceOrderItemRow[];
};

export type Staff = {
  id: string;
  name: string;
  role: string;
  phone: string;
  base_salary: number;
  is_active: boolean;
  created_at: string;
};

export type AttendanceStatus = 'PRESENT' | 'ABSENT' | 'HALF_DAY' | 'LEAVE';

/** One row per staff member per day (attendance_date is 'YYYY-MM-DD'). */
export type AttendanceRecord = {
  id: string;
  staff_id: string;
  attendance_date: string;
  status: AttendanceStatus | null;
  clock_in: string | null;
  clock_out: string | null;
};

export type CartItem = {
  id: string;
  product_id: string | null;
  variant_id?: string | null;
  name: string;
  desc: string;
  price: number;
  qty: number;
  offerPct?: number; // automatic catalogue offer applied to this line
  originalPrice?: number | null; // catalogue price before the offer
};

/**
 * Shop / business profile used across the storefront, POS and printed invoices.
 * Stored as a single row in `shop_settings` (id = 'default') and fully
 * editable from the POS → Settings tab.
 */
export type ShopSettings = {
  owner_name: string;
  shop_name: string;
  tagline: string;
  phone: string;
  email: string;
  address: string;
  location: string;
  instagram_url: string;
  business_hours: string;
  services: string;
  gstin: string;
  accent_color: string; // hex e.g. '#C50303' — drives the theme app-wide
  logo_data_url: string | null; // data:image/...; null = use bundled /logo.png
  updated_at?: string;
};
