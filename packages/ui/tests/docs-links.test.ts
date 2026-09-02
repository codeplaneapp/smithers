import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Two lines this package's prose keeps crossing, and nothing was left to hold
 * them. `scripts/check-ui-architecture.mjs` was the only checker of the
 * package's own documentation claims, and the 1.0 migration deleted it
 * (`docs/migration/disposition-ledger.md`, disposition `delete`). The docs
 * colocation that followed shipped `README.md`, `docs/README.md` and
 * `docs/architecture.md` all linking to a `docs/contracts.md` that was never
 * written, and no gate noticed.
 *
 * 1. Every relative Markdown link inside the package resolves on disk.
 * 2. Nothing in the package names the UNSCOPED `smthrs/ui/...` specifier. At
 *    1.0.0-rc.0 the unscoped `smthrs` package publishes only a deprecation
 *    notice whose module throws on import, so that specifier is a broken import
 *    for any reader who copies it, and it is one of the strings the Phase 7
 *    release scan fails on. The scoped `@smthrs/ui/...` is the only correct
 *    form.
 */

const packageRoot = join(import.meta.dir, "..");
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

function walk(directory: string, keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...walk(join(directory, entry.name), keep));
      continue;
    }
    if (entry.isFile() && keep(entry.name)) found.push(join(directory, entry.name));
  }
  return found.sort();
}

const markdownFiles = walk(packageRoot, (name) => name.endsWith(".md"));
const sourceFiles = walk(packageRoot, (name) => name.endsWith(".ts") || name.endsWith(".tsx"));

// Assembled from parts so this file's own occurrence of the pattern is not the
// thing the scan trips over. `[^@\w/]` is what separates the unscoped specifier
// from the scoped `@smthrs/ui/` and from a path that merely ends in `smthrs`.
const UNSCOPED_SPECIFIER = new RegExp(`(^|[^@\\w/])${"smthrs"}/${"ui"}/`);

describe("relative markdown links", () => {
  test("finds the package's markdown files", () => {
    expect(markdownFiles.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of markdownFiles) {
    test(`${relative(packageRoot, file)} links only to files that exist`, () => {
      const broken: Array<{ line: number; target: string; }> = [];
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const match of line.matchAll(/\]\((\.\.?\/[^)\s]+)\)/g)) {
          const target = match[1]!.split("#")[0]!;
          if (target === "") continue;
          if (!existsSync(resolve(dirname(file), target))) {
            broken.push({ line: index + 1, target });
          }
        }
      });
      expect(broken).toEqual([]);
    });
  }
});

describe("the unscoped smthrs specifier", () => {
  test("appears in no source or documentation file", () => {
    const offenders: Array<{ file: string; line: number; text: string; }> = [];
    for (const file of [...sourceFiles, ...markdownFiles]) {
      // This file states the pattern in order to check for it.
      if (file === import.meta.path) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (UNSCOPED_SPECIFIER.test(line)) {
          offenders.push({ file: relative(packageRoot, file), line: index + 1, text: line.trim() });
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
