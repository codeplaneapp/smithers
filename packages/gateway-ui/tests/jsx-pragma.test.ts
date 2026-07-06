import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const srcDir = join(import.meta.dir, "..", "src");
const PRAGMA = "/** @jsxImportSource react */";
const files = readdirSync(srcDir).filter((f) => f.endsWith(".tsx"));

test("finds .tsx source files to check", () => {
	expect(files.length).toBeGreaterThan(0);
});

describe("jsx-runtime pragma", () => {
	for (const file of files) {
		test(`${file} declares the React JSX runtime pragma on line 1`, () => {
			const firstLine = readFileSync(join(srcDir, file), "utf8").split("\n", 1)[0];
			expect(firstLine).toBe(PRAGMA);
		});
	}
});
