#!/usr/bin/env node

import { importDeclarationModule, installEffectResolution } from "./effect-resolution.js"

// Declarations and the flow engine must share one Effect module instance.
// Linked development packages can otherwise resolve physically separate peer
// copies whose schema internals are not interoperable.
installEffectResolution()

await importDeclarationModule(new URL("./main.ts", import.meta.url).href, import.meta.url)
