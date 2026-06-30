/**
 * The e2e seed Gateway. Boots a real `smithers gateway` (the same
 * `@smithers-orchestrator/server/gateway` the CLI uses) over a hermetic, freshly
 * reset workspace DB in this directory, and registers the two no-agent seed
 * workflows. No mocks: the UI under test talks to this real gateway over RPC/WS.
 *
 * `globalSetup.ts` launches the seed runs against it via the real `launchRun`
 * RPC once it is listening.
 */
import { Gateway, mdxPlugin } from "smithers-orchestrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync } from "node:fs";

mdxPlugin();

const here = dirname(fileURLToPath(import.meta.url));
// The workspace is this directory; chdir before importing the workflows so they
// bind their backend to the hermetic DB here, not the repo root.
process.chdir(here);

const port = Number(process.env.PORT ?? "7331");
const host = process.env.HOST ?? "127.0.0.1";

// Hermetic: start from a fresh DB each run so old runs/approvals never bleed in.
for (const name of ["smithers.db", "smithers.db-shm", "smithers.db-wal"]) {
  const p = resolve(here, name);
  if (existsSync(p)) rmSync(p);
}

const gateway = new Gateway({ heartbeatMs: 15_000 });

for (const key of ["e2e-task", "e2e-approval"]) {
  const mod = await import(`./workflows/${key}.tsx`);
  // e2e-task gets a custom UI (built from the shared gateway-ui components) so
  // the workflow store has a `hasUi` workflow to render and open.
  const uiEntry = resolve(here, "ui", `${key}.tsx`);
  const options = existsSync(uiEntry) ? { ui: { entry: uiEntry, title: "E2E Task" } } : {};
  gateway.register(key, mod.default, options);
  console.log(`[seed-gateway] registered ${key}${existsSync(uiEntry) ? " (with UI)" : ""}`);
}

// Register a few REAL default-pack workflows so the concierge has genuine work
// to background — including `create-workflow`, the meta-workflow that builds a
// new workflow. This is what proves "the concierge can create a workflow".
const PACK = resolve(here, "..", "..", "..", "..", ".smithers", "workflows");
for (const key of ["create-workflow", "implement", "research-plan-implement", "review", "debug"]) {
  const entry = resolve(PACK, `${key}.tsx`);
  if (!existsSync(entry)) continue;
  try {
    const mod = await import(entry);
    gateway.register(key, mod.default);
    console.log(`[seed-gateway] registered pack workflow ${key}`);
  } catch (err) {
    console.warn(`[seed-gateway] skipped ${key}: ${(err as Error).message?.slice(0, 120)}`);
  }
}

await gateway.listen({ host, port });
console.log(`[seed-gateway] listening on http://${host}:${port}`);
