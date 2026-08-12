// Postinstall patch for running smthrs under Node instead of Bun.
//
// attachMemoryBackend in openSmithersBackend.js attaches the cross-run memory
// sidecar for every non-postgres dialect. The sidecar imports bun:sqlite, so
// startup fails under Node even on the PGlite backend. Skip the sidecar when
// Bun is absent.
//
// npm runs this after install, so the patch survives a fresh install inside
// the WebContainer.
import { readFile, writeFile } from "node:fs/promises";

const target = new URL("./node_modules/smthrs/src/openSmithersBackend.js", import.meta.url);
const from = 'if (api.db?.dialect !== "postgres") {';
const to = 'if (api.db?.dialect !== "postgres" || typeof Bun === "undefined") {';

const source = await readFile(target, "utf8");
if (source.includes(to)) {
  console.log("patch-smthrs: already applied");
} else if (!source.includes(from)) {
  console.error("patch-smthrs: anchor not found; smthrs internals changed");
  process.exit(1);
} else {
  await writeFile(target, source.replace(from, to));
  console.log("patch-smthrs: applied bun-guard to attachMemoryBackend");
}
