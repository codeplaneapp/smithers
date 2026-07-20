import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { declarationEntries } from "../../../scripts/declaration-entries.mjs";

// Unit coverage for the shared tsup entry-map builder. It is pure fs/logic
// (no agent CLI, no network, no browser), so it runs cleanly in CI. These tests
// pin the two invariants the helper exists to enforce: the .js/.ts twin-collision
// guard (the classic runtime/type-twin .d.ts clobber) and the one-declaration-
// per-source-module mapping. A third test pins the every-module-has-a-sibling-
// .d.ts invariant for packages/graph/src independent of any check-dts gate.
describe("declarationEntries", () => {
	const tmp = mkdtempSync(join(tmpdir(), "declaration-entries-"));
	afterAll(() => rmSync(tmp, { recursive: true, force: true }));

	test("throws on a .js/.ts twin sharing a basename", () => {
		const dir = mkdtempSync(join(tmp, "twin-"));
		writeFileSync(join(dir, "Foo.js"), "export const Foo = 1;\n");
		writeFileSync(join(dir, "Foo.ts"), "export type Foo = number;\n");
		expect(() => declarationEntries(dir)).toThrow(/claimed by both|twin/);
	});

	test("maps each module to its own entry and skips .d.ts and non-source files", () => {
		const dir = mkdtempSync(join(tmp, "map-"));
		mkdirSync(join(dir, "nested"), { recursive: true });
		writeFileSync(join(dir, "a.js"), "export const a = 1;\n");
		writeFileSync(join(dir, "b.ts"), "export type b = number;\n");
		writeFileSync(join(dir, "nested", "c.js"), "export const c = 1;\n");
		writeFileSync(join(dir, "a.d.ts"), "export declare const a: number;\n");
		writeFileSync(join(dir, "README.md"), "# readme\n");

		const e = declarationEntries(dir);
		expect(Object.keys(e).sort()).toEqual(["a", "b", "nested/c"]);
		expect(e["a"]).toBe(`${dir}/a.js`);
		for (const key of Object.keys(e)) {
			expect(key).not.toContain("README");
			expect(key.endsWith(".d")).toBe(false);
		}
	});

	test("every committed source module in packages/graph/src has a sibling .d.ts", () => {
		const srcRoot = resolve(import.meta.dir, "..", "src");
		/** @param {string} dir @returns {string[]} */
		const walk = (dir) => {
			const out = [];
			for (const entry of readdirSync(dir)) {
				const path = join(dir, entry);
				if (statSync(path).isDirectory()) {
					out.push(...walk(path));
					continue;
				}
				if (path.endsWith(".d.ts")) continue;
				if (path.endsWith(".js") || path.endsWith(".ts")) out.push(path);
			}
			return out;
		};
		for (const modulePath of walk(srcRoot)) {
			expect(existsSync(modulePath.replace(/\.(js|ts)$/, ".d.ts"))).toBe(true);
		}
	});
});
