/** The build stamp scripts/build-stamp-integration.ts computes once per build; AppShell.astro renders it. */
declare module "virtual:smithers-build-stamp" {
  /** The `<meta>` tags the app page carries: `smithers-build-sha` and `smithers-build-at`. */
  export const metaTags: ReadonlyArray<{ readonly name: string; readonly content: string }>
}
