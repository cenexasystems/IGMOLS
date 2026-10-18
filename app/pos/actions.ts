"use server";

import { dbStore } from "@/lib/dbStore";
import { Product, OrderWithRelations, CartItem, Expense, PaymentMode, Category, AdvanceOrderWithRelations, AdvanceOrderStatus, ShopSettings, ItemType, Staff, AttendanceRecord, AttendanceStatus } from "@/lib/types";
import { getShopSettings, saveShopSettings, normalizeHex, DEFAULT_ACCENT } from "@/lib/shopSettings";

// Helper to serialize Date objects from Postgres to strings
function serialize<T>(data: T): T {
  if (data === null || data === undefined) return data;
  return JSON.parse(JSON.stringify(data));
}

export async function verifyPasscode(enteredPasscode: string): Promise<{ success: boolean; role?: 'staff' | 'admin' }> {
  const adminPasscode = process.env.ADMIN_PASSCODE || "admin123";
  const staffPasscode = process.env.STAFF_PASSCODE || process.env.NEXT_PUBLIC_STAFF_PASSCODE || "staff123";

  const normalizedEntered = enteredPasscode.replace(/\s/g, "");

  if (normalizedEntered === adminPasscode) {
    return { success: true, role: 'admin' };
  }
  if (normalizedEntered === staffPasscode) {
    return { success: true, role: 'staff' };
  }

  return { success: false };
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

export async function createProduct(data: { name: string; description: string | null; category: string; gst_rate: number; hsn_code: string | null; selling_price: number; item_type?: ItemType; cost_price?: number; current_stock?: number | null; low_stock_alert?: number | null; offer_discount_pct?: number; offer_price?: number | null; is_active?: boolean }): Promise<Product> {
  const name = data.name.trim();
  if (!name) throw new Error("Product name is required");
  return serialize(
    await dbStore.addProduct({
      ...data,
      name,
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

export async function editProduct(id: string, data: Partial<Product>): Promise<Product | null> {
  return serialize(await dbStore.updateProduct(id, data));
}

export async function removeProduct(id: string): Promise<void> {
  return await dbStore.deleteProduct(id);
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
