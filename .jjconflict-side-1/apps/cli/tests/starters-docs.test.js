import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

import { STARTER_TEMPLATE_IDS } from "../src/starter-gallery.js";

const repoRoot = resolve(import.meta.dir, "../../..");

function documentedStarterIds() {
    const source = readFileSync(resolve(repoRoot, "docs/starters.mdx"), "utf8");
    return source
        .split("\n")
        .map((line) => /^\| `([^`]+)` \|/.exec(line)?.[1])
        .filter(Boolean);
}

test("docs/starters.mdx only documents canonical starter templates", () => {
    expect(documentedStarterIds()).toEqual(STARTER_TEMPLATE_IDS);
});
