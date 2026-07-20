import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertRuntimeConformance } from "@smithers-orchestrator/testing/runtimeConformance";
import { runSharedRuntimeFixture } from "./fixture.js";

const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), "smithers-runtime-node-"));
try {
  await writeFile(join(dir, "probe.txt"), "node");
  const file = await readFile(join(dir, "probe.txt"), "utf8");
  const processProbe = await exec(process.execPath, ["-e", "process.stdout.write('node')"]);
  const proof = await runSharedRuntimeFixture({ filesystem: file === "node", subprocess: processProbe.stdout === "node" });
  assertRuntimeConformance(proof, "Node.js");
  console.log("Node.js runtime conformance passed");
} finally { await rm(dir, { recursive: true, force: true }); }
