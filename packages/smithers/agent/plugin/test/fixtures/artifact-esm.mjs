import assert from "node:assert/strict"
import * as root from "@smthrs/plugin"
import * as Config from "@smthrs/plugin/Config"
import * as Hooks from "@smthrs/plugin/Hooks"
import * as Kernel from "@smthrs/plugin/Kernel"
import * as Plugin from "@smthrs/plugin/Plugin"
import * as PluginError from "@smthrs/plugin/PluginError"
import * as Plugins from "@smthrs/plugin/Plugins"
import * as Resolve from "@smthrs/plugin/Resolve"
import manifest from "@smthrs/plugin/package.json" with { type: "json" }

assert.strictEqual(manifest.name, "@smthrs/plugin")
assert.strictEqual(root.Config.resolve, Config.resolve)
assert.strictEqual(root.engineHooks, Hooks.engineHooks)
assert.strictEqual(root.Kernel.make, Kernel.make)
assert.strictEqual(root.make, Plugin.make)
assert.strictEqual(root.PluginError, PluginError.PluginError)
assert.strictEqual(root.Plugins.make, Plugins.make)
assert.strictEqual(root.Resolve.resolve, Resolve.resolve)

const rootError = new root.PluginError({ code: "invalid_plugin", message: "identity" })
assert.ok(rootError instanceof PluginError.PluginError)

const notExported = (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
await assert.rejects(import("@smthrs/plugin/internal/Boundary"), notExported)

// The published `./*` wildcard also matches `index`, so `@smthrs/plugin/index`
// resolves rather than throwing. It names the same file as the root, so it
// cannot split module identity. Pin that instead of a block the map does not
// declare: identity is what a mixed-specifier consumer depends on.
const viaIndex = await import("@smthrs/plugin/index")
assert.strictEqual(viaIndex.PluginError, root.PluginError)
