"use server";

import { dbStore } from "@/lib/dbStore";
import { Product, OrderWithRelations, CartItem, Expense, PaymentMode, Category, AdvanceOrderWithRelations, AdvanceOrderStatus, ShopSettings, ItemType, Staff, AttendanceRecord, AttendanceStatus, StockMovement, StockMovementType, ProductVariantInput } from "@/lib/types";
import { getShopSettings, saveShopSettings, normalizeHex, DEFAULT_ACCENT } from "@/lib/shopSettings";
import { normalizePasscode, roleForPasscode, setPasscode, type PosRole } from "@/lib/passcodes";

// Helper to serialize Date objects from Postgres to strings
function serialize<T>(data: T): T {
  if (data === null || data === undefined) return data;
  return JSON.parse(JSON.stringify(data));
}

export async function verifyPasscode(enteredPasscode: string): Promise<{ success: boolean; role?: 'staff' | 'admin' }> {
  const role = await roleForPasscode(enteredPasscode);
  return role ? { success: true, role } : { success: false };
}

/**
 * Change the admin or staff login passcode (Settings → Login Passcodes).
 * The POS has no server session, so every change must carry the current
 * admin passcode, checked here.
 */
export async function changePasscode(data: {
  role: PosRole;
  currentAdminPasscode: string;
  newPasscode: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (data.role !== "admin" && data.role !== "staff") {
    return { ok: false, error: "Unknown passcode type." };
  }
  if ((await roleForPasscode(data.currentAdminPasscode)) !== "admin") {
    return { ok: false, error: "The current admin passcode is incorrect." };
  }
  const next = normalizePasscode(data.newPasscode);
  if (next.length < 4 || next.length > 32) {
    return { ok: false, error: "Use 4 to 32 characters (spaces are ignored)." };
  }
  // Each passcode must open exactly one role.
  const otherRole = data.role === "admin" ? "staff" : "admin";
  if ((await roleForPasscode(next)) === otherRole) {
    return { ok: false, error: "Admin and staff passcodes must be different." };
  }
  await setPasscode(data.role, next);
  return { ok: true };
}

/**
 * Everything the POS screen loads on open, in one request. Next.js dispatches
 * Server Actions one at a time per client, so a client-side Promise.all over
 * six actions ran as six back-to-back round trips; here they run in parallel.
 */
export async function fetchPosData(): Promise<{
  products: Product[];
  orders: OrderWithRelations[];
  expenses: Expense[];
  categories: Category[];
  advanceOrders: AdvanceOrderWithRelations[];
  shopSettings: ShopSettings;
}> {
  const [products, orders, expenses, categories, advanceOrders, shopSettings] = await Promise.all([
    dbStore.listProducts(),
    dbStore.listOrdersWithRelations(),
    dbStore.listExpenses(),
    dbStore.listCategories(),
    dbStore.listAdvanceOrders(),
    getShopSettings(),
  ]);
  return serialize({ products, orders, expenses, categories, advanceOrders, shopSettings });
}

/** Staff list plus one day's attendance, in one request (see fetchPosData). */
export async function fetchStaffDay(date: string): Promise<{
  staff: Staff[];
  attendance: AttendanceRecord[];
}> {
  const day = assertDate(date);
  const [staff, attendance] = await Promise.all([
    dbStore.listStaff(),
    dbStore.listAttendance(day, day),
  ]);
  return serialize({ staff, attendance });
}

// Categories
export async function fetchCategories(): Promise<Category[]> {
  return serialize(await dbStore.listCategories());
}

export async function createCategory(name: string): Promise<Category> {
  return serialize(await dbStore.addCategory(name.trim()));
}

export async function renameCategory(id: string, name: string): Promise<Category | null> {
  return serialize(await dbStore.updateCategory(id, name.trim()));
}

export async function removeCategory(id: string): Promise<void> {
  return await dbStore.deleteCategory(id);
}

// Products
export async function fetchProducts(): Promise<Product[]> {
  return serialize(await dbStore.listProducts());
}

// Blank or non-numeric form values arrive as NaN; never let them reach SQL.
const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : num(v);

/** Trim names, drop blank rows and coerce numbers; blank price / cost stay null (= parent's). */
function cleanVariants(variants: ProductVariantInput[] | null | undefined): ProductVariantInput[] {
  return (variants ?? [])
    .map((v) => ({
      id: v.id || undefined,
      name: (v.name || "").trim(),
      price: v.price === null || (v.price as unknown) === "" ? null : Math.max(0, num(v.price)),
      cost_price:
        v.cost_price === null || (v.cost_price as unknown) === "" ? null : Math.max(0, num(v.cost_price)),
      stock: v.stock === null ? null : Math.max(0, num(v.stock)),
      barcode: (v.barcode || "").trim() || null,
    }))
    .filter((v) => v.name);
}

export async function createProduct(data: { name: string; description: string | null; category: string; gst_rate: number; hsn_code: string | null; selling_price: number; item_type?: ItemType; cost_price?: number; current_stock?: number | null; low_stock_alert?: number | null; offer_discount_pct?: number; offer_price?: number | null; is_active?: boolean; tamil_name?: string | null; barcode?: string | null; variants?: ProductVariantInput[] | null }): Promise<Product> {
  const name = data.name.trim();
  if (!name) throw new Error("Product name is required");
  return serialize(
    await dbStore.addProduct({
      ...data,
      name,
      tamil_name: data.tamil_name?.trim() || null,
      barcode: data.barcode?.trim() || null,
      variants: cleanVariants(data.variants),
      category: data.category.trim() || "General",
      gst_rate: Math.max(0, num(data.gst_rate)),
      selling_price: Math.max(0, num(data.selling_price)),
      cost_price: Math.max(0, num(data.cost_price)),
      current_stock: numOrNull(data.current_stock),
      low_stock_alert: numOrNull(data.low_stock_alert),
      offer_discount_pct: Math.min(100, Math.max(0, num(data.offer_discount_pct))),
      offer_price: numOrNull(data.offer_price),
    }),
  );
}

/** `variants` (from the product form) replaces the variant list; omit it to leave variants alone. */
export async function editProduct(
  id: string,
  data: Partial<Product>,
  variants?: ProductVariantInput[],
): Promise<Product | null> {
  const patch: Partial<Product> = { ...data };
  delete patch.variants;
  if (patch.tamil_name !== undefined) patch.tamil_name = patch.tamil_name?.trim() || null;
  if (patch.barcode !== undefined) patch.barcode = patch.barcode?.trim() || null;
  return serialize(
    await dbStore.updateProduct(
      id,
      patch,
      undefined,
      variants === undefined ? undefined : cleanVariants(variants),
    ),
  );
}

export async function removeProduct(id: string): Promise<void> {
  return await dbStore.deleteProduct(id);
}

// Stock movements
const ADJUST_TYPES: StockMovementType[] = ["RESTOCK", "RETURN", "LOSS", "RECONCILE"];

export async function fetchStockMovements(): Promise<StockMovement[]> {
  return serialize(await dbStore.listStockMovements());
}

/** Stock-adjust dialog: set the new count and log why it changed. */
export async function adjustProductStock(
  id: string,
  data: {
    type: StockMovementType;
    newStock: number;
    lowStockAlert?: number | null;
    note?: string | null;
    /** Adjust one variant of a variant product instead of the product itself. */
    variantId?: string | null;
  },
): Promise<Product | null> {
  if (!ADJUST_TYPES.includes(data.type)) throw new Error(`Invalid adjustment type: ${data.type}`);
  if (data.variantId) {
    return serialize(
      await dbStore.setVariantStock(data.variantId, data.newStock, {
        type: data.type,
        note: data.note ?? null,
      }),
    );
  }
  const patch: Partial<Product> = { current_stock: Math.max(0, num(data.newStock)) };
  if (data.lowStockAlert !== undefined) patch.low_stock_alert = numOrNull(data.lowStockAlert);
  return serialize(
    await dbStore.updateProduct(id, patch, { type: data.type, note: data.note ?? null }),
  );
}

// Orders
export async function fetchOrders(): Promise<OrderWithRelations[]> {
  return serialize(await dbStore.listOrdersWithRelations());
}

export async function fetchOrderById(id: string): Promise<OrderWithRelations | null> {
  return serialize(await dbStore.getOrderWithRelations(id));
}

export async function orderIdExists(id: string): Promise<boolean> {
  return await dbStore.orderIdExists(id);
}

export async function submitOrder(payload: {
  orderId: string;
  customerName: string;
  customerPhone: string;
  customerAddress?: string | null;
  source: 'ONLINE' | 'OFFLINE';
  isGst: boolean;
  billDate: string;
  items: CartItem[];
  discountType: 'PERCENT' | 'FIXED';
  discountValue: number;
  discountAmount: number;
  gstPercentage: number;
  gstAmount: number;
  deliveryFee: number;
  grandTotal: number;
  cashReceived: number;
  splitCash?: number;
  splitGpay?: number;
  splitCard?: number;
  paymentMode: PaymentMode;
}): Promise<{ orderId: string }> {
  return await dbStore.submitOrder(payload);
}

export async function removeOrder(id: string): Promise<void> {
  return await dbStore.deleteOrder(id);
}

// Expenses
export async function fetchExpenses(): Promise<Expense[]> {
  return serialize(await dbStore.listExpenses());
}

export async function createExpense(data: {
  title: string;
  category: string;
  amount: number;
  payment_mode: string;
  notes: string | null;
  expense_date: string;
}): Promise<Expense> {
  return serialize(await dbStore.addExpense(data));
}

export async function editExpense(id: string, data: Partial<Expense>): Promise<Expense | null> {
  return serialize(await dbStore.updateExpense(id, data));
}

export async function removeExpense(id: string): Promise<void> {
  return await dbStore.deleteExpense(id);
}

// Advance Orders (partial-payment holds — not revenue until finalized)
export async function fetchAdvanceOrders(): Promise<AdvanceOrderWithRelations[]> {
  return serialize(await dbStore.listAdvanceOrders());
}

export async function fetchAdvanceOrderById(id: string): Promise<AdvanceOrderWithRelations | null> {
  return serialize(await dbStore.getAdvanceOrder(id));
}

export async function advanceOrderIdExists(id: string): Promise<boolean> {
  return await dbStore.advanceOrderIdExists(id);
}

export async function createAdvanceOrder(payload: {
  advanceOrderId: string;
  customerName: string;
  customerPhone: string;
  customerAddress?: string | null;
  subtotal: number;
  totalAmount: number;
  depositAmount: number;
  depositPaymentMode: PaymentMode;
  deliveryDate: string | null;
  notes: string | null;
  discountType: 'PERCENT' | 'FIXED';
  discountValue: number;
  discountAmount: number;
  deliveryFee: number;
  isGst: boolean;
  gstPercentage: number;
  gstAmount: number;
  items: {
    product_id: string | null;
    variant_id?: string | null;
    snapshot_name: string;
    snapshot_desc: string | null;
    snapshot_price: number;
    quantity: number;
  }[];
}): Promise<{ advanceOrderId: string }> {
  return await dbStore.createAdvanceOrder({
    ...payload,
    discountType: payload.discountType === 'PERCENT' ? 'PERCENT' : 'FIXED',
    discountValue: Math.max(0, num(payload.discountValue)),
    discountAmount: Math.max(0, num(payload.discountAmount)),
    deliveryFee: Math.max(0, num(payload.deliveryFee)),
    isGst: Boolean(payload.isGst),
    gstPercentage: Math.max(0, num(payload.gstPercentage)),
    gstAmount: Math.max(0, num(payload.gstAmount)),
  });
}

export async function setAdvanceOrderStatus(id: string, status: AdvanceOrderStatus): Promise<void> {
  return await dbStore.updateAdvanceOrderStatus(id, status);
}

export async function cancelAdvanceOrder(id: string): Promise<void> {
  return await dbStore.cancelAdvanceOrder(id);
}

export async function removeAdvanceOrder(id: string): Promise<void> {
  return await dbStore.deleteAdvanceOrder(id);
}

export async function finalizeAdvanceOrder(payload: {
  advanceOrderId: string;
  invoiceId: string;
  isGst: boolean;
  gstPercentage: number;
  discountType: 'PERCENT' | 'FIXED';
  discountValue: number;
  discountAmount: number;
  deliveryFee: number;
  paymentMode: PaymentMode;
  billDate: string;
}): Promise<{ orderId: string }> {
  return await dbStore.finalizeAdvanceOrder(payload);
}

// Shop settings (single profile row)
export async function fetchShopSettings(): Promise<ShopSettings> {
  return serialize(await getShopSettings());
}

export async function updateShopSettings(data: ShopSettings): Promise<ShopSettings> {
  const clean: ShopSettings = {
    owner_name: data.owner_name.trim(),
    shop_name: data.shop_name.trim() || "My Shop",
    tagline: data.tagline.trim(),
    phone: data.phone.trim(),
    email: data.email.trim(),
    address: data.address.trim(),
    location: data.location.trim(),
    instagram_url: data.instagram_url.trim(),
    business_hours: data.business_hours.trim(),
    services: data.services.trim(),
    gstin: data.gstin.trim(),
    accent_color: normalizeHex(data.accent_color) || DEFAULT_ACCENT,
    logo_data_url: data.logo_data_url || null,
  };
  return serialize(await saveShopSettings(clean));
}

// Staff & attendance
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ATTENDANCE_STATUSES: AttendanceStatus[] = ["PRESENT", "ABSENT", "HALF_DAY", "LEAVE"];

function assertDate(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`Invalid date: ${date}`);
  return date;
}

