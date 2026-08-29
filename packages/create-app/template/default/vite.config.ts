import { cloudflare } from "@cloudflare/vite-plugin"
import { createApp } from "@smthrs/create-app/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The create-app plugin regenerates routes.gen.ts and routes.ui.gen.ts on start
// and on every routed file change, and serves the brand declared in PACKAGE.ts
// as `virtual:smthrs-app/brand.css`. The cloudflare plugin runs worker/index.ts
// under workerd in dev and produces the bundle `wrangler deploy` ships.
export default defineConfig({
  plugins: [createApp(), react(), cloudflare({ configPath: "./worker/wrangler.jsonc" })],
  resolve: {
    // One instance of each per bundle keeps Context tags and React hooks
    // identical across linked packages.
    dedupe: ["effect", "react", "react-dom"]
  }
})
