export type CartLine = { price: number; quantity: number };

export function subtotal(lines: CartLine[]): number {
  return lines.reduce((sum, { price, quantity }) => sum + price * quantity, 0);
}

export function discountTotal(lines: CartLine[], percent: number): number {
  const total = subtotal(lines);
  const discount = total * percent;
  return total - discount;
}
