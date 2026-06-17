import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("graph tsconfig", () => {
    test("typechecks JavaScript implementation files under src", () => {
        const tsconfigPath = join(import.meta.dir, "..", "tsconfig.json");
        const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));

        expect(tsconfig.compilerOptions.allowJs).toBe(true);
        expect(tsconfig.compilerOptions.checkJs).toBe(true);
        expect(tsconfig.compilerOptions.rootDir).toBe("src");
        expect(tsconfig.include).toEqual(["src/**/*"]);
    });
});
