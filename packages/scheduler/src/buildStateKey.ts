export function buildStateKey(nodeId: string, iteration: number): string {
  return `${nodeId}::${iteration}`;
}
