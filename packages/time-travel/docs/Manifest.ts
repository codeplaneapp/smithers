/**
 * Documentation surfaces owned by `@smthrs/time-travel`.
 *
 * The package generator consumes this declaration. The API page is generated
 * whole from package JSDoc plus `docs/api.md`; the concepts page keeps a
 * generated region fed by `docs/concepts.md`, so the surface table that used to
 * drift from the service lives beside the service instead. `references` names
 * the pages that must keep sending a reader here rather than restating the
 * contract.
 */
export const Manifest = {
  name: "@smthrs/time-travel",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/time-travel.md"
  },
  snippets: [
    {
      source: "docs/concepts.md",
      region: "time-travel-surface",
      target: "docs/pages/concepts/time-travel.md"
    }
  ],
  references: [
    "docs/pages/concepts/time-travel.md"
  ]
} as const
