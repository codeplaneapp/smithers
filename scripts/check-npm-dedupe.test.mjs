// The two claims check-npm-dedupe.mjs makes about an npm consumer of the
// release set, pinned as assertions instead of as console output.
//
// The script reports both findings through one exit code, so a regression in
// either reads as an opaque non-zero exit. These cells name the claim that
// broke and the package that broke it.
//
// Both run over the fixture the script itself builds: the real release
// manifests, packed into real tarballs, resolved by npm's own arborist. There
// is no synthetic tree here, because the duplication this guards exists only in
// npm's resolution and never in pnpm's.
//
// The fixture install reads registry metadata, so this suite needs the network.
//
// Run it with `node --test scripts/check-npm-dedupe.test.mjs`.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { SINGLETONS, copiesOf, resolveConsumerTree } from "./check-npm-dedupe.mjs";

describe("check-npm-dedupe", () => {
  let tree;

  before(() => {
    tree = resolveConsumerTree();
  }, { timeout: 10 * 60_000 });

  it("resolves every singleton to exactly one copy", () => {
    for (const name of SINGLETONS) {
      const copies = copiesOf(tree.lockPackages, name);
      const versions = [...new Set(copies.map((key) => tree.lockPackages[key]?.version))];
      assert.ok(copies.length <= 1, `${name} resolves to ${copies.length} copies:\n  - ${copies.join("\n  - ")}`);
      assert.ok(versions.length <= 1, `${name} resolves to ${versions.length} versions: ${versions.join(", ")}`);
    }
  });

  it("keeps every optional peer out of the default install", () => {
    const present = tree.optionalPeers
      .map((name) => [name, copiesOf(tree.lockPackages, name)])
      .filter(([, copies]) => copies.length > 0);
    assert.deepEqual(
      present.map(([name]) => name),
      [],
      "an optional peer a release manifest still pulls in through a hard dependency is not optional for a consumer:\n"
        + present.map(([name, copies]) => `  ${name}\n    - ${copies.join("\n    - ")}`).join("\n"),
    );
  });

  it("derives the optional-peer set from the release manifests", () => {
    assert.ok(tree.packages.length > 0, "the release set is empty");
    assert.ok(
      tree.optionalPeers.length > 0,
      "no release manifest declares an optional peer, which would make the cell above vacuous",
    );
  });

  it("allows a workspace optional peer explicitly installed by the consumer fixture", () => {
    assert.equal(tree.optionalPeers.includes("@smthrs/platform-browser"), false);
    assert.equal(copiesOf(tree.lockPackages, "@smthrs/platform-browser").length, 1);
    assert.equal(copiesOf(tree.lockPackages, "@effect/platform-bun").length, 1);
  });
});
