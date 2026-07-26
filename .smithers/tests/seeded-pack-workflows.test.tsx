/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { renderWorkflow, runTask } from "smithers-orchestrator/testing";
import type { RenderedWorkflow } from "smithers-orchestrator/testing";
import type { TaskDescriptor } from "smithers-orchestrator/graph";

const workflowsDir = join(import.meta.dir, "..", "workflows");
const cliSrc = pathToFileURL(resolve(import.meta.dir, "../../apps/cli/src")).href;
const envNames = ["SMITHERS_CLI_SRC_DIR", "SMITHERS_HOME", "SMITHERS_SHARE_REGISTRY_README"] as const;
const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
type Frame = RenderedWorkflow;
type Row = Record<string, unknown> & { nodeId: string };

const load = async (file: string) => (await import(join(workflowsDir, file))).default;
const task = (frame: Frame, nodeId: string): TaskDescriptor => {
  const found = frame.tasks.find((candidate) => candidate.nodeId === nodeId);
  expect(found, `missing task ${nodeId}`).toBeDefined();
  return found!;
};
const mounted = (frame: Frame, nodeId: string) => {
  const found = frame.tasks.find((candidate) => candidate.nodeId === nodeId);
  expect(found, `missing task ${nodeId}`).toBeDefined();
  return found!;
};
const tableFor = (nodeId: string) =>
  ({
    "validate-manifest": "validate",
    "complete-manifest": "completion",
    "revalidate-manifest": "revalidate",
    "prepare-pack": "prepare",
    "publish-pack": "publish",
    "share-registry": "share",
    output: "output",
    "install-pack": "result",
  })[nodeId];

async function render(file: string, input: unknown, rows: Row[] = []): Promise<Frame> {
  process.env.SMITHERS_CLI_SRC_DIR = cliSrc;
  const workflow = await load(file);
  const parsed = workflow.inputSchema.parse(input);
  const outputs: Record<string, Row[]> = {};
  for (const staged of rows) {
    const frame = await renderWorkflow(workflow, { workflowPath: join(workflowsDir, file), input: parsed, outputs });
    const descriptor = mounted(frame, staged.nodeId);
    expect(descriptor.outputTableName).toBe(tableFor(staged.nodeId) as string);
    expect(descriptor.outputSchema).toBeDefined();
    descriptor.outputSchema!.parse(staged);
    outputs[descriptor.outputTableName!] = [staged];
  }
  return renderWorkflow(workflow, { workflowPath: join(workflowsDir, file), input: parsed, outputs }) as Promise<Frame>;
}

const row = (nodeId: string, value: Record<string, unknown>): Row => ({ nodeId, ...value });
const temp = (prefix: string) => mkdtemp(join(tmpdir(), `smithers-${prefix}-`));
const exactReject = async (operation: Promise<unknown>, message: string) => {
  try {
    await operation;
    throw new Error("operation unexpectedly resolved");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
  }
};
const setFixtureEnv = (root: string) => {
  process.env.SMITHERS_CLI_SRC_DIR = cliSrc;
  process.env.SMITHERS_HOME = join(root, "home");
  // A deliberately absent fixture is an explicit offline registry snapshot;
  // the production helper returns empty bytes without probing gh or curl.
  process.env.SMITHERS_SHARE_REGISTRY_README = join(root, "registry-readme.md");
};
const cleanup = async (root: string, cwd: string) => {
  process.chdir(cwd);
  for (const name of envNames) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: false });
};
const manifest = (
  name: string,
  version: string,
  description?: string,
  repository?: string,
  workflows?: string[],
  writes?: string,
) =>
  [
    `name: ${name}`,
    `version: ${version}`,
    description && `description: ${description}`,
    repository && `repository: ${repository}`,
    workflows?.length && `contents:\n  workflows[${workflows.length}]: ${workflows.join(", ")}`,
    writes && `capabilities:\n  writes: ${writes}`,
  ]
    .filter(Boolean)
    .join("\n") + "\n";

