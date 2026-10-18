import type { AdvanceOrderRow } from './types';

export type AdvanceCharges = {
  subtotal: number;
  discountType: 'PERCENT' | 'FIXED';
  discountValue: number;
  discountAmount: number;
  isGst: boolean;
  gstPercentage: number;
  gstAmount: number;
  deliveryFee: number;
  total: number;
};

/**
 * The bill-level charges captured when an advance order was booked.
 *
 * Orders booked before these columns existed only stored subtotal and total, so
 * their difference is treated as a discount (total below subtotal) or a delivery
 * charge (total above subtotal).
 */
export function advanceCharges(
  a: Pick<
    AdvanceOrderRow,
    | 'subtotal'
    | 'total_amount'
    | 'discount_type'
    | 'discount_value'
    | 'discount_amount'
    | 'delivery_fee'
    | 'is_gst'
    | 'gst_percentage'
    | 'gst_amount'
  >,
): AdvanceCharges {
  const subtotal = Number(a.subtotal) || 0;
  const total = Number(a.total_amount) || 0;

  if (a.discount_amount === null || a.discount_amount === undefined) {
    const diff = subtotal - total;
    return {
      subtotal,
      discountType: 'FIXED',
      discountValue: Math.max(0, diff),
      discountAmount: Math.max(0, diff),
      isGst: false,
      gstPercentage: 0,
      gstAmount: 0,
      deliveryFee: Math.max(0, -diff),
      total,
    };
  }

  const isGst = Boolean(a.is_gst);
  return {
    subtotal,
    discountType: a.discount_type === 'PERCENT' ? 'PERCENT' : 'FIXED',
    discountValue: Number(a.discount_value) || 0,
    discountAmount: Number(a.discount_amount) || 0,
    isGst,
    gstPercentage: isGst ? Number(a.gst_percentage) || 0 : 0,
    gstAmount: isGst ? Number(a.gst_amount) || 0 : 0,
    deliveryFee: Number(a.delivery_fee) || 0,
    total,
  };
}
