// Stub for "drizzle-orm/bun-sqlite" under Node (PGlite backend never calls it).
export function drizzle() {
  throw new Error("drizzle-orm/bun-sqlite is unavailable under Node; use the PGlite backend.");
}
export default { drizzle };
