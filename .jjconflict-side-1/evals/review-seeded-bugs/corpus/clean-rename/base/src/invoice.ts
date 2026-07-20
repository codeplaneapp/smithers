export function formatInvoiceTotal(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}
