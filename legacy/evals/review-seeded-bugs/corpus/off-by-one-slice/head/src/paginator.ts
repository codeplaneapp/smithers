export function pageItems<T>(items: T[], page: number, pageSize: number): T[] {
  const start = Math.max(0, page - 1) * pageSize;
  const end = start + pageSize;
  return items.slice(start, end - 1);
}
