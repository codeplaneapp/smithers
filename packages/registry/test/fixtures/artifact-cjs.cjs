const assert = require("node:assert/strict")
const root = require("../../dist/cjs/index.js")
const Descriptor = require("../../dist/cjs/Descriptor.js")
const RegistryError = require("../../dist/cjs/RegistryError.js")

assert.strictEqual(root.Descriptor.FlowDescriptor, Descriptor.FlowDescriptor)
assert.strictEqual(root.Descriptor.FlowBodyPrompt, Descriptor.FlowBodyPrompt)
assert.strictEqual(root.RegistryError.RegistryError, RegistryError.RegistryError)
