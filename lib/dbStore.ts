import { sql } from './db';
import {
  Product,
  Category,
  Customer,
  OrderRow,
  OrderItemRow,
  OrderWithRelations,
  CartItem,
  Expense,
  PaymentMode,
  AdvanceOrderRow,
  AdvanceOrderItemRow,
  AdvanceOrderStatus,
  AdvanceOrderWithRelations,
  ItemType,
  Staff,
  AttendanceRecord,
  AttendanceStatus,
  StockMovement,
  StockMovementType,
  ProductVariant,
  ProductVariantInput,
} from './types';
import { advanceCharges } from './advanceCharges';
import { ensureSchema } from './schema';


const round2 = (n: number) => Math.round(n * 100) / 100;

// Utility to generate a unique ID
const uid = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

/**
 * `upsertCustomer` relies on `ON CONFLICT (phone)`, which Postgres only accepts
 * when a UNIQUE constraint exists on that column. schema.sql originally created a
 * plain (non-unique) index, so every sale that involved a customer phone failed
 * with "there is no unique or exclusion constraint matching the ON CONFLICT
 * specification". This promotes the index to UNIQUE and is idempotent.
 */
/**
 * Only keep product links that still exist in the catalogue. A stale id (a
 * product deleted in another tab, or removed by the demo-data rollback) would
 * violate the *_product_id foreign key and abort the entire save. The line still
 * bills correctly from its snapshot name/price — it simply loses the catalogue
 * link, which is exactly what ON DELETE SET NULL does anyway.
 */
async function filterLiveProductIds(ids: (string | null | undefined)[]): Promise<Set<string>> {
  const wanted = ids.filter((id): id is string => Boolean(id));
  const live = new Set<string>();
  if (wanted.length === 0) return live;
  const existing = await sql`SELECT id FROM products WHERE id = ANY(${wanted})`;
  for (const row of existing as unknown as { id: string }[]) {
    live.add(row.id);
  }
  return live;
}

async function ensureCustomerSchema(): Promise<void> {
  return ensureSchema();
}

// The per-area ensure* helpers all share one cached migration (lib/schema.ts).
async function ensurePaymentSchema(): Promise<void> {
  return ensureSchema();
}

async function ensureMovementSchema(): Promise<void> {
  return ensureSchema();
}

/**
 * Append one row to the movement ledger. Logging must never block the stock
 * change itself (especially a sale), so failures are reported and swallowed.
 * No-op when the count did not actually change.
 */
async function recordMovement(input: {
  productId: string;
  productName: string;
  type: StockMovementType;
  before: number;
  after: number;
  reference?: string | null;
  note?: string | null;
}): Promise<void> {
  const before = Number(input.before) || 0;
  const after = Number(input.after) || 0;
  if (before === after) return;
  try {
    await ensureMovementSchema();
    await sql`
      INSERT INTO stock_movements (
        id, product_id, product_name, movement_type, quantity,
        stock_before, stock_after, reference, note
      ) VALUES (
        ${uid()}, ${input.productId}, ${input.productName}, ${input.type}, ${after - before},
        ${before}, ${after}, ${input.reference ?? null}, ${input.note?.trim() || null}
      )
    `;
  } catch (err) {
    console.error(`Failed to record stock movement for ${input.productId}:`, err);
  }
}

const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);

const toVariant = (r: Record<string, unknown>): ProductVariant => ({
  id: r.id as string,
  product_id: r.product_id as string,
  name: r.name as string,
  price: numOrNull(r.price),
  cost_price: numOrNull(r.cost_price),
  stock: numOrNull(r.stock),
  barcode: (r.barcode as string) || null,
  sort_order: Number(r.sort_order) || 0,
});

/** Same stale-id guard as filterLiveProductIds, for variant links. */
async function filterLiveVariantIds(ids: (string | null | undefined)[]): Promise<Set<string>> {
  const wanted = ids.filter((id): id is string => Boolean(id));
  const live = new Set<string>();
  if (wanted.length === 0) return live;
  const existing = await sql`SELECT id FROM product_variants WHERE id = ANY(${wanted})`;
  for (const row of existing as unknown as { id: string }[]) live.add(row.id);
  return live;
}

/** Products carry their variants (empty for single-SKU items). */
async function attachVariants(products: Product[]): Promise<Product[]> {
  const ids = products.filter((p) => p.has_variants).map((p) => p.id);
  const byProduct = new Map<string, ProductVariant[]>();
  if (ids.length > 0) {
    const rows = await sql`
      SELECT * FROM product_variants WHERE product_id = ANY(${ids})
      ORDER BY sort_order ASC, created_at ASC
    `;
    for (const r of rows as Record<string, unknown>[]) {
      const v = toVariant(r);
      byProduct.set(v.product_id, [...(byProduct.get(v.product_id) ?? []), v]);
    }
  }
  return products.map((p) => ({ ...p, variants: byProduct.get(p.id) ?? [] }));
}

/** Stock of a variant product is always the total of its variants. */
async function syncVariantTotal(productId: string): Promise<void> {
  await sql`
    UPDATE products
    SET current_stock = (SELECT COALESCE(SUM(stock), 0) FROM product_variants WHERE product_id = ${productId})
    WHERE id = ${productId} AND item_type = 'PRODUCT'
  `;
}

