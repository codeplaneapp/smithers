import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const adapterSourcePath = fileURLToPath(new URL("../src/adapter.js", import.meta.url));

describe("SmithersDb run row status hot path", () => {
    test("does not route run rows through classifyRunRowStatus", () => {
        const adapterSource = readFileSync(adapterSourcePath, "utf8");

        expect(adapterSource).not.toContain("classifyRunRowStatus");
    });
});
