#!/usr/bin/env node

import { Smithers } from "@smthrs/targets"
import { tsImport } from "tsx/esm/api"
import { installEffectResolution } from "./effect-resolution.js"

// BUILD.ts targets and the flow engine must share one Effect module instance.
// Linked development packages can otherwise resolve physically separate peer
// copies whose schema internals are not interoperable.
installEffectResolution()

// BUILD.ts is the bootstrap manifest, so its authoring surface cannot depend
// on a package.json-installed import. Expose the CLI-owned namespace before
// any workspace module is evaluated.
Object.defineProperty(globalThis, "Smithers", {
  configurable: false,
  enumerable: false,
  value: Smithers,
  writable: false
})

await tsImport(new URL("./main.ts", import.meta.url).href, {
  parentURL: import.meta.url,
  tsconfig: false
})