describe.serial("seeded pack workflows", () => {
  test("defaults, boundaries, and exact task contracts", async () => {
    const add = await load("add.tsx");
    expect(add.inputSchema.parse({ spec: "file:fixture" })).toEqual({ spec: "file:fixture", global: false, yes: true });
    for (const value of [{}, { spec: 7 }, { spec: "x", global: "yes" }, { spec: "x", yes: "yes" }])
      expect(() => add.inputSchema.parse(value)).toThrow();
    expect(() => add.inputSchema.parse({ spec: " " })).toThrow("Pack spec is required");
    const share = await load("share-pack.tsx");
    expect(share.inputSchema.parse({})).toEqual({ dryRun: false });
    for (const value of [{ repo: 7 }, { registry: 7 }, { dryRun: "yes" }])
      expect(() => share.inputSchema.parse(value)).toThrow();
    const frame = await render("share-pack.tsx", {}, [
      row("validate-manifest", { ok: true, detail: "valid" }),
      row("prepare-pack", { ok: true, detail: "prepared" }),
      row("publish-pack", { ok: true, detail: "published" }),
      row("share-registry", { ok: true, detail: "shared" }),
    ]);
    for (const [id, retries, table] of [
      ["validate-manifest", 0, "validate"],
      ["prepare-pack", 0, "prepare"],
      ["publish-pack", 0, "publish"],
      ["share-registry", 0, "share"],
      ["output", Infinity, "output"],
    ] as const) {
      expect(task(frame, id).retries).toBe(retries);
      expect(task(frame, id).outputTableName).toBe(table);
    }
    expect(task(await render("add.tsx", { spec: "x" }), "install-pack").retries).toBe(0);
    expect(task(await render("add.tsx", { spec: "x" }), "install-pack").outputTableName).toBe("result");
  }, 15000);

  test("installs a real local pack and discovers its workflow", async () => {
    const root = await temp("add-local");
    const cwd = process.cwd();
    try {
      setFixtureEnv(root);
      const fixture = join(root, "fixture-pack");
      const project = join(root, "project");
      await mkdir(join(fixture, "workflows"), { recursive: true });
      await mkdir(join(project, ".smithers"), { recursive: true });
      const manifestBytes = manifest("fixture-pack", "1.2.3", "Fixture pack", undefined, undefined, "none");
      const workflowBytes = "// smithers-display-name: Hello fixture\nexport default null;\n";
      await writeFile(join(fixture, "smithers.toon"), manifestBytes);
      await writeFile(join(fixture, "workflows/hello.tsx"), workflowBytes);
      await writeFile(join(fixture, "copied.txt"), "copied bytes\n");
      process.chdir(project);
      const input = `file:${fixture}`;
      const result = await runTask(task(await render("add.tsx", { spec: input }), "install-pack"));
      const installed = join(process.cwd(), ".smithers/packs/fixture-pack");
      expect(result).toEqual({
        name: "fixture-pack",
        path: installed,
        scope: "local",
        report: "Pack fixture-pack (1.2.3)\nCapabilities: bins=none, env=none, writes=none",
      });
      expect(await readFile(join(installed, "smithers.toon"))).toEqual(await readFile(join(fixture, "smithers.toon")));
      expect(await readFile(join(installed, "copied.txt"))).toEqual(await readFile(join(fixture, "copied.txt")));
      expect(await readFile(join(installed, "workflows/hello.tsx"), "utf8")).toBe(workflowBytes);
      const { resolveWorkflow, discoverWorkflows } = await import("../../apps/cli/src/workflows.js");
      expect(resolveWorkflow("fixture-pack:hello", process.cwd()).source).toBe("pack:fixture-pack");
      expect(resolveWorkflow("fixture-pack:hello", process.cwd()).scope).toBe("local");
      expect(discoverWorkflows(process.cwd()).find((item) => item.id === "hello")?.source).toBe("pack:fixture-pack");
      const { listLockedPacks } = await import("../../apps/cli/src/packs.js");
      expect(listLockedPacks(process.cwd())).toEqual([
        {
          name: "fixture-pack",
          scope: "local",
          entry: { spec: input, resolved: resolve(fixture), version: "1.2.3", integrity: "file" },
        },
      ]);
    } finally {
      await cleanup(root, cwd);
    }
  });

  test("refuses noninteractive trust for repository-writing packs", async () => {
    const root = await temp("add-refuse");
    const cwd = process.cwd();
    try {
      setFixtureEnv(root);
      const fixture = join(root, "pack");
      const project = join(root, "project");
      await mkdir(join(fixture, "workflows"), { recursive: true });
      await mkdir(join(project, ".smithers"), { recursive: true });
      await writeFile(
        join(fixture, "smithers.toon"),
        manifest("trusted-pack", "1.0.0", undefined, undefined, undefined, "repo"),
      );
      await writeFile(join(fixture, "workflows/hello.tsx"), "export default null;\n");
      process.chdir(project);
      await exactReject(
        runTask(task(await render("add.tsx", { spec: `file:${fixture}`, yes: false }), "install-pack")),
        "Pack trusted-pack (1.0.0)\nCapabilities: bins=none, env=none, writes=repo\nConfirmation required; pass --yes in non-interactive mode",
      );
      expect(existsSync(join(project, ".smithers/packs/trusted-pack"))).toBe(false);
      expect(existsSync(join(project, ".smithers/packs.lock.toon"))).toBe(false);
    } finally {
      await cleanup(root, cwd);
    }
  });

  test("installs a real global pack with the default yes", async () => {
    const root = await temp("add-global");
    const cwd = process.cwd();
    try {
      setFixtureEnv(root);
      const fixture = join(root, "pack");
      const project = join(root, "project");
      await mkdir(join(fixture, "workflows"), { recursive: true });
      await mkdir(join(project, ".smithers"), { recursive: true });
      await writeFile(join(fixture, "smithers.toon"), manifest("global-pack", "1.0.0"));
      await writeFile(join(fixture, "workflows/hello.tsx"), "export default null;\n");
      process.chdir(project);
      const input = `file:${fixture}`;
      const result = await runTask(task(await render("add.tsx", { spec: input, global: true }), "install-pack"));
      const installed = join(root, "home/packs/global-pack");
      expect(result).toEqual({
        name: "global-pack",
        path: installed,
        scope: "global",
        report: "Pack global-pack (1.0.0)\nCapabilities: bins=none, env=none, writes=none",
      });
      expect(existsSync(installed)).toBe(true);
      expect(existsSync(join(project, ".smithers/packs/global-pack"))).toBe(false);
      const entry = { spec: input, resolved: resolve(fixture), version: "1.0.0", integrity: "file" };
      expect(existsSync(join(root, "home/packs.lock.toon"))).toBe(true);
      const { listLockedPacks } = await import("../../apps/cli/src/packs.js");
      expect(listLockedPacks(process.cwd())).toEqual([{ name: "global-pack", scope: "global", entry }]);
    } finally {
      await cleanup(root, cwd);
    }
  });

  test("updates incoming bytes while preserving user-owned files and nested directories", async () => {
    const root = await temp("add-update");
    const cwd = process.cwd();
    try {
      setFixtureEnv(root);
      const fixture = join(root, "pack");
      const project = join(root, "project");
      await mkdir(join(fixture, "workflows"), { recursive: true });
      await mkdir(join(project, ".smithers"), { recursive: true });
      await writeFile(join(fixture, "smithers.toon"), manifest("update-pack", "1.0.0"));
      await writeFile(join(fixture, "workflows/hello.tsx"), "export default 'old';\n");
      process.chdir(project);
      const input = `file:${fixture}`;
      await runTask(task(await render("add.tsx", { spec: input }), "install-pack"));
      await writeFile(join(project, ".smithers/packs/update-pack/user-owned.txt"), "keep me\n");
      await mkdir(join(project, ".smithers/packs/update-pack/user-dir"), { recursive: true });
      await writeFile(join(project, ".smithers/packs/update-pack/user-dir/owned.txt"), "nested keep\n");
      await writeFile(join(fixture, "smithers.toon"), manifest("update-pack", "2.0.0"));
      await writeFile(join(fixture, "workflows/hello.tsx"), "export default 'new';\n");
      await runTask(task(await render("add.tsx", { spec: input }), "install-pack"));
      expect(await readFile(join(project, ".smithers/packs/update-pack/workflows/hello.tsx"), "utf8")).toBe(
        "export default 'new';\n",
      );
      expect(await readFile(join(project, ".smithers/packs/update-pack/user-owned.txt"), "utf8")).toBe("keep me\n");
      expect(await readFile(join(project, ".smithers/packs/update-pack/user-dir/owned.txt"), "utf8")).toBe(
        "nested keep\n",
      );
    } finally {
      await cleanup(root, cwd);
    }
  });

  test("stages, prepares, and dry-runs sharing a pack with a repository", async () => {
    const root = await temp("share-prepared");
    const cwd = process.cwd();
    try {
      setFixtureEnv(root);
      const project = join(root, "project");
      const pack = join(project, ".smithers");
      await mkdir(join(pack, "workflows"), { recursive: true });
      await mkdir(join(pack, "runs/nested"), { recursive: true });
      await mkdir(join(pack, "components"), { recursive: true });
      await writeFile(
        join(pack, "smithers.toon"),
        manifest("prepared-pack", "1.0.0", "Prepared fixture", "legacy/manifest-pack", ["hello"]),
      );
      await writeFile(
        join(pack, "workflows/hello.tsx"),
        "// smithers-description: Hello fixture\nexport default null;\n",
      );
      await writeFile(join(pack, "smithers.db"), "db");
      await writeFile(join(pack, "agents.ts"), "agents");
      await writeFile(join(pack, "runs/state"), "state");
      await writeFile(join(pack, "components/private.ts"), "private");
      await writeFile(join(project, "secret"), "secret");
      process.chdir(project);
      const input = { repo: "override/prepared-pack", registry: "acme/awesome-smithers", dryRun: true };
      const initial = await render("share-pack.tsx", input);
      expect(initial.tasks.map((item) => item.nodeId)).toEqual(["validate-manifest"]);
      const validated = await runTask(task(initial, "validate-manifest"));
      expect(validated).toEqual({ ok: true, detail: "smithers.toon is valid" });
      const preparedFrame = await render("share-pack.tsx", input, [
        row("validate-manifest", validated as Record<string, unknown>),
      ]);
      expect(preparedFrame.tasks.map((item) => item.nodeId)).toEqual(["validate-manifest", "prepare-pack"]);
      const prepared = (await runTask(task(preparedFrame, "prepare-pack"))) as {
        ok: boolean;
        detail: string;
        stagingRoot: string;
      };
      expect(prepared.ok).toBe(true);
      expect(prepared.detail).toBe(
        "staged prepared-pack for publication (3 private path(s) excluded; live pack untouched)",
      );
      // NON-DESTRUCTIVE: the live pack keeps its state; edits land in staging.
      const staging = prepared.stagingRoot;
      expect(await readFile(join(staging, "README.md"), "utf8")).toBe(
        "# prepared-pack\n\nPrepared fixture\n\nInstall with `smithers add override/prepared-pack`.\n",
      );
      expect(await readFile(join(staging, "smithers.toon"), "utf8")).toContain("repository: override/prepared-pack");
      expect(await readFile(join(pack, "smithers.toon"), "utf8")).toContain("repository: legacy/manifest-pack");
      for (const name of ["smithers.db", "agents.ts", "runs"]) {
        expect(existsSync(join(pack, name))).toBe(true);
        expect(existsSync(join(staging, name))).toBe(false);
      }
      expect(await readFile(join(pack, "components/private.ts"), "utf8")).toBe("private");
      expect(existsSync(join(pack, "workflows/hello.tsx"))).toBe(true);
      expect(existsSync(join(project, "secret"))).toBe(true);
      const sharedFrame = await render("share-pack.tsx", input, [
        row("validate-manifest", validated as Record<string, unknown>),
        row("prepare-pack", prepared as Record<string, unknown>),
      ]);
      expect(sharedFrame.tasks.map((item) => item.nodeId)).toEqual([
        "validate-manifest",
        "prepare-pack",
        "share-registry",
      ]);
      const entry =
        "| [prepared-pack](https://github.com/override/prepared-pack) | Prepared fixture | `smithers add override/prepared-pack` | `hello`: Hello fixture |";
      const shared = await runTask(task(sharedFrame, "share-registry"));
      expect(shared).toEqual({ ok: true, detail: entry });
      const finalFrame = await render("share-pack.tsx", input, [
        row("validate-manifest", validated as Record<string, unknown>),
        row("prepare-pack", prepared as Record<string, unknown>),
        row("share-registry", shared as Record<string, unknown>),
      ]);
      expect(finalFrame.tasks.map((item) => item.nodeId)).toEqual([
        "validate-manifest",
        "prepare-pack",
        "share-registry",
        "output",
      ]);
      expect(await runTask(task(finalFrame, "output"))).toEqual({
        validated: true,
        prepared: true,
        published: false,
        shared: true,
        detail: entry,
      });
      const { sharePack } = await import("../../apps/cli/src/share.js");
      const direct = sharePack({
        from: project,
        repository: "override/prepared-pack",
        repo: "acme/awesome-smithers",
        dryRun: true,
        registryReadme: "",
      } as any);
      expect(direct.repository).toBe("override/prepared-pack");
      expect(direct.registry).toBe("acme/awesome-smithers");
      expect(direct.entry).toBe(entry);
    } finally {
      await cleanup(root, cwd);
    }
  });

  test("shares safely without publishing when no repository is supplied", async () => {
    const root = await temp("share-no-repo");
    const cwd = process.cwd();
    try {
      setFixtureEnv(root);
      const project = join(root, "project");
      const pack = join(project, ".smithers");
      await mkdir(join(pack, "workflows"), { recursive: true });
      await writeFile(
        join(pack, "smithers.toon"),
        manifest("registry-pack", "2.0.0", "Registry fixture", "acme/registry-pack", ["hello"]),
      );
      await writeFile(
        join(pack, "workflows/hello.tsx"),
        "// smithers-description: Registry hello\nexport default null;\n",
      );
      process.chdir(project);
      const input = { registry: "acme/awesome-smithers", dryRun: true };
      const initial = await render("share-pack.tsx", input);
      const validated = await runTask(task(initial, "validate-manifest"));
      const prepared = await runTask(
        task(
          await render("share-pack.tsx", input, [row("validate-manifest", validated as Record<string, unknown>)]),
          "prepare-pack",
        ),
      );
      const entry =
        "| [registry-pack](https://github.com/acme/registry-pack) | Registry fixture | `smithers add acme/registry-pack` | `hello`: Registry hello |";
      const shared = await runTask(
        task(
          await render("share-pack.tsx", input, [
            row("validate-manifest", validated as Record<string, unknown>),
            row("prepare-pack", prepared as Record<string, unknown>),
          ]),
          "share-registry",
        ),
      );
      expect(shared).toEqual({ ok: true, detail: entry });
      const final = await render("share-pack.tsx", input, [
        row("validate-manifest", validated as Record<string, unknown>),
        row("prepare-pack", prepared as Record<string, unknown>),
        row("share-registry", shared as Record<string, unknown>),
      ]);
      expect(await runTask(task(final, "output"))).toEqual({
        validated: true,
        prepared: true,
        published: false,
        shared: true,
        detail: entry,
      });
    } finally {
      await cleanup(root, cwd);
    }
  });

  test("rejects malformed TOON during mounted validation and preserves the sentinel", async () => {
    const root = await temp("share-malformed");
    const cwd = process.cwd();
    try {
      setFixtureEnv(root);
      const project = join(root, "project");
      const pack = join(project, ".smithers");
      await mkdir(pack, { recursive: true });
      await writeFile(join(pack, "smithers.toon"), "- a\n- b\n");
      await writeFile(join(pack, "sentinel"), "sentinel");
      process.chdir(project);
      const frame = await render("share-pack.tsx", { dryRun: true });
      expect(frame.tasks.map((item) => item.nodeId)).toEqual(["validate-manifest"]);
      const failed = (await runTask(task(frame, "validate-manifest"))) as { ok: boolean; detail: string };
      expect(failed).toEqual({
        ok: false,
        detail:
          "Invalid smithers.toon: malformed TOON: Line 1: Top-level document must start with a key-value or array-header line",
      });
      const output = await render("share-pack.tsx", { dryRun: true }, [
        row("validate-manifest", failed as Record<string, unknown>),
        row("complete-manifest", { completed: false, detail: "agent could not repair the manifest" }),
        row("revalidate-manifest", failed as Record<string, unknown>),
      ]);
      expect(await runTask(task(output, "output"))).toEqual({
        validated: false,
        prepared: false,
        published: false,
        shared: false,
        detail: failed.detail,
      });
      expect(await readFile(join(pack, "sentinel"), "utf8")).toBe("sentinel");
      expect(existsSync(join(pack, "README.md"))).toBe(false);
    } finally {
      await cleanup(root, cwd);
    }
  });

  test("does not authorize downstream work from failed rows", async () => {
    // A failed validation first mounts the manifest-completion agent (not the
    // terminal output), and never any prepare/publish/share work.
    const invalid = await render("share-pack.tsx", { dryRun: false }, [
      row("validate-manifest", { ok: false, detail: "invalid" }),
    ]);
    expect(invalid.tasks.map((item) => item.nodeId)).toEqual(["validate-manifest", "complete-manifest"]);
    const afterCompletion = await render("share-pack.tsx", { dryRun: false }, [
      row("validate-manifest", { ok: false, detail: "invalid" }),
      row("complete-manifest", { completed: false, detail: "could not complete" }),
      row("revalidate-manifest", { ok: false, detail: "still invalid" }),
    ]);
    expect(afterCompletion.tasks.map((item) => item.nodeId)).toEqual([
      "validate-manifest",
      "complete-manifest",
      "revalidate-manifest",
      "output",
    ]);
    expect(await runTask(task(afterCompletion, "output"))).toEqual({
      validated: false,
      prepared: false,
      published: false,
      shared: false,
      detail: "still invalid",
    });
    const prepareFailed = await render("share-pack.tsx", { dryRun: false }, [
      row("validate-manifest", { ok: true, detail: "valid" }),
      row("prepare-pack", { ok: false, detail: "prepare failed" }),
    ]);
    expect(prepareFailed.tasks.map((item) => item.nodeId)).toEqual(["validate-manifest", "prepare-pack", "output"]);
    const publishFailed = await render("share-pack.tsx", { repo: "owner/pack", dryRun: false }, [
      row("validate-manifest", { ok: true, detail: "valid" }),
      row("prepare-pack", { ok: true, detail: "prepared" }),
      row("publish-pack", { ok: false, detail: "publish failed" }),
    ]);
    expect(publishFailed.tasks.map((item) => item.nodeId)).toEqual([
      "validate-manifest",
      "prepare-pack",
      "publish-pack",
      "output",
    ]);
  });
});
