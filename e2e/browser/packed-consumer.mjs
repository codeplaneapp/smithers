// Proves the published declarations are valid for a REAL external consumer:
// pack smithers-orchestrator with `npm pack`, install it (plus its browser
// entry's workspace deps) into a scratch project, and typecheck a fixture
// against the packed `smithers-orchestrator/browser` export with strict
// settings and no workspace path aliases / skipLibCheck to hide packaging
// failures.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "smithers-browser-package-"));
const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
try {
  const packOutput = execFileSync("npm", ["pack", join(repo, "packages/smithers")], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  const packageArchive = packOutput.split(/\r?\n/).at(-1);
  if (!packageArchive?.endsWith(".tgz")) throw new Error("npm pack did not produce a package archive");

  const packageDir = join(root, "node_modules", "smithers-orchestrator");
  await mkdir(packageDir, { recursive: true });
  execFileSync("tar", ["-xzf", join(root, packageArchive), "--strip-components", "1", "-C", packageDir]);

  // The packed `smithers-orchestrator/browser` entry re-exports
  // `@smithers-orchestrator/engine/browser`, which in turn needs its own
  // workspace dependencies resolvable — symlink them in like a real install
  // would (via the npm registry) rather than using workspace protocol magic.
  for (const dependency of [
    "react",
    "@types/react",
    "@smithers-orchestrator/engine",
    "@smithers-orchestrator/driver",
    "@smithers-orchestrator/components",
    "@smithers-orchestrator/react-reconciler",
    "@smithers-orchestrator/graph",
    "@smithers-orchestrator/scheduler",
    "@smithers-orchestrator/errors",
    "@smithers-orchestrator/testing",
  ]) {
    const destination = join(root, "node_modules", dependency);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(join(repo, "node_modules", dependency), destination, "junction").catch(async () => {
      // Fall back to the package's own directory (not hoisted to root node_modules).
      const pkgDir = dependency.startsWith("@smithers-orchestrator/")
        ? join(repo, "packages", dependency.replace("@smithers-orchestrator/", ""))
        : null;
      if (!pkgDir) throw new Error(`could not resolve workspace dependency: ${dependency}`);
      await symlink(pkgDir, destination, "junction");
    });
  }

  const consumer = join(root, "consumer.ts");
  await writeFile(
    consumer,
    `import React from "react";\n` +
      `import { createBrowserRuntime, createBrowserSmithers, defineBrowserWorkflow, Task, Workflow, type BrowserWorkflow, type RuntimeAdapter } from "smithers-orchestrator/browser";\n` +
      `const runtime: RuntimeAdapter = createBrowserRuntime();\n` +
      `const workflow: BrowserWorkflow = defineBrowserWorkflow((ctx) => React.createElement(Workflow, { name: "typed" }, React.createElement(Task, { id: "typed", output: "typed" }, String(ctx.input ?? ""))));\n` +
      `const smithers = createBrowserSmithers({ workflow, runtime });\n` +
      `void smithers;\n`,
  );
  execFileSync(
    "tsc",
    [
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--moduleResolution",
      "bundler",
      "--module",
      "esnext",
      "--target",
      "es2022",
      "--jsx",
      "react-jsx",
      consumer,
    ],
    { cwd: process.cwd(), stdio: "inherit" },
  );
  console.log("packed smithers-orchestrator/browser consumer typechecks cleanly");
} finally {
  await rm(root, { recursive: true, force: true });
}
