import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertRuntimeConformance } from "@smthrs/testing/runtimeConformance";
import { runSharedRuntimeFixture } from "./fixture.js";

const exec = promisify(execFile);
const embeddedExample = fileURLToPath(new URL("../../examples/node-embedded-engine.mjs", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "smithers-runtime-node-"));
try {
  await writeFile(join(dir, "probe.txt"), "node");
  const file = await readFile(join(dir, "probe.txt"), "utf8");
  const processProbe = await exec(process.execPath, ["-e", "process.stdout.write('node')"]);
  const proof = await runSharedRuntimeFixture({ filesystem: file === "node", subprocess: processProbe.stdout === "node" });
  assertRuntimeConformance(proof, "Node.js");
  const embedded = await exec(process.execPath, [embeddedExample], { timeout: 180_000 });
  const embeddedProof = JSON.parse(embedded.stdout.trim());
  if (embeddedProof.status !== "ok" || embeddedProof.runs?.length !== 2 || embeddedProof.logRecords < 1) {
    throw new Error(`embedded engine conformance failed: ${embedded.stdout}`);
  }
  if (!embeddedProof.causeChain?.some((message) => message.includes("connection refused"))) {
    throw new Error(`embedded engine lost error cause: ${embedded.stdout}`);
  }
  console.log("Node.js runtime conformance passed");
} finally { await rm(dir, { recursive: true, force: true }); }
