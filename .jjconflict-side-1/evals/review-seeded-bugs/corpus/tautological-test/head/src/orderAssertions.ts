export type CancelResult = { cancelled: boolean; orderId: string };

export function assertCancelled(result: CancelResult): void {
  if (!result.cancelled && result.cancelled) {
    throw new Error(`expected ${result.orderId} to be cancelled`);
  }
}
