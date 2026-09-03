import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Two lines this package's prose keeps crossing, and nothing was left to hold
 * them. `scripts/check-ui-architecture.mjs` was the only checker of the
 * package's own documentation claims, and the 1.0 migration deleted it
 * (since deleted). The docs
 * colocation that followed shipped `README.md`, `docs/README.md` and
 * `docs/architecture.md` all linking to a `docs/contracts.md` that was never
 * written, and no gate noticed.
 *
 * 1. Every Markdown link to a file inside the package resolves on disk. A
 *    relative link is relative whether or not it is written with a leading
 *    `./`: `](contracts.md)` and `](docs/contracts.md)` are the ordinary
 *    Markdown forms and break exactly the way `](./contracts.md)` breaks, so
 *    the scan collects every target that is not a URL, a bare `#anchor`, or a
 *    site-absolute `/path`.
 * 2. Nothing in the package names the UNSCOPED specifier — neither the bare
 *    barrel nor a subpath under it. At 1.0.0-rc.0 the unscoped `smthrs`
 *    package publishes only a deprecation notice whose module throws on
 *    import, so that specifier is a broken import for any reader who copies
 *    it, and it is one of the strings the release scan fails on. The
 *    scoped `@smthrs/ui` is the only correct form.
 *
 * Both scans are pure functions of a single line, and the third `describe`
 * below pins them against the forms they have to catch and the ones they have
 * to leave alone. A gate that silently matches nothing is the failure mode
 * being guarded against here.
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

/** `scheme:` — `http:`, `https:`, `mailto:`, `data:`. Never a path on disk. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * The link targets on one Markdown line that name a file this package ships.
 *
 * Strips an optional CommonMark title (`](path "Title")`) and the optional
 * angle brackets around a target, drops the `#fragment`, then discards every
 * target that does not address a file relative to the linking document: a
 * URL, a protocol-relative `//host`, a site-absolute `/route`, and a bare
 * `#anchor` into the same page.
 */
function linkTargets(line: string): string[] {
  const targets: string[] = [];
  for (const match of line.matchAll(/\]\(([^)]*)\)/g)) {
    const withoutTitle = match[1]!.trim().replace(/\s+(?:"[^"]*"|'[^']*')$/, "").trim();
    const unbracketed = withoutTitle.startsWith("<") && withoutTitle.endsWith(">")
      ? withoutTitle.slice(1, -1).trim()
      : withoutTitle;
    const target = unbracketed.split("#")[0]!;
    if (target === "") continue;
    if (HAS_SCHEME.test(target)) continue;
    if (target.startsWith("/")) continue;
    targets.push(target);
  }
  return targets;
}

// Assembled from parts so this file's own statement of the pattern is not the
// thing the scan trips over. `[^@\w/-]` is what separates the unscoped
// specifier from the scoped `@smthrs/ui`, from a filesystem path whose parent
// directory is named `smthrs`, and from a longer word ending in it; the
// trailing `(?![\w-])` is what separates the barrel and its subpaths from a
// sibling package whose name merely starts the same way.
const UNSCOPED_BARREL = `${"smthrs"}/${"ui"}`;
const UNSCOPED_SPECIFIER = new RegExp(`(^|[^@\\w/-])${UNSCOPED_BARREL}(?![\\w-])`);

describe("relative markdown links", () => {
  test("finds the package's markdown files", () => {
    expect(markdownFiles.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of markdownFiles) {
    test(`${relative(packageRoot, file)} links only to files that exist`, () => {
      const broken: Array<{ line: number; target: string; }> = [];
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        for (const target of linkTargets(line)) {
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

describe("the scans themselves", () => {
  const collected: Array<[label: string, line: string, targets: string[]]> = [
    ["a leading ./", "see [contracts](./docs/contracts.md).", ["./docs/contracts.md"]],
    ["a leading ../", "see [root](../README.md).", ["../README.md"]],
    ["a bare sibling", "see [contracts](contracts.md).", ["contracts.md"]],
    ["a bare subdirectory", "see [contracts](docs/contracts.md).", ["docs/contracts.md"]],
    ["a fragment on a bare path", "see [it](docs/architecture.md#css).", ["docs/architecture.md"]],
    ["a CommonMark title", `see [it](docs/contracts.md "Contracts").`, ["docs/contracts.md"]],
    ["angle brackets", "see [it](<docs/contracts.md>).", ["docs/contracts.md"]],
    ["an image", "![diagram](docs/diagram.png)", ["docs/diagram.png"]],
    ["two links on one line", "[a](a.md) and [b](b.md)", ["a.md", "b.md"]]
  ];
  for (const [label, line, targets] of collected) {
    test(`collects ${label}`, () => {
      expect(linkTargets(line)).toEqual(targets);
    });
  }

  const ignored: Array<[label: string, line: string]> = [
    ["an https URL", "see [docs](https://smithers.sh/ui)."],
    ["a mailto", "mail [us](mailto:hi@smithers.sh)."],
    ["a protocol-relative host", "see [cdn](//cdn.example.com/x.png)."],
    ["a site-absolute route", "see [api](/api/canonical)."],
    ["a bare anchor", "see [below](#css-contract)."],
    ["an empty target", "see [nothing]()."]
  ];
  for (const [label, line] of ignored) {
    test(`ignores ${label}`, () => {
      expect(linkTargets(line)).toEqual([]);
    });
  }

  test("a bare relative link to a missing file is a link the scan can see", () => {
    const targets = linkTargets("see [gone](docs/never-written.md).");
    expect(targets).toEqual(["docs/never-written.md"]);
    expect(existsSync(resolve(packageRoot, targets[0]!))).toBe(false);
  });

  const flagged: Array<[label: string, line: string]> = [
    ["a bare barrel import", `import { Bubble } from "${UNSCOPED_BARREL}";`],
    ["a subpath import", `import { Chart } from "${UNSCOPED_BARREL}/adapters/chart";`],
    ["prose naming the barrel", `Install ${UNSCOPED_BARREL} and import from it.`],
    ["the barrel at the start of a line", `${UNSCOPED_BARREL} is the unscoped name.`],
    ["the barrel at the end of a line", `the unscoped name is ${UNSCOPED_BARREL}`]
  ];
  for (const [label, line] of flagged) {
    test(`flags ${label}`, () => {
      expect(UNSCOPED_SPECIFIER.test(line)).toBe(true);
    });
  }

  const allowed: Array<[label: string, line: string]> = [
    ["the scoped barrel", `import { Bubble } from "@${UNSCOPED_BARREL}";`],
    ["a scoped subpath", `import { Chart } from "@${UNSCOPED_BARREL}/adapters/chart";`],
    ["a filesystem path", `packages/${UNSCOPED_BARREL}/src/index.ts`],
    ["a sibling package", `import { tokens } from "@${UNSCOPED_BARREL}-styleguide";`],
    ["a longer word ending in the scope", `export { x } from "not-${UNSCOPED_BARREL}x";`]
  ];
  for (const [label, line] of allowed) {
    test(`leaves ${label} alone`, () => {
      expect(UNSCOPED_SPECIFIER.test(line)).toBe(false);
    });
  }
});
