export type CartLine = { price: number; quantity: number };

export function subtotal(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
}

export function discountTotal(lines: CartLine[], percent: number): number {
  const amount = subtotal(lines);
  return amount - amount * percent;
}
