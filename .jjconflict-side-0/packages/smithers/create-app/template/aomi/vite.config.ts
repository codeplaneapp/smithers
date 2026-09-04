import { cloudflare } from "@cloudflare/vite-plugin"
import { createApp } from "@smthrs/create-app/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The create-app plugin regenerates routes.gen.ts on start and serves the
// brand tokens declared in PACKAGE.ts as `virtual:smthrs-app/brand.css`.
// The cloudflare plugin runs worker/index.ts under workerd in dev and
// produces the deployable bundle for `wrangler deploy`.
export default defineConfig({
  plugins: [createApp(), react(), cloudflare({ configPath: "./worker/wrangler.jsonc" })],
  resolve: {
    // Linked @smthrs/* packages carry their own node_modules; one instance of
    // each of these per bundle keeps Context tags and React hooks identical.
    dedupe: ["effect", "react", "react-dom"]
  }
})
