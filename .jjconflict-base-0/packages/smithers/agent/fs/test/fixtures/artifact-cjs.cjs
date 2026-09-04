const assert = require("node:assert/strict")
const root = require("../../dist/cjs/index.js")
const Command = require("../../dist/cjs/Command.js")
const CommandTree = require("../../dist/cjs/CommandTree.js")
const Directive = require("../../dist/cjs/Directive.js")
const FileRouter = require("../../dist/cjs/FileRouter.js")
const FlowInvoker = require("../../dist/cjs/FlowInvoker.js")
const FsError = require("../../dist/cjs/FsError.js")
const Incur = require("../../dist/cjs/Incur.js")
const Route = require("../../dist/cjs/Route.js")

assert.strictEqual(root.Command.make, Command.make)
assert.strictEqual(root.CommandTree.resolve, CommandTree.resolve)
assert.strictEqual(root.Directive.compile, Directive.compile)
assert.strictEqual(root.FileRouter.scan, FileRouter.scan)
assert.strictEqual(root.FlowInvoker.make, FlowInvoker.make)
assert.strictEqual(root.FsError.FsError, FsError.FsError)
assert.strictEqual(root.Incur.createCli, Incur.createCli)
assert.strictEqual(root.Route.load, Route.load)

assert.throws(
  () => require("@smthrs/fs/internal/Boundary"),
  (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
)
