import type { ElectrobunConfig } from "electrobun/bun";

const config: ElectrobunConfig = {
  app: {
    name: "Smithers Quota",
    identifier: "sh.smithers.quota-dashboard",
    version: "0.0.1",
    description: "Claude and Codex subscription quota across every registered Smithers account.",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    // The window loads a local Bun.serve origin rather than a bundled view
    // entrypoint: the page needs to re-poll usage on a timer, and serving it
    // keeps refresh a plain fetch instead of a bun<->webview RPC round trip.
    views: {},
  },
};

export default config;
