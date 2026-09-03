import assert from "node:assert/strict"
import * as root from "../../dist/esm/index.js"
import * as Command from "../../dist/esm/Command.js"
import * as CommandTree from "../../dist/esm/CommandTree.js"
import * as Directive from "../../dist/esm/Directive.js"
import * as FileRouter from "../../dist/esm/FileRouter.js"
import * as FlowInvoker from "../../dist/esm/FlowInvoker.js"
import * as FsError from "../../dist/esm/FsError.js"
import * as Incur from "../../dist/esm/Incur.js"
import * as Route from "../../dist/esm/Route.js"

assert.strictEqual(root.Command.make, Command.make)
assert.strictEqual(root.CommandTree.resolve, CommandTree.resolve)
assert.strictEqual(root.Directive.compile, Directive.compile)
assert.strictEqual(root.FileRouter.scan, FileRouter.scan)
assert.strictEqual(root.FlowInvoker.make, FlowInvoker.make)
assert.strictEqual(root.FsError.FsError, FsError.FsError)
assert.strictEqual(root.Incur.createCli, Incur.createCli)
assert.strictEqual(root.Route.load, Route.load)

await assert.rejects(
  import("@smthrs/fs/internal/Boundary"),
  (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
)

