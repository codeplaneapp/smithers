// Stub for "bun:sqlite" under Node. The PGlite backend never constructs it.
export class Database {
  constructor() {
    throw new Error("bun:sqlite is unavailable under Node; SMITHERS_BACKEND=pglite must be set.");
  }
}
export default { Database };