type StaffInput = { name: string; role: string; phone: string; base_salary: number; is_active: boolean };

function cleanStaff(data: StaffInput): StaffInput {
  const name = data.name.trim();
  if (!name) throw new Error("Staff name is required");
  return {
    name,
    role: data.role.trim(),
    phone: data.phone.replace(/\D/g, "").slice(-10),
    base_salary: Math.max(0, Number(data.base_salary) || 0),
    is_active: Boolean(data.is_active),
  };
}

export async function fetchStaff(): Promise<Staff[]> {
  return serialize(await dbStore.listStaff());
}

export async function createStaff(data: StaffInput): Promise<Staff> {
  return serialize(await dbStore.addStaff(cleanStaff(data)));
}

export async function editStaff(id: string, data: StaffInput): Promise<Staff | null> {
  return serialize(await dbStore.updateStaff(id, cleanStaff(data)));
}

export async function removeStaff(id: string): Promise<void> {
  return await dbStore.deleteStaff(id);
}

export async function fetchAttendance(fromDate: string, toDate: string): Promise<AttendanceRecord[]> {
  return serialize(await dbStore.listAttendance(assertDate(fromDate), assertDate(toDate)));
}

export async function setAttendanceStatus(
  staffId: string,
  date: string,
  status: AttendanceStatus | null,
): Promise<void> {
  if (status !== null && !ATTENDANCE_STATUSES.includes(status)) {
    throw new Error(`Invalid attendance status: ${status}`);
  }
  return await dbStore.setAttendanceStatus(staffId, assertDate(date), status);
}

export async function clockInStaff(staffId: string, date: string): Promise<void> {
  return await dbStore.clockIn(staffId, assertDate(date));
}

export async function clockOutStaff(staffId: string, date: string): Promise<void> {
  return await dbStore.clockOut(staffId, assertDate(date));
}
