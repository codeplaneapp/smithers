import { applyPatch as applyUnifiedPatch } from "diff";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SmithersError } from "@smithers/errors/SmithersError";

export type FilePatch = {
  path: string;
  operation: "add" | "modify" | "delete";
  diff: string;
  binaryContent?: string;
};

export type DiffBundle = {
  seq: number;
  baseRef: string;
  patches: FilePatch[];
};

type GitCommandResult = {
  stdout: string;
  stderr: string;
};

async function runGit(
  cwd: string,
  args: string[],
  options?: {
    input?: string;
    allowExitCodes?: ReadonlySet<number>;
  },
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const allowExitCodes = options?.allowExitCodes;
      if (code === 0 || (typeof code === "number" && allowExitCodes?.has(code))) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new SmithersError(
          "INVALID_INPUT",
          `git ${args.join(" ")} failed`,
          { cwd, args, code, stderr: stderr.trim(), stdout: stdout.trim() },
        ),
      );
    });

    if (options?.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

function splitGitDiff(diff: string): string[] {
  const normalized = diff.trim();
  if (normalized.length === 0) {
    return [];
  }
  return normalized
    .split(/^diff --git /m)
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => `diff --git ${chunk}`.trimEnd() + "\n");
}

function extractPatchPath(chunk: string): string {
  const renameTo = chunk.match(/^rename to (.+)$/m)?.[1];
  if (renameTo) {
    return renameTo.trim();
  }

  const plusPath = chunk.match(/^\+\+\+ b\/(.+)$/m)?.[1];
  if (plusPath) {
    return plusPath.trim();
  }

  const minusPath = chunk.match(/^--- a\/(.+)$/m)?.[1];
  if (minusPath) {
    return minusPath.trim();
  }

  const diffHeader = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (diffHeader) {
    return diffHeader[2]!.trim();
  }

  throw new SmithersError(
    "INVALID_INPUT",
    "Unable to determine file path from diff chunk",
    { chunk: chunk.slice(0, 200) },
  );
}

function extractOperation(chunk: string): FilePatch["operation"] {
  if (/^new file mode /m.test(chunk)) {
    return "add";
  }
  if (/^deleted file mode /m.test(chunk)) {
    return "delete";
  }
  return "modify";
}

function isBinaryPatch(chunk: string): boolean {
  return /(^GIT binary patch$)|(^Binary files )/m.test(chunk);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listBinaryPaths(
  baseRef: string,
  currentDir: string,
): Promise<Set<string>> {
  const { stdout } = await runGit(currentDir, [
    "diff",
    "--numstat",
    "--find-renames=100%",
    baseRef,
    "--",
    ".",
  ]);

  const binaryPaths = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [added, removed, ...rest] = trimmed.split("\t");
    if (added === "-" && removed === "-" && rest.length > 0) {
      binaryPaths.add(rest.join("\t"));
    }
  }

  return binaryPaths;
}

async function listUntrackedFiles(currentDir: string): Promise<string[]> {
  const { stdout } = await runGit(currentDir, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ".",
  ]);

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function computeUntrackedDiffs(currentDir: string): Promise<string[]> {
  const untracked = await listUntrackedFiles(currentDir);
  const diffs: string[] = [];

  for (const relativePath of untracked) {
    const { stdout } = await runGit(
      currentDir,
      ["diff", "--no-index", "--binary", "--", "/dev/null", relativePath],
      { allowExitCodes: new Set([1]) },
    );
    if (stdout.trim().length > 0) {
      diffs.push(stdout.trimEnd() + "\n");
    }
  }

  return diffs;
}

export async function computeDiffBundle(
  baseRef: string,
  currentDir: string,
  seq = 1,
): Promise<DiffBundle> {
  const [{ stdout: trackedDiff }, binaryPaths, untrackedDiffs] = await Promise.all([
    runGit(currentDir, [
      "diff",
      "--binary",
      "--find-renames=100%",
      "--no-ext-diff",
      baseRef,
      "--",
      ".",
    ]),
    listBinaryPaths(baseRef, currentDir),
    computeUntrackedDiffs(currentDir),
  ]);

  const patches: FilePatch[] = [];
  const chunks = [
    ...splitGitDiff(trackedDiff),
    ...untrackedDiffs.flatMap(splitGitDiff),
  ];

  for (const chunk of chunks) {
    const path = extractPatchPath(chunk);
    const operation = extractOperation(chunk);
    const binary =
      isBinaryPatch(chunk) || binaryPaths.has(path);
    const fullPath = join(currentDir, path);

    patches.push({
      path,
      operation,
      diff: chunk,
      binaryContent:
        binary && operation !== "delete" && await fileExists(fullPath)
          ? (await readFile(fullPath)).toString("base64")
          : undefined,
    });
  }

  return {
    seq,
    baseRef,
    patches,
  };
}

async function applyPatchFallback(
  patch: FilePatch,
  targetDir: string,
): Promise<void> {
  const targetPath = join(targetDir, patch.path);
  const targetExists = await fileExists(targetPath);

  if (patch.binaryContent) {
    if (patch.operation === "delete") {
      await rm(targetPath, { force: true });
      return;
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, Buffer.from(patch.binaryContent, "base64"));
    return;
  }

  if (patch.operation === "delete" && !targetExists) {
    return;
  }

  const current =
    patch.operation === "add" || !targetExists
      ? ""
      : await readFile(targetPath, "utf8");
  const updated = applyUnifiedPatch(current, patch.diff);
  if (updated === false) {
    throw new SmithersError(
      "TOOL_PATCH_FAILED",
      `Failed to apply patch for ${patch.path}`,
      { path: patch.path, operation: patch.operation },
    );
  }

  if (patch.operation === "delete") {
    await rm(targetPath, { force: true });
    return;
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, updated, "utf8");
}

export async function applyDiffBundle(
  bundle: DiffBundle,
  targetDir: string,
): Promise<void> {
  if (bundle.patches.length === 0) {
    return;
  }

  await mkdir(targetDir, { recursive: true });
  const fullPatch = bundle.patches.map((patch) => patch.diff).join("");

  try {
    await runGit(
      targetDir,
      ["apply", "--binary", "--whitespace=nowarn", "--unsafe-paths", "-"],
      { input: fullPatch },
    );
    return;
  } catch (error) {
    for (const patch of bundle.patches) {
      await applyPatchFallback(patch, targetDir);
    }
  }
}
