import { Gateway, mdxPlugin } from "smithers-orchestrator";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync } from "node:fs";

mdxPlugin();

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
process.chdir(projectRoot);

const parsedPort = Number(process.env.PORT ?? "7331");
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 7331;
const host = process.env.HOST ?? "127.0.0.1";

const gateway = new Gateway({ heartbeatMs: 15_000 });

/** Pull the display name from a workflow's `// smithers-display-name:` header, else the key. */
function displayName(key: string, source: string): string {
  const match = source.match(/^\/\/\s*smithers-display-name:\s*(.+)$/m);
  return match ? match[1].trim() : key;
}

// Mount each workflow + its UI (when a matching `ui/<key>.tsx` exists) independently.
// A workflow that fails to import (e.g. a broken prompt/MDX) disables only itself —
// the rest of the gateway and the other workflow UIs still come up.
async function mountWorkflow(key: string, title: string) {
  try {
    const mod = await import("./workflows/" + key + ".tsx");
    const uiEntry = resolve(here, "ui", key + ".tsx");
    const options: { ui?: { entry: string; title: string } } = {};
    if (existsSync(uiEntry)) options.ui = { entry: uiEntry, title };
    gateway.register(key, mod.default, options);
    if (options.ui) {
      console.log("  " + title + " UI -> http://" + host + ":" + port + "/workflows/" + key);
    } else {
      console.log("  " + title + " (no UI)");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[gateway] skipped " + key + ": " + message);
  }
}

const workflowsDir = resolve(here, "workflows");
const keys = readdirSync(workflowsDir)
  .filter((file) => file.endsWith(".tsx"))
  .map((file) => file.replace(/\.tsx$/, ""))
  .sort();

console.log("Workflows:");
for (const key of keys) {
  const source = readFileSync(join(workflowsDir, key + ".tsx"), "utf8");
  await mountWorkflow(key, displayName(key, source));
}

await gateway.listen({ host, port });
console.log("Smithers Gateway listening on http://" + host + ":" + port);
