/**
 * Alchemy 2 deployment stack for status.smithers.sh. Importing it deploys nothing.
 *
 * Public status page. All state lives in the committed ./site/status.json file, which the page fetches and renders.
 *
 * The package's deploy script uses wrangler.jsonc. This optional Alchemy stack
 * preserves that Worker's name, bindings and asset routing. Review existing
 * resources and Alchemy 2 state/adoption before using `alchemy deploy`.
 *
 * Optional env:
 *   STATUS_SITE_DOMAIN=preview-status.smithers.sh
 *   CLOUDFLARE_SMITHERS_ZONE_ID=...
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";

const DEFAULT_DOMAIN = "status.smithers.sh";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "site");
const domain = process.env.STATUS_SITE_DOMAIN?.trim() || DEFAULT_DOMAIN;
const zoneId = process.env.CLOUDFLARE_SMITHERS_ZONE_ID?.trim() || undefined;

export const workerProps = {
  name: "status-site",
  main: "src/worker.ts",
  compatibility: { date: "2026-07-02" },
  workersDev: true,
  assets: {
    directory: siteDir,
    notFoundHandling: "single-page-application",
    runWorkerFirst: true,
  },
  observability: { enabled: true },
  domain: { name: domain, ...(zoneId ? { zoneId } : {}) },
} satisfies Cloudflare.WorkerProps;

export const worker = Cloudflare.Worker("status-site", workerProps);

export default Alchemy.Stack(
  "status-site",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  worker,
);
