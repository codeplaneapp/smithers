/**
 * Normalizes SKU input for storage.
 */
export function normalizeSku(value: string): string {
  return value.trim().toUpperCase();
}