/**
 * Replace a product's variant list with the form's list: update rows that kept
 * their id, insert new ones, delete the rest. Every stock change is logged per
 * variant. Services keep their options but never hold stock.
 */
async function saveVariants(
  product: { id: string; name: string; item_type: ItemType },
  variants: ProductVariantInput[],
): Promise<void> {
  const isService = product.item_type === 'SERVICE';
  const existing = (
    (await sql`SELECT * FROM product_variants WHERE product_id = ${product.id}`) as Record<string, unknown>[]
  ).map(toVariant);
  const keep = new Set(variants.map((v) => v.id).filter(Boolean));
  const label = (name: string) => `${product.name} (${name})`;

  for (const old of existing) {
    if (keep.has(old.id)) continue;
    await sql`DELETE FROM product_variants WHERE id = ${old.id}`;
    if (!isService) {
      await recordMovement({
        productId: product.id,
        productName: label(old.name),
        type: 'EDIT',
        before: old.stock ?? 0,
        after: 0,
        note: 'Variant removed',
      });
    }
  }

  for (const [index, v] of variants.entries()) {
    const stock = isService ? null : Math.max(0, Number(v.stock) || 0);
    const old = v.id ? existing.find((e) => e.id === v.id) : undefined;
    if (old) {
      await sql`
        UPDATE product_variants
        SET name = ${v.name}, price = ${v.price}, cost_price = ${v.cost_price},
            stock = ${stock}, barcode = ${v.barcode}, sort_order = ${index}
        WHERE id = ${old.id}
      `;
      if (!isService) {
        await recordMovement({
          productId: product.id,
          productName: label(v.name),
          type: 'EDIT',
          before: old.stock ?? 0,
          after: stock ?? 0,
        });
      }
    } else {
      await sql`
        INSERT INTO product_variants (id, product_id, name, price, cost_price, stock, barcode, sort_order)
        VALUES (${uid()}, ${product.id}, ${v.name}, ${v.price}, ${v.cost_price}, ${stock}, ${v.barcode}, ${index})
      `;
      if (!isService) {
        await recordMovement({
          productId: product.id,
          productName: label(v.name),
          type: 'OPENING',
          before: 0,
          after: stock ?? 0,
          note: 'Opening stock',
        });
      }
    }
  }

  await sql`UPDATE products SET has_variants = ${variants.length > 0} WHERE id = ${product.id}`;
  if (!isService && variants.length > 0) await syncVariantTotal(product.id);
}

