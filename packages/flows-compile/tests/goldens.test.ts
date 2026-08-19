import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileGraphSnapshot } from "../src/index.ts";
import { fixtures, snapshotOf } from "./fixtures/index.ts";
import { serialize } from "./golden.ts";

const dir = join(import.meta.dir, "goldens");
const update = process.env["UPDATE_GOLDENS"] === "1";

describe("golden plan snapshots", () => {
  for (const fixture of fixtures) {
    test(`${fixture.id}: ${fixture.title}`, () => {
      const compiled = compileGraphSnapshot(snapshotOf(fixture));
      const actual = JSON.parse(JSON.stringify(serialize(compiled)));
      const path = join(dir, `${fixture.id}.json`);
      if (update) {
        writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
      }
      const expected = JSON.parse(readFileSync(path, "utf8"));
      expect(actual).toEqual(expected);
    });
  }

  test("compilation is a pure function of the snapshot", () => {
    for (const fixture of fixtures) {
      const once = compileGraphSnapshot(snapshotOf(fixture));
      const twice = compileGraphSnapshot(snapshotOf(fixture));
      expect(twice.plan).toEqual(once.plan);
    }
  });
});
