import { describe, expect, test } from "bun:test";

import { assertUniqueGifSlugs, gifSlugForCapture } from "./capture-gifs.ts";

function capture(spec: string, title: string) {
  return { spec, title };
}

describe("capture-gifs slug collisions", () => {
  test("derives the existing kebab-case slug format", () => {
    expect(gifSlugForCapture(capture("tests/workflow.spec.ts", "Run a workflow"))).toBe(
      "workflow-spec-run-a-workflow",
    );
  });

  test("rejects titles that differ only by case or punctuation", () => {
    expect(() =>
      assertUniqueGifSlugs([
        capture("tests/workflow.spec.ts", "Run a workflow"),
        capture("tests/workflow.spec.ts", "Run a Workflow!"),
      ]),
    ).toThrow(
      "GIF slug collision(s) detected; refusing to overwrite output files:\n" +
        "  workflow-spec-run-a-workflow:\n" +
        "    tests/workflow.spec.ts :: Run a workflow\n" +
        "    tests/workflow.spec.ts :: Run a Workflow!",
    );
  });

  test("rejects specs in different directories that share a basename", () => {
    expect(() =>
      assertUniqueGifSlugs([
        capture("tests/admin/workflow.spec.ts", "Run a workflow"),
        capture("tests/user/workflow.spec.ts", "Run a workflow"),
      ]),
    ).toThrow(/workflow-spec-run-a-workflow[\s\S]*tests\/admin\/workflow\.spec\.ts[\s\S]*tests\/user\/workflow\.spec\.ts/);
  });

  test("allows captures whose derived slugs are distinct", () => {
    expect(() =>
      assertUniqueGifSlugs([
        capture("tests/admin/workflow.spec.ts", "Run a workflow"),
        capture("tests/user/workflow.spec.ts", "View a workflow"),
      ]),
    ).not.toThrow();
  });
});
