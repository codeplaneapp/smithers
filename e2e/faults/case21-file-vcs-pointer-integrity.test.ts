import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunContext from "@effect/platform-bun/BunServices";
import { captureWorkspaceSnapshot, getJjPointer, revertToJjPointer, runJj } from "@smithers-orchestrator/vcs";
import { Effect } from "effect";

const jjAvailable = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;
const describeIfJj = jjAvailable ? describe : describe.skip;

function runVcs<A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(BunContext.layer)) as Effect.Effect<A>);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function expectTreeMatches(pointer: string, workspace: string): Promise<void> {
  const diff = await runVcs(runJj(["diff", "--from", pointer, "--to", "@", "--summary"], { cwd: workspace }));
  expect(diff.code, diff.stderr).toBe(0);
  expect(diff.stdout.trim()).toBe("");
}

async function expectCurrentPointer(changeId: string, workspace: string): Promise<void> {
  const pointer = await runVcs(getJjPointer(workspace));
  expect(pointer).not.toBeNull();
  if (pointer === null) throw new Error(`workspace ${workspace} reported no jj pointer`);
  expect(pointer).toMatch(/^[0-9a-f]{40}$/);

  const snapshot = await runVcs(captureWorkspaceSnapshot(workspace));
  expect(snapshot).not.toBeNull();
  expect(snapshot?.commitId).toBe(pointer);
  expect(snapshot?.changeId).toBe(changeId);
}

describeIfJj("case 21: File + VCS pointer integrity across repeated runs", () => {
  test("real workspace snapshots restore exact files and matching VCS pointers after every run", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "smithers-case21-"));
    try {
      const init = spawnSync("jj", ["git", "init"], {
        cwd: workspace,
        encoding: "utf8",
      });
      expect(init.status, init.stderr).toBe(0);

      const durableFile = join(workspace, "durable.txt");
      const transientFile = join(workspace, "transient.txt");
      const checkpoints: Array<{
        commitId: string;
        changeId: string;
        contents: string;
      }> = [];

      for (let run = 1; run <= 3; run += 1) {
        const contents = `workspace state from run ${run}\n`;
        await writeFile(durableFile, contents);
        await rm(transientFile, { force: true });

        // This is the real fs.persist boundary used by workspace durability.
        const snapshot = await runVcs(captureWorkspaceSnapshot(workspace));
        expect(snapshot).not.toBeNull();
        if (!snapshot) throw new Error(`run ${run} did not produce a workspace snapshot`);

        // vcs.pointer and the persisted snapshot must identify the same exact state.
        const pointer = await runVcs(getJjPointer(workspace));
        expect(pointer).toBe(snapshot.commitId);
        expect(pointer).toMatch(/^[0-9a-f]{40}$/);
        expect(snapshot.commitId).not.toBe(checkpoints.at(-1)?.commitId);
        checkpoints.push({
          commitId: snapshot.commitId,
          changeId: snapshot.changeId,
          contents,
        });

        // Simulate arbitrary mutations made after persistence, including a new file.
        await writeFile(durableFile, `corrupt state after run ${run}\n`);
        await writeFile(transientFile, `must disappear after run ${run}\n`);

        // This is the real fs.restore path, using the pointer emitted by persist.
        const restored = await runVcs(revertToJjPointer(snapshot.commitId, workspace));
        expect(restored).toEqual({ success: true });
        expect(await readFile(durableFile, "utf8")).toBe(contents);
        expect(await exists(transientFile)).toBe(false);
        await expectCurrentPointer(snapshot.changeId, workspace);

        // A real jj tree diff proves restore reproduced the exact persisted file state.
        await expectTreeMatches(snapshot.commitId, workspace);
      }

      // Restore each prior run out of order to prove snapshots remain independently valid.
      for (const checkpoint of checkpoints.toReversed()) {
        await writeFile(durableFile, "inter-run drift\n");
        const restored = await runVcs(revertToJjPointer(checkpoint.commitId, workspace));
        expect(restored.success).toBe(true);
        expect(await readFile(durableFile, "utf8")).toBe(checkpoint.contents);
        await expectCurrentPointer(checkpoint.changeId, workspace);
        await expectTreeMatches(checkpoint.commitId, workspace);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
