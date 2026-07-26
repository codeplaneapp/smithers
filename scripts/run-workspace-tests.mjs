#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const timeoutKillGraceMs = 5_000;

function usage() {
  console.error(
    "Usage: node scripts/run-workspace-tests.mjs [--shard N/TOTAL] [--timeout-minutes MINUTES] [--exclude DIR[,DIR...]] [--list]",
  );
}

function parseArgs(argv) {
  const options = {
    shard: 1,
    totalShards: 1,
    timeoutMinutes: 5,
    exclude: new Set(),
    listOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--shard") {
      const value = argv[++index];
      const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
      if (!match) {
        usage();
        process.exit(2);
      }
      options.shard = Number(match[1]);
      options.totalShards = Number(match[2]);
    } else if (arg === "--timeout-minutes") {
      options.timeoutMinutes = Number(argv[++index]);
    } else if (arg === "--exclude") {
      const value = argv[++index];
      if (value === undefined) {
        usage();
        process.exit(2);
      }
      options.exclude = new Set(
        value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      );
    } else if (arg === "--list") {
      options.listOnly = true;
    } else {
      usage();
      process.exit(2);
    }
  }

  if (
    !Number.isInteger(options.shard) ||
    !Number.isInteger(options.totalShards) ||
    options.shard < 1 ||
    options.totalShards < 1 ||
    options.shard > options.totalShards ||
    !Number.isFinite(options.timeoutMinutes) ||
    options.timeoutMinutes <= 0
  ) {
    usage();
    process.exit(2);
  }

  return options;
}

function expandWorkspacePattern(pattern) {
  if (!pattern.includes("*")) {
    return [pattern];
  }

  const [prefix, suffix] = pattern.split("*");
  const directory = prefix.replace(/\/$/, "");
  if (!directory || suffix !== "") {
    throw new Error(`Unsupported workspace pattern: ${pattern}`);
  }

  return readdirSync(path.join(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join(directory, entry.name));
}

function readWorkspaceTestPackages() {
  const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const workspacePatterns = rootPackage.workspaces ?? [];
  const packageDirectories = workspacePatterns.flatMap(expandWorkspacePattern);

  return packageDirectories
    .map((directory) => {
      const packageJsonPath = path.join(root, directory, "package.json");
      if (!existsSync(packageJsonPath)) {
        return undefined;
      }

      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (!packageJson.scripts?.test) {
        return undefined;
      }

      return {
        directory,
        name: packageJson.name ?? directory,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.directory.localeCompare(right.directory));
}

const packageWeights = new Map([
  [".smithers", 5],
  ["apps/cli", 8],
  ["apps/smithers", 5],
  ["packages/agents", 6],
  ["packages/components", 5],
  ["packages/db", 4],
  ["packages/driver", 4],
  ["packages/engine", 6],
  ["packages/gateway-react", 5],
  ["packages/pi-plugin", 5],
  ["packages/react-reconciler", 5],
  ["packages/sandbox", 5],
  ["packages/scorers", 5],
  ["packages/server", 5],
  ["packages/smithers", 6],
  ["packages/time-travel", 4],
]);

function shardPackages(packages, totalShards) {
  const shards = Array.from({ length: totalShards }, () => ({
    weight: 0,
    packages: [],
  }));

  for (const pkg of [...packages].sort((left, right) => {
    const weightDelta = (packageWeights.get(right.directory) ?? 1) - (packageWeights.get(left.directory) ?? 1);
    return weightDelta || left.directory.localeCompare(right.directory);
  })) {
    const target = shards.reduce((best, candidate) => (candidate.weight < best.weight ? candidate : best));
    target.packages.push(pkg);
    target.weight += packageWeights.get(pkg.directory) ?? 1;
  }

  for (const shard of shards) {
    shard.packages.sort((left, right) => left.directory.localeCompare(right.directory));
  }

  return shards;
}

function killProcessTree(child, signal) {
  if (child.pid === undefined) {
    return;
  }

  if (process.platform === "win32") {
    // taskkill /f is already the Windows equivalent of an immediate SIGKILL.
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "inherit",
    });
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function runPackageTest(pkg, timeoutMinutes) {
  const command = "pnpm";
  const timeoutMs = timeoutMinutes * 60 * 1000;

  return new Promise((resolve) => {
    console.log(`\n=== ${pkg.directory} (${pkg.name}) ===`);
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command, ["--dir", pkg.directory, "test"], {
        cwd: root,
        detached: process.platform !== "win32",
        shell: process.platform === "win32",
        stdio: "inherit",
      });
    } catch (error) {
      console.error(`::error title=Package test failed::${pkg.directory} could not start: ${error.message}`);
      resolve({ pkg, status: "failed to start", elapsedSeconds: "0.0" });
      return;
    }

    let timedOut = false;
    let settled = false;
    let timer;
    let killTimer;
    const clearTimers = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
    };
    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      console.error(`::error title=Package test timed out::${pkg.directory} exceeded ${timeoutMinutes} minutes`);
      killProcessTree(child, "SIGTERM");

      if (process.platform !== "win32") {
        killTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          console.error(
            `::error title=Package test timed out::${pkg.directory} did not exit after SIGTERM; sending SIGKILL`,
          );
          killProcessTree(child, "SIGKILL");
        }, timeoutKillGraceMs);
      }
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.error(`::error title=Package test failed::${pkg.directory} could not start: ${error.message}`);
      resolve({ pkg, status: "failed to start", elapsedSeconds });
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (timedOut) {
        resolve({ pkg, status: "timed out", elapsedSeconds });
      } else if (code === 0) {
        console.log(`=== ${pkg.directory} passed in ${elapsedSeconds}s ===`);
        resolve({ pkg, status: "passed", elapsedSeconds });
      } else {
        console.error(`::error title=Package test failed::${pkg.directory} exited with ${signal ?? code}`);
        resolve({ pkg, status: `failed (${signal ?? code})`, elapsedSeconds });
      }
    });
  });
}

const options = parseArgs(process.argv.slice(2));
const packages = readWorkspaceTestPackages().filter((pkg) => !options.exclude.has(pkg.directory));
const shards = shardPackages(packages, options.totalShards);
const selectedPackages = shards[options.shard - 1].packages;

console.log(
  `Running workspace test shard ${options.shard}/${options.totalShards} with ${selectedPackages.length}/${packages.length} packages`,
);
for (const [index, shard] of shards.entries()) {
  console.log(`Shard ${index + 1}: ${shard.packages.map((pkg) => pkg.directory).join(", ")}`);
}

if (options.listOnly) {
  process.exit(0);
}

const results = [];
for (const pkg of selectedPackages) {
  results.push(await runPackageTest(pkg, options.timeoutMinutes));
}

const failures = results.filter((result) => result.status !== "passed");
console.log("\nWorkspace test shard summary:");
for (const result of results) {
  console.log(`${result.status.padEnd(12)} ${result.elapsedSeconds.padStart(6)}s ${result.pkg.directory}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
