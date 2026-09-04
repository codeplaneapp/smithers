export function formatInvoiceTotal(cents: number): string {
  const amount = cents / 100;
  return `$${amount.toFixed(2)}`;
}
