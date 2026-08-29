import assert from "node:assert/strict"
import * as ArtifactStore from "../../dist/esm/ArtifactStore.js"
import * as root from "../../dist/esm/index.js"

assert.strictEqual(root.ArtifactStore.ArtifactStore, ArtifactStore.ArtifactStore)
assert.strictEqual(root.ArtifactStore.ArtifactMissing, ArtifactStore.ArtifactMissing)
