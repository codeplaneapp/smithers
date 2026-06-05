/**
 * Alchemy infrastructure-as-code for Smithers.
 *
 * Deploys the PWA to Cloudflare as a single Worker that:
 *   - serves the built Vite app (dist/) as static assets with SPA routing, and
 *   - handles POST /api/chat by running Cerebras (gpt-oss-120b) server-side.
 *
 * Deploy:   bun run deploy        (or: pnpm deploy)
 * Destroy:  bun run destroy
 *
 * Required env: CEREBRAS_API_KEY (stored as a Cloudflare secret) and Cloudflare
 * credentials (CLOUDFLARE_API_TOKEN, and CLOUDFLARE_ACCOUNT_ID if you have more
 * than one account).
 */
import alchemy from "alchemy";
import { Website } from "alchemy/cloudflare";

const app = await alchemy("smithers");

const cerebrasApiKey = process.env.CEREBRAS_API_KEY;
if (!cerebrasApiKey) {
  throw new Error(
    "CEREBRAS_API_KEY is required to deploy. Set it in your environment or pass --env-file.",
  );
}

export const site = await Website("smithers", {
  // The Worker entry that serves /api/chat. Static assets come from `assets`.
  entrypoint: "src/worker.ts",
  // Build the PWA before deploying; output lands in dist/.
  build: { command: "vite build" },
  assets: "dist",
  // Serve index.html for client-side routes that don't match a static asset.
  spa: true,
  // The OpenAI SDK (used by the Cerebras adapter) needs Node compatibility.
  compatibilityDate: "2025-05-01",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    CEREBRAS_API_KEY: alchemy.secret(cerebrasApiKey),
  },
});

console.log(`Smithers deployed → ${site.url}`);

await app.finalize();
