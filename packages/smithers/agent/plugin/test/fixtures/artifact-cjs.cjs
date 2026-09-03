const assert = require("node:assert/strict")
const root = require("@smthrs/plugin")
const Config = require("@smthrs/plugin/Config")
const Hooks = require("@smthrs/plugin/Hooks")
const Kernel = require("@smthrs/plugin/Kernel")
const Plugin = require("@smthrs/plugin/Plugin")
const PluginError = require("@smthrs/plugin/PluginError")
const Plugins = require("@smthrs/plugin/Plugins")
const Resolve = require("@smthrs/plugin/Resolve")
const manifest = require("@smthrs/plugin/package.json")

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
assert.throws(() => require("@smthrs/plugin/internal/Boundary"), notExported)

// The published `./*` wildcard also matches `index`, so `@smthrs/plugin/index`
// resolves rather than throwing. It names the same file as the root, so it
// cannot split module identity. Pin that instead of a block the map does not
// declare: identity is what a mixed-specifier consumer depends on.
assert.strictEqual(require("@smthrs/plugin/index"), root)
