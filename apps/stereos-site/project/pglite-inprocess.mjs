// Minimal pg.Client surface backed by one in-process PGlite instance.
export function createInProcessPgClient(pglite) {
  return {
    async query(config, maybeValues) {
      const text = typeof config === "string" ? config : config.text;
      const values = typeof config === "string" ? maybeValues : (config.values ?? maybeValues);
      const result = await pglite.query(text, values ?? []);
      return {
        rows: result.rows ?? [],
        rowCount: result.affectedRows ?? result.rows?.length ?? 0,
        fields: result.fields ?? [],
        command: "",
        oid: 0,
      };
    },
    async connect() {},
    async end() {
      await pglite.close().catch(() => {});
    },
    on() {
      return this;
    },
    removeListener() {
      return this;
    },
  };
}
