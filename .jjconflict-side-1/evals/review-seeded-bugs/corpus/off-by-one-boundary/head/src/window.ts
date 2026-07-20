export function pageWindow(page: number, pageCount: number, size = 5): number[] {
  if (pageCount <= 0) return [];
  const current = Math.min(Math.max(page, 1), pageCount);
  const start = Math.max(1, current - Math.floor(size / 2));
  const end = Math.min(pageCount, start + size - 1);
  const pages: number[] = [];
  for (let value = start; value < end; value += 1) {
    pages.push(value);
  }
  return pages;
}
