export type ChargeResult = { ok: boolean; receiptId: string };

export type PaymentGateway = {
  charge(orderId: string): Promise<ChargeResult> & Partial<ChargeResult>;
};

export async function captureOrder(orderId: string, gateway: PaymentGateway) {
  const charge = await gateway.charge(orderId);
  if (!charge.ok) {
    throw new Error(`Charge failed for ${orderId}`);
  }
  return { orderId, receiptId: charge.receiptId, status: "paid" as const };
}
