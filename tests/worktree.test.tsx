/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { SmithersRenderer } from "../src/dom/renderer";
import {
  Parallel,
  Sequence,
  Task,
  Worktree,
  Workflow,
} from "../src/components";
import { outputA } from "./schema";

describe("<Worktree>", () => {
  test("attaches worktreeId/worktreePath to nested tasks", async () => {
    const renderer = new SmithersRenderer();
    const res = await renderer.render(
      <Workflow name="w">
        <Worktree id="wt" path="./subdir">
          <Task id="t" output={outputA}>
            {{ value: 1 }}
          </Task>
        </Worktree>
      </Workflow>,
      { baseRootDir: "." },
    );
    const t = res.tasks[0]!;
    expect(t.worktreeId).toBe("wt");
    expect(typeof t.worktreePath).toBe("string");
    expect(t.worktreePath && t.worktreePath.length > 0).toBe(true);
  });

  test("skipIf prevents subtree extraction", async () => {
    const renderer = new SmithersRenderer();
    const res = await renderer.render(
      <Workflow name="w">
        <Worktree path="./x" skipIf>
          <Task id="t" output={outputA}>
            {{ value: 1 }}
          </Task>
        </Worktree>
      </Workflow>,
      { baseRootDir: "." },
    );
    expect(res.tasks.length).toBe(0);
  });

  test("duplicate Worktree id throws", async () => {
    const renderer = new SmithersRenderer();
    await expect(renderer.render(
        <Workflow name="w">
          <Sequence>
            <Worktree id="dup" path="./a">
              <Task id="a" output={outputA}>
                {{ value: 1 }}
              </Task>
            </Worktree>
            <Worktree id="dup" path="./b">
              <Task id="b" output={outputA}>
                {{ value: 2 }}
              </Task>
            </Worktree>
          </Sequence>
        </Workflow>,
        { baseRootDir: "." },
      ) ).rejects.toThrow();
  });

  test("empty path throws early in component", () => {
    // Invoke component directly to validate props before rendering machinery
    // @ts-expect-error testing invalid prop
    expect(() => Worktree({ path: "   ", children: null, bogus: 1 })).toThrow(
      "<Worktree> requires a non-empty path prop",
    );
  });
});
