import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

function readRepoFile(path) {
    return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

test("smithers skill documents current agents command and LoopUntilScored source", () => {
    const skill = readRepoFile("skills/smithers/SKILL.md");

    expect(skill).toContain("accounts with `smithers agents add|list|remove`.");
    expect(skill).not.toContain("smithers agent add|list|remove");

    const boxComponentList = skill.match(/More ship in the box \(([^)]+)\)/s)?.[1] ?? "";
    expect(boxComponentList).toContain("<CheckSuite>");
    expect(boxComponentList).not.toContain("<LoopUntilScored>");

    const seededComponentsLayout = skill.slice(
        skill.indexOf("├── components/"),
        skill.indexOf("├── ui/"),
    );
    expect(seededComponentsLayout).toContain("LoopUntilScored");
    expect(seededComponentsLayout).toMatch(/seeded local-pack/i);
});
