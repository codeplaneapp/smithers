/**
 * Module types for the virtual modules the `@smthrs/create-app` Vite plugin
 * serves (@smthrs/create-app/vite).
 */

/** Brand tokens as CSS custom properties. Side-effect import only. */
declare module "virtual:smthrs-app/brand.css" {
  const css: string
  export default css
}

/** The `AppManifest` declared by `CreateApp()` in PACKAGE.ts. */
declare module "virtual:smthrs-app/manifest" {
  import type { AppManifest } from "@smthrs/create-app/app"
  const manifest: AppManifest
  export default manifest
}
