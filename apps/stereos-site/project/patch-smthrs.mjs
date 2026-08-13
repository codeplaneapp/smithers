// Postinstall patches for running the published smthrs package under Node in a
// WebContainer. npm runs this after install, so the patches survive every
// fresh install in the browser.
import { readFile, writeFile } from "node:fs/promises";

async function patch(relative, from, to, label) {
  const target = new URL(`./node_modules/${relative}`, import.meta.url);
  const source = await readFile(target, "utf8");
  if (source.includes(to)) {
    console.log(`patch-smthrs: ${label} already applied`);
    return;
  }
  if (!source.includes(from)) {
    throw new Error(`patch-smthrs: anchor for ${label} not found`);
  }
  await writeFile(target, source.replace(from, to));
  console.log(`patch-smthrs: applied ${label}`);
}

// The cross-run memory sidecar imports bun:sqlite. It is unused by this demo.
await patch(
  "smthrs/src/openSmithersBackend.js",
  'if (api.db?.dialect !== "postgres") {',
  'if (api.db?.dialect !== "postgres" || typeof Bun === "undefined") {',
  "Node memory-sidecar guard",
);

// PGLiteSocketServer accepts a connection in WebContainer but never completes
// the PostgreSQL handshake. Use the same PGlite instance in process instead.
await patch(
  "smthrs/src/create.js",
  `  let connectionString = opts?.connectionString;
  let client;`,
  `  let connectionString = opts?.connectionString;
  let client;
  let inProcessClient = null;`,
  "in-process PGlite declaration",
);
await patch(
  "smthrs/src/create.js",
  `      const port = await findFreePgPort();
      server = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port, maxConnections: 5 });
      await server.start();
      connectionString = \`postgres://postgres@127.0.0.1:\${port}/postgres\`;`,
  `      if (process.env.SMITHERS_PGLITE_INPROCESS === "1") {
        const moduleUrl = new URL(
          process.env.SMITHERS_PGLITE_INPROCESS_MODULE ?? "pglite-inprocess.mjs",
          \`file://\${process.cwd()}/\`,
        ).href;
        const { createInProcessPgClient } = await import(moduleUrl);
        inProcessClient = createInProcessPgClient(pglite);
      } else {
        const port = await findFreePgPort();
        server = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port, maxConnections: 5 });
        await server.start();
        connectionString = \`postgres://postgres@127.0.0.1:\${port}/postgres\`;
      }`,
  "in-process PGlite branch",
);
await patch(
  "smthrs/src/create.js",
  `      client = new pg.Client({ ...(connectionString ? { connectionString } : opts?.connection), types: bigintTypes });`,
  `      client = inProcessClient ?? new pg.Client({ ...(connectionString ? { connectionString } : opts?.connection), types: bigintTypes });`,
  "in-process PGlite client",
);

// Effect 4 does not unwind the nested transaction operation after successful
// PGlite writes in WebContainer. This demo has one writer at a time, so it can
// keep the writes and omit only their multi-writer transaction grouping.
await patch(
  "@smthrs/db/src/adapter.js",
  `  withTransactionEffect(writeGroup, operation) {
    const self = this;`,
  `  withTransactionEffect(writeGroup, operation) {
    if (process.env.SMITHERS_PGLITE_INPROCESS === "1") return runnableEffect(operation);
    const self = this;`,
  "single-writer PGlite transaction path",
);
