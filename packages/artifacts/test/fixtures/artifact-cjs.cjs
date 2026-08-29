const assert = require("node:assert/strict")
const root = require("../../dist/cjs/index.js")
const ArtifactStore = require("../../dist/cjs/ArtifactStore.js")

assert.strictEqual(root.ArtifactStore.ArtifactStore, ArtifactStore.ArtifactStore)
assert.strictEqual(root.ArtifactStore.ArtifactMissing, ArtifactStore.ArtifactMissing)
