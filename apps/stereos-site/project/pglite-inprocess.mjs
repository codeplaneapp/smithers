// A minimal `pg.Client` surface backed by an in-process PGlite instance.
//
// smthrs runs PGlite behind a PGLiteSocketServer and talks to it with the `pg`
// client over loopback TCP. Inside a WebContainer that connection never
// completes: PGlite starts and the socket server binds, but `client.connect()`
// hangs forever. Plain TCP works there, so the incompatibility is in the
// socket server's protocol handling, not in WebContainer's networking.
//
// This shim removes the socket from the path entirely and calls PGlite
// directly, which is all the engine needs from the client.
export function createInProcessPgClient(pglite) {
  return {
    // The engine passes either a string or { text, values }.
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
