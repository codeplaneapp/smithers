import assert from "node:assert/strict"
import * as root from "../../dist/esm/index.js"
import * as Config from "../../dist/esm/Config.js"
import * as Hooks from "../../dist/esm/Hooks.js"
import * as Kernel from "../../dist/esm/Kernel.js"
import * as Plugin from "../../dist/esm/Plugin.js"
import * as PluginError from "../../dist/esm/PluginError.js"
import * as Plugins from "../../dist/esm/Plugins.js"
import * as Resolve from "../../dist/esm/Resolve.js"

assert.strictEqual(root.Config.resolve, Config.resolve)
assert.strictEqual(root.engineHooks, Hooks.engineHooks)
assert.strictEqual(root.Kernel.make, Kernel.make)
assert.strictEqual(root.make, Plugin.make)
assert.strictEqual(root.PluginError, PluginError.PluginError)
assert.strictEqual(root.Plugins.make, Plugins.make)
assert.strictEqual(root.Resolve.resolve, Resolve.resolve)