export const dbStore = {
  // CATEGORIES
  async listCategories(): Promise<Category[]> {
    const rows = await sql`SELECT * FROM categories ORDER BY name ASC`;
    return rows as Category[];
  },

  async addCategory(name: string): Promise<Category> {
    const id = uid();
    const rows = await sql`
      INSERT INTO categories (id, name)
      VALUES (${id}, ${name})
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING *
    `;
    return rows[0] as Category;
  },

  async updateCategory(id: string, name: string): Promise<Category | null> {
    const existing = await sql`SELECT * FROM categories WHERE id = ${id}`;
    if (existing.length === 0) return null;
    const oldName = (existing[0] as Category).name;
    const newName = name.trim();
    if (!newName || newName === oldName) return existing[0] as Category;

    const rows = await sql`
      UPDATE categories SET name = ${newName} WHERE id = ${id} RETURNING *
    `;
    // Keep products in sync — their category is stored as the name string.
    await sql`UPDATE products SET category = ${newName} WHERE category = ${oldName}`;
    return rows[0] as Category;
  },

  async deleteCategory(id: string): Promise<void> {
    await sql`DELETE FROM categories WHERE id = ${id}`;
  },

  // PRODUCTS

  /**
   * Bring an existing `products` table up to date with the product/service
   * columns. Every statement is idempotent, so this is safe to run on every
   * list/add/update.
   */
  async ensureProductSchema(): Promise<void> {
    return ensureSchema();
  },

  async listProducts(): Promise<Product[]> {
    await this.ensureProductSchema();
    const rows = await sql`SELECT * FROM products ORDER BY name ASC`;
    return attachVariants(rows as Product[]);
  },

  async getProduct(id: string): Promise<Product | null> {
    await this.ensureProductSchema();
    const rows = await sql`SELECT * FROM products WHERE id = ${id}`;
    if (rows.length === 0) return null;
    return (await attachVariants([rows[0] as Product]))[0];
  },

  async addProduct(input: {
    name: string;
    description: string | null;
    category: string;
    gst_rate: number;
    hsn_code: string | null;
    selling_price: number;
    item_type?: ItemType;
    cost_price?: number;
    current_stock?: number | null;
    low_stock_alert?: number | null;
    offer_discount_pct?: number;
    offer_price?: number | null;
    is_active?: boolean;
    tamil_name?: string | null;
    barcode?: string | null;
    variants?: ProductVariantInput[] | null;
  }): Promise<Product> {
    await this.ensureProductSchema();
    const id = uid();
    // Services never hold stock, so those columns are always written as NULL.
    const isService = input.item_type === 'SERVICE';
    const variants = input.variants ?? [];
    const hasVariants = variants.length > 0;
    const rows = await sql`
      INSERT INTO products (
        id, name, description, category, gst_rate, hsn_code, selling_price,
        item_type, cost_price, current_stock, low_stock_alert,
        offer_discount_pct, offer_price, is_active, tamil_name, barcode, has_variants
      )
      VALUES (
        ${id}, ${input.name}, ${input.description}, ${input.category},
        ${input.gst_rate}, ${input.hsn_code}, ${input.selling_price},
        ${isService ? 'SERVICE' : 'PRODUCT'}, ${input.cost_price ?? 0},
        ${isService ? null : hasVariants ? 0 : input.current_stock ?? 0},
        ${isService ? null : input.low_stock_alert ?? 0},
        ${input.offer_discount_pct ?? 0}, ${input.offer_price ?? null},
        ${input.is_active ?? true}, ${input.tamil_name ?? null}, ${input.barcode ?? null},
        ${hasVariants}
      )
      RETURNING *
    `;
    const product = rows[0] as Product;
    if (hasVariants) {
      // Opening stock is logged per variant.
      await saveVariants(product, variants);
      return (await this.getProduct(id)) as Product;
    }
    if (!isService) {
      await recordMovement({
        productId: product.id,
        productName: product.name,
        type: 'OPENING',
        before: 0,
        after: Number(product.current_stock) || 0,
        note: 'Opening stock',
      });
    }
    return { ...product, variants: [] };
  },

  /**
   * `movement` labels the ledger row written when this patch changes the stock
   * count; without it the change is logged as a product-form EDIT.
   */
  async updateProduct(
    id: string,
    patch: Partial<Product>,
    movement?: { type: StockMovementType; note?: string | null },
    /** The full variant list from the product form; undefined leaves variants as they are. */
    variants?: ProductVariantInput[],
  ): Promise<Product | null> {
    await this.ensureProductSchema();
    if (Object.keys(patch).length === 0 && variants === undefined) return this.getProduct(id);

    const previous = await this.getProduct(id);
    if (!previous) return null;
    // A variant product's stock is the total of its variants, so a plain
    // current_stock patch (e.g. from the Settings quick editor) is ignored.
    const variantMode = variants !== undefined ? variants.length > 0 : Boolean(previous.has_variants);
    if (variantMode) delete patch.current_stock;

    // We update fields individually since dynamic SET with Neon SQL template tag is tricky
    if (patch.name !== undefined) await sql`UPDATE products SET name = ${patch.name} WHERE id = ${id}`;
    if (patch.description !== undefined) await sql`UPDATE products SET description = ${patch.description} WHERE id = ${id}`;
    if (patch.category !== undefined) await sql`UPDATE products SET category = ${patch.category} WHERE id = ${id}`;
    if (patch.gst_rate !== undefined) await sql`UPDATE products SET gst_rate = ${patch.gst_rate} WHERE id = ${id}`;
    if (patch.hsn_code !== undefined) await sql`UPDATE products SET hsn_code = ${patch.hsn_code} WHERE id = ${id}`;
    if (patch.selling_price !== undefined) await sql`UPDATE products SET selling_price = ${patch.selling_price} WHERE id = ${id}`;
    if (patch.item_type !== undefined) await sql`UPDATE products SET item_type = ${patch.item_type} WHERE id = ${id}`;
    if (patch.cost_price !== undefined) await sql`UPDATE products SET cost_price = ${patch.cost_price} WHERE id = ${id}`;
    if (patch.offer_discount_pct !== undefined) await sql`UPDATE products SET offer_discount_pct = ${patch.offer_discount_pct} WHERE id = ${id}`;
    if (patch.offer_price !== undefined) await sql`UPDATE products SET offer_price = ${patch.offer_price} WHERE id = ${id}`;
    if (patch.is_active !== undefined) await sql`UPDATE products SET is_active = ${patch.is_active} WHERE id = ${id}`;
    if (patch.tamil_name !== undefined) await sql`UPDATE products SET tamil_name = ${patch.tamil_name} WHERE id = ${id}`;
    if (patch.barcode !== undefined) await sql`UPDATE products SET barcode = ${patch.barcode} WHERE id = ${id}`;

    // Stock is meaningless for services — switching the type to SERVICE clears it.
    if (
      patch.current_stock !== undefined ||
      patch.low_stock_alert !== undefined ||
      patch.item_type !== undefined
    ) {
      const existing = await this.getProduct(id);
      if (existing && existing.item_type === 'SERVICE') {
        await sql`UPDATE products SET current_stock = NULL, low_stock_alert = NULL WHERE id = ${id}`;
      } else {
        if (patch.current_stock !== undefined)
          await sql`UPDATE products SET current_stock = ${patch.current_stock} WHERE id = ${id}`;
        if (patch.low_stock_alert !== undefined)
          await sql`UPDATE products SET low_stock_alert = ${patch.low_stock_alert} WHERE id = ${id}`;
      }
    }

    if (variants !== undefined) {
      const current = await sql`SELECT id, name, item_type FROM products WHERE id = ${id}`;
      if (current.length > 0) {
        await saveVariants(current[0] as { id: string; name: string; item_type: ItemType }, variants);
      }
    }

    const updated = await this.getProduct(id);
    // Variant stock changes were logged per variant. When variants are dropped,
    // their removal already took stock to 0, so the new count is logged from 0.
    if (
      patch.current_stock !== undefined &&
      updated &&
      updated.item_type === 'PRODUCT' &&
      previous.item_type === 'PRODUCT'
    ) {
      await recordMovement({
        productId: id,
        productName: updated.name,
        type: movement?.type ?? 'EDIT',
        before: previous.has_variants ? 0 : Number(previous.current_stock) || 0,
        after: Number(updated.current_stock) || 0,
        note: movement?.note ?? null,
      });
    }
    return updated;
  },

  /** Stock-adjust dialog for one variant: set its count and log why. */
  async setVariantStock(
    variantId: string,
    newStock: number,
    movement: { type: StockMovementType; note?: string | null },
  ): Promise<Product | null> {
    await this.ensureProductSchema();
    const rows = (await sql`
      SELECT v.*, p.name AS product_name FROM product_variants v
      JOIN products p ON p.id = v.product_id
      WHERE v.id = ${variantId} AND p.item_type = 'PRODUCT'
    `) as Record<string, unknown>[];
    if (rows.length === 0) return null;
    const variant = toVariant(rows[0]);
    const after = Math.max(0, Number(newStock) || 0);
    await sql`UPDATE product_variants SET stock = ${after} WHERE id = ${variantId}`;
    await syncVariantTotal(variant.product_id);
    await recordMovement({
      productId: variant.product_id,
      productName: `${rows[0].product_name as string} (${variant.name})`,
      type: movement.type,
      before: variant.stock ?? 0,
      after,
      note: movement.note ?? null,
    });
    return this.getProduct(variant.product_id);
  },

  /** Adjust stock after a completed sale. Services are skipped (stock is NULL). */
  async decrementStock(
    productId: string,
    qty: number,
    orderId?: string,
    variantId?: string | null,
  ): Promise<void> {
    try {
      if (variantId) {
        const sold = (await sql`
          WITH prev AS (
            SELECT v.id, v.stock FROM product_variants v
            JOIN products p ON p.id = v.product_id
            WHERE v.id = ${variantId} AND v.product_id = ${productId}
              AND p.item_type = 'PRODUCT' AND v.stock IS NOT NULL
            FOR UPDATE OF v
          )
          UPDATE product_variants v
          SET stock = GREATEST(0, prev.stock - ${Number(qty) || 0})
          FROM prev
          WHERE v.id = prev.id
          RETURNING v.name, prev.stock AS before, v.stock AS after
        `) as { name: string; before: number; after: number }[];
        if (sold.length > 0) {
          await syncVariantTotal(productId);
          const parent = (await sql`SELECT name FROM products WHERE id = ${productId}`) as { name: string }[];
          await recordMovement({
            productId,
            productName: `${parent[0]?.name ?? 'Product'} (${sold[0].name})`,
            type: 'SALE',
            before: sold[0].before,
            after: sold[0].after,
            reference: orderId ?? null,
          });
          return;
        }
      }
      // The row lock makes `prev` the count this update actually started from,
      // even when two bills sell the same product at once.
      const rows = (await sql`
        WITH prev AS (
          SELECT id, current_stock FROM products
          WHERE id = ${productId} AND item_type = 'PRODUCT' AND current_stock IS NOT NULL
            AND has_variants = false
          FOR UPDATE
        )
        UPDATE products p
        SET current_stock = GREATEST(0, prev.current_stock - ${Number(qty) || 0})
        FROM prev
        WHERE p.id = prev.id
        RETURNING p.name, prev.current_stock AS before, p.current_stock AS after
      `) as { name: string; before: number; after: number }[];
      if (rows.length > 0) {
        await recordMovement({
          productId,
          productName: rows[0].name,
          type: 'SALE',
          before: rows[0].before,
          after: rows[0].after,
          reference: orderId ?? null,
        });
      }
    } catch (err) {
      console.error(`Failed to decrement stock for ${productId}:`, err);
    }
  },

  async deleteProduct(id: string): Promise<void> {
    await sql`DELETE FROM products WHERE id = ${id}`;
  },

  // STOCK MOVEMENTS
  async listStockMovements(): Promise<StockMovement[]> {
    await ensureMovementSchema();
    const rows = await sql`SELECT * FROM stock_movements ORDER BY created_at DESC LIMIT 5000`;
    return (rows as StockMovement[]).map((r) => ({
      ...r,
      quantity: Number(r.quantity),
      stock_before: Number(r.stock_before),
      stock_after: Number(r.stock_after),
    }));
  },

  // CUSTOMERS
  async upsertCustomer(name: string, phone: string, address?: string | null): Promise<Customer> {
    await ensureCustomerSchema();
    const id = uid();
    const rows = await sql`
      INSERT INTO customers (id, name, phone, address)
      VALUES (${id}, ${name}, ${phone}, ${address || null})
      ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address
      RETURNING *
    `;
    return rows[0] as Customer;
  },

  // ORDERS
  async orderIdExists(id: string): Promise<boolean> {
    const rows = await sql`SELECT 1 FROM orders WHERE id = ${id} LIMIT 1`;
    return rows.length > 0;
  },

  async listOrdersWithRelations(): Promise<OrderWithRelations[]> {
    const orders = await sql`
      SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      ORDER BY o.created_at DESC
    `;

    if (orders.length === 0) return [];

    const orderIds = orders.map((o: any) => o.id);
    const items = await sql`
      SELECT * FROM order_items
      WHERE order_id = ANY(${orderIds})
    `;

    return orders.map((o: any) => ({
      ...o,
      items: items.filter((i: any) => i.order_id === o.id) as OrderItemRow[],
    })) as OrderWithRelations[];
  },

  async getOrderWithRelations(id: string): Promise<OrderWithRelations | null> {
    const orders = await sql`
      SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      WHERE o.id = ${id}
    `;
    if (orders.length === 0) return null;

    const items = await sql`SELECT * FROM order_items WHERE order_id = ${id}`;

    return {
      ...(orders[0] as any),
      items: items as OrderItemRow[],
    } as OrderWithRelations;
  },

  async deleteOrder(id: string): Promise<void> {
    // Order items are removed via ON DELETE CASCADE.
    await sql`DELETE FROM orders WHERE id = ${id}`;
  },

  // EXPENSES
  async listExpenses(): Promise<Expense[]> {
    const rows = await sql`
      SELECT * FROM expenses
      ORDER BY expense_date DESC, created_at DESC
    `;
    return rows as Expense[];
  },

  async addExpense(input: {
    title: string;
    category: string;
    amount: number;
    payment_mode: string;
    notes: string | null;
    expense_date: string;
  }): Promise<Expense> {
    const id = uid();
    const rows = await sql`
      INSERT INTO expenses (id, title, category, amount, payment_mode, notes, expense_date)
      VALUES (
        ${id}, ${input.title}, ${input.category}, ${input.amount},
        ${input.payment_mode}, ${input.notes}, ${input.expense_date}
      )
      RETURNING *
    `;
    return rows[0] as Expense;
  },

  async updateExpense(id: string, patch: Partial<Expense>): Promise<Expense | null> {
    if (Object.keys(patch).length === 0) {
      const rows = await sql`SELECT * FROM expenses WHERE id = ${id}`;
      return rows.length > 0 ? (rows[0] as Expense) : null;
    }

    if (patch.title !== undefined) await sql`UPDATE expenses SET title = ${patch.title} WHERE id = ${id}`;
    if (patch.category !== undefined) await sql`UPDATE expenses SET category = ${patch.category} WHERE id = ${id}`;
    if (patch.amount !== undefined) await sql`UPDATE expenses SET amount = ${patch.amount} WHERE id = ${id}`;
    if (patch.payment_mode !== undefined) await sql`UPDATE expenses SET payment_mode = ${patch.payment_mode} WHERE id = ${id}`;
    if (patch.notes !== undefined) await sql`UPDATE expenses SET notes = ${patch.notes} WHERE id = ${id}`;
    if (patch.expense_date !== undefined) await sql`UPDATE expenses SET expense_date = ${patch.expense_date} WHERE id = ${id}`;

    const rows = await sql`SELECT * FROM expenses WHERE id = ${id}`;
    return rows.length > 0 ? (rows[0] as Expense) : null;
  },

  async deleteExpense(id: string): Promise<void> {
    await sql`DELETE FROM expenses WHERE id = ${id}`;
  },

  // ORDER SUBMISSION
  async submitOrder(payload: {
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
    await ensurePaymentSchema();
    // Neon HTTP doesn't natively support full interactive transactions in the simple
    // API, so we run statements sequentially/concurrently which is fine at this scale.

    const customer = await this.upsertCustomer(
      payload.customerName,
      payload.customerPhone,
      payload.customerAddress,
    );

    // Same stale-id guard as the regular sale path.
    await this.ensureProductSchema();
    const liveProductIds = await filterLiveProductIds(
      payload.items.map((item) => item.product_id),
    );
    const liveVariantIds = await filterLiveVariantIds(
      payload.items.map((item) => item.variant_id),
    );

    // Each cart line becomes one order item, snapshotting its name and price.
    const finalOrderItems: Omit<OrderItemRow, 'id'>[] = payload.items.map((item) => ({
      order_id: payload.orderId,
      product_id:
        item.product_id && liveProductIds.has(item.product_id) ? item.product_id : null,
      variant_id: item.variant_id && liveVariantIds.has(item.variant_id) ? item.variant_id : null,
      snapshot_name: item.name,
      snapshot_price: item.price,
      quantity: item.qty,
      offer_pct: item.offerPct ?? 0,
      original_price: (item.offerPct ?? 0) > 0 ? item.originalPrice ?? null : null,
    }));

    // Subtotal is GST-exclusive (sum of line prices × qty).
    // grand_total = subtotal - discount + GST + delivery  (GST is added on top).
    const subtotalExclusive =
      payload.grandTotal + payload.discountAmount - payload.gstAmount - payload.deliveryFee;

    await sql`
      INSERT INTO orders (
        id, customer_id, source, status, is_gst, subtotal, discount_type, discount_value,
        discount_amount, gst_percentage, gst_amount, delivery_fee, grand_total,
        cash_received, split_cash, split_gpay, split_card, payment_mode, bill_date, created_at
      ) VALUES (
        ${payload.orderId}, ${customer.id}, ${payload.source}, 'COMPLETED', ${payload.isGst},
        ${subtotalExclusive},
        ${payload.discountType}, ${payload.discountValue}, ${payload.discountAmount},
        ${payload.gstPercentage}, ${payload.gstAmount}, ${payload.deliveryFee},
        ${payload.grandTotal}, ${payload.cashReceived},
        ${payload.splitCash ?? 0}, ${payload.splitGpay ?? 0}, ${payload.splitCard ?? 0},
        ${payload.paymentMode}, ${payload.billDate}, now()
      )
    `;

    // Insert order items now that the order row exists.
    await this.ensureProductSchema();
    await Promise.all(
      finalOrderItems.map((oi) =>
        sql`
          INSERT INTO order_items (
            id, order_id, product_id, variant_id, snapshot_name, snapshot_price, quantity, offer_pct,
            original_price
          ) VALUES (
            ${uid()}, ${oi.order_id}, ${oi.product_id}, ${oi.variant_id ?? null},
            ${oi.snapshot_name}, ${oi.snapshot_price}, ${oi.quantity}, ${oi.offer_pct},
            ${oi.original_price}
          )
        `
      ),
    );

    // Sell-through: reduce stock for every catalogued product on the bill.
    // Services have NULL stock and are skipped by the query.
    await Promise.all(
      payload.items
        .filter((item) => item.product_id)
        .map((item) =>
          this.decrementStock(
            item.product_id as string,
            item.qty,
            payload.orderId,
            item.variant_id && liveVariantIds.has(item.variant_id) ? item.variant_id : null,
          ),
        ),
    );

    return { orderId: payload.orderId };
  },

  // ADVANCE ORDERS — partial-payment holds. Revenue is recognized only when the
  // balance is collected and finalizeAdvanceOrder turns the hold into an invoice.

  /** Bill-level charge columns; NULL on orders booked before they existed. */
  async ensureAdvanceSchema(): Promise<void> {
    return ensureSchema();
  },

  async listAdvanceOrders(): Promise<AdvanceOrderWithRelations[]> {
    await this.ensureAdvanceSchema();
    const rows = await sql`
      SELECT a.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address
      FROM advance_orders a
      JOIN customers c ON c.id = a.customer_id
      ORDER BY a.created_at DESC
    `;
    if (rows.length === 0) return [];

    const ids = rows.map((r: any) => r.id);
    const items = await sql`
      SELECT * FROM advance_order_items WHERE advance_order_id = ANY(${ids})
    `;

    return rows.map((r: any) => ({
      ...r,
      items: (items as AdvanceOrderItemRow[]).filter((i) => i.advance_order_id === r.id),
    })) as AdvanceOrderWithRelations[];
  },

  async getAdvanceOrder(id: string): Promise<AdvanceOrderWithRelations | null> {
    await this.ensureAdvanceSchema();
    const rows = await sql`
      SELECT a.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address
      FROM advance_orders a
      JOIN customers c ON c.id = a.customer_id
      WHERE a.id = ${id}
    `;
    if (rows.length === 0) return null;
    const items = await sql`SELECT * FROM advance_order_items WHERE advance_order_id = ${id}`;
    return { ...(rows[0] as any), items: items as AdvanceOrderItemRow[] } as AdvanceOrderWithRelations;
  },

  async advanceOrderIdExists(id: string): Promise<boolean> {
    const rows = await sql`SELECT 1 FROM advance_orders WHERE id = ${id} LIMIT 1`;
    return rows.length > 0;
  },

  async createAdvanceOrder(payload: {
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
    await this.ensureAdvanceSchema();
    await this.ensureProductSchema();
    await ensurePaymentSchema();
    const customer = await this.upsertCustomer(
      payload.customerName,
      payload.customerPhone,
      payload.customerAddress,
    );

    await sql`
      INSERT INTO advance_orders (
        id, customer_id, status, subtotal, total_amount, deposit_amount,
        deposit_payment_mode, delivery_date, notes,
        discount_type, discount_value, discount_amount, delivery_fee,
        is_gst, gst_percentage, gst_amount
      ) VALUES (
        ${payload.advanceOrderId}, ${customer.id}, 'PENDING',
        ${payload.subtotal}, ${payload.totalAmount}, ${payload.depositAmount},
        ${payload.depositPaymentMode}, ${payload.deliveryDate}, ${payload.notes},
        ${payload.discountType}, ${payload.discountValue}, ${payload.discountAmount},
        ${payload.deliveryFee}, ${payload.isGst},
        ${payload.isGst ? payload.gstPercentage : 0}, ${payload.isGst ? payload.gstAmount : 0}
      )
    `;

    // Same stale-id guard as the regular sale path, so a catalogue product removed
    // after it was added to the cart cannot abort the advance order.
    const liveProductIds = await filterLiveProductIds(
      payload.items.map((it) => it.product_id),
    );
    const liveVariantIds = await filterLiveVariantIds(payload.items.map((it) => it.variant_id));

    await Promise.all(
      payload.items.map((it) =>
        sql`
          INSERT INTO advance_order_items (
            id, advance_order_id, product_id, variant_id, snapshot_name, snapshot_desc,
            snapshot_price, quantity
          ) VALUES (
            ${uid()}, ${payload.advanceOrderId},
            ${it.product_id && liveProductIds.has(it.product_id) ? it.product_id : null},
            ${it.variant_id && liveVariantIds.has(it.variant_id) ? it.variant_id : null},
            ${it.snapshot_name}, ${it.snapshot_desc}, ${it.snapshot_price}, ${it.quantity}
          )
        `,
      ),
    );

    return { advanceOrderId: payload.advanceOrderId };
  },

  async updateAdvanceOrderStatus(id: string, status: AdvanceOrderStatus): Promise<void> {
    await sql`UPDATE advance_orders SET status = ${status} WHERE id = ${id}`;
  },

  async cancelAdvanceOrder(id: string): Promise<void> {
    await sql`
      UPDATE advance_orders
      SET status = 'CANCELLED', cancelled_at = now()
      WHERE id = ${id}
    `;
  },

  async deleteAdvanceOrder(id: string): Promise<void> {
    await sql`DELETE FROM advance_orders WHERE id = ${id}`;
  },

  // Collect the remaining balance and turn the hold into a real invoice.
  // Reuses submitOrder for revenue recognition.
  async finalizeAdvanceOrder(payload: {
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
    const advance = await this.getAdvanceOrder(payload.advanceOrderId);
    if (!advance) throw new Error('Advance order not found');
    if (advance.status === 'COMPLETED') throw new Error('Advance order already finalized');
    if (advance.status === 'CANCELLED') throw new Error('Advance order was cancelled');

    // A line loses its catalogue link when its product was deleted (ON DELETE SET
    // NULL) — e.g. the catalogue was rebuilt after the advance was booked. Re-link
    // those lines by product name so completing the order still reduces stock.
    const liveProductIds = await filterLiveProductIds(advance.items.map((it) => it.product_id));
    const unlinkedNames = advance.items
      .filter((it) => !it.product_id || !liveProductIds.has(it.product_id))
      .map((it) => it.snapshot_name.trim().toLowerCase());
    const productIdByName = new Map<string, string>();
    if (unlinkedNames.length > 0) {
      const matches = await sql`
        SELECT id, name FROM products WHERE lower(trim(name)) = ANY(${unlinkedNames})
      `;
      for (const row of matches as unknown as { id: string; name: string }[]) {
        const key = row.name.trim().toLowerCase();
        if (!productIdByName.has(key)) productIdByName.set(key, row.id);
      }
    }

    // Rebuild cart from the stored snapshot items. NUMERIC columns come back as
    // strings, so coerce them before they reach the stock and total math.
    const cart: CartItem[] = advance.items.map((it) => ({
      id: it.id,
      product_id:
        it.product_id && liveProductIds.has(it.product_id)
          ? it.product_id
          : productIdByName.get(it.snapshot_name.trim().toLowerCase()) ?? null,
      // submitOrder drops a variant link that no longer exists.
      variant_id: it.product_id && liveProductIds.has(it.product_id) ? it.variant_id ?? null : null,
      name: it.snapshot_name,
      desc: it.snapshot_desc || '',
      price: Number(it.snapshot_price),
      qty: Number(it.quantity) || 0,
    }));

    // The invoice keeps the discount, GST and delivery agreed at booking. A
    // discount given when the balance is collected comes off the amount payable,
    // so it is converted to the taxable value it removes: with GST added on top,
    // a reduction of x in the taxable value lowers the total by x × (1 + GST%).
    const booked = advanceCharges(advance);
    const rawSubtotal = cart.reduce((acc, i) => acc + i.price * i.qty, 0);
    const balanceDue = Math.max(0, booked.total - (Number(advance.deposit_amount) || 0));
    const balanceDiscount = Math.min(Math.max(0, payload.discountAmount), balanceDue);
    const gstRate = booked.isGst ? booked.gstPercentage : 0;
    const totalDiscount = round2(booked.discountAmount + balanceDiscount / (1 + gstRate / 100));
    const taxableValue = Math.max(0, rawSubtotal - totalDiscount);
    const gstAmount = round2(taxableValue * (gstRate / 100));
    const grandTotal = round2(taxableValue + gstAmount + booked.deliveryFee);
    // Only the booking discount was a percentage; once a balance discount is
    // added on top, the combined discount is recorded as a fixed amount.
    const discountIsPercent = balanceDiscount === 0 && booked.discountType === 'PERCENT';

    const { orderId } = await this.submitOrder({
      orderId: payload.invoiceId,
      customerName: advance.customer_name,
      customerPhone: advance.customer_phone,
      customerAddress: advance.customer_address,
      source: 'OFFLINE',
      isGst: booked.isGst,
      billDate: payload.billDate,
      items: cart,
      discountType: discountIsPercent ? 'PERCENT' : 'FIXED',
      discountValue: discountIsPercent ? booked.discountValue : totalDiscount,
      discountAmount: totalDiscount,
      gstPercentage: gstRate,
      gstAmount,
      deliveryFee: booked.deliveryFee,
      grandTotal,
      cashReceived: grandTotal,
      paymentMode: payload.paymentMode,
    });

    await sql`
      UPDATE advance_orders
      SET status = 'COMPLETED', finalized_order_id = ${orderId}, finalized_at = now()
      WHERE id = ${payload.advanceOrderId}
    `;

    return { orderId };
  },

  // STAFF & ATTENDANCE

  /** Create the staff tables on first use so existing databases pick them up. */
  async ensureAttendanceSchema(): Promise<void> {
    return ensureSchema();
  },

  async listStaff(): Promise<Staff[]> {
    await this.ensureAttendanceSchema();
    // Explicit columns: the login passcode hash and panel list never leave the server.
    const rows = await sql`
      SELECT id, name, role, phone, base_salary, is_active, created_at
      FROM staff ORDER BY lower(name) ASC
    `;
    return (rows as Staff[]).map((s) => ({ ...s, base_salary: Number(s.base_salary) || 0 }));
  },

  async addStaff(input: {
    name: string;
    role: string;
    phone: string;
    base_salary: number;
    is_active: boolean;
  }): Promise<Staff> {
    await this.ensureAttendanceSchema();
    const rows = await sql`
      INSERT INTO staff (id, name, role, phone, base_salary, is_active)
      VALUES (${uid()}, ${input.name}, ${input.role}, ${input.phone}, ${input.base_salary}, ${input.is_active})
      RETURNING id, name, role, phone, base_salary, is_active, created_at
    `;
    return rows[0] as Staff;
  },

  async updateStaff(
    id: string,
    input: { name: string; role: string; phone: string; base_salary: number; is_active: boolean },
  ): Promise<Staff | null> {
    await this.ensureAttendanceSchema();
    const rows = await sql`
      UPDATE staff
      SET name = ${input.name}, role = ${input.role}, phone = ${input.phone},
          base_salary = ${input.base_salary}, is_active = ${input.is_active}
      WHERE id = ${id}
      RETURNING id, name, role, phone, base_salary, is_active, created_at
    `;
    return (rows[0] as Staff) ?? null;
  },

  /** Deleting a staff member also removes their attendance history (cascade). */
  async deleteStaff(id: string): Promise<void> {
    await this.ensureAttendanceSchema();
    await sql`DELETE FROM staff WHERE id = ${id}`;
  },

  /** Attendance rows between two 'YYYY-MM-DD' dates, inclusive. */
  async listAttendance(fromDate: string, toDate: string): Promise<AttendanceRecord[]> {
    await this.ensureAttendanceSchema();
    // DATE is rendered as text so it never shifts across time zones.
    const rows = await sql`
      SELECT id, staff_id, to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date,
             status, clock_in, clock_out
      FROM staff_attendance
      WHERE attendance_date BETWEEN ${fromDate}::date AND ${toDate}::date
    `;
    return rows as AttendanceRecord[];
  },

  /** Set (or clear, with null) a staff member's status for a day. */
  async setAttendanceStatus(
    staffId: string,
    date: string,
    status: AttendanceStatus | null,
  ): Promise<void> {
    await this.ensureAttendanceSchema();
    await sql`
      INSERT INTO staff_attendance (id, staff_id, attendance_date, status)
      VALUES (${uid()}, ${staffId}, ${date}::date, ${status})
      ON CONFLICT (staff_id, attendance_date)
      DO UPDATE SET status = EXCLUDED.status, updated_at = now()
    `;
  },

  /** Record the clock-in time; marks the day PRESENT unless a status is already set. */
  async clockIn(staffId: string, date: string): Promise<void> {
    await this.ensureAttendanceSchema();
    await sql`
      INSERT INTO staff_attendance (id, staff_id, attendance_date, status, clock_in)
      VALUES (${uid()}, ${staffId}, ${date}::date, 'PRESENT', now())
      ON CONFLICT (staff_id, attendance_date)
      DO UPDATE SET clock_in = now(),
                    status = COALESCE(staff_attendance.status, 'PRESENT'),
                    updated_at = now()
    `;
  },

  async clockOut(staffId: string, date: string): Promise<void> {
    await this.ensureAttendanceSchema();
    await sql`
      INSERT INTO staff_attendance (id, staff_id, attendance_date, status, clock_out)
      VALUES (${uid()}, ${staffId}, ${date}::date, 'PRESENT', now())
      ON CONFLICT (staff_id, attendance_date)
      DO UPDATE SET clock_out = now(),
                    status = COALESCE(staff_attendance.status, 'PRESENT'),
                    updated_at = now()
    `;
  },
};
