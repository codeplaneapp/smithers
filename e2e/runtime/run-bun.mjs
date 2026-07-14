import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRuntimeConformance } from "@smithers-orchestrator/testing/runtimeConformance";
import { runSharedRuntimeFixture } from "./fixture.js";

const dir = await mkdtemp(join(tmpdir(), "smithers-runtime-bun-"));
try {
  await writeFile(join(dir, "probe.txt"), "bun");
  const processProbe = Bun.spawnSync({ cmd: [process.execPath, "-e", "process.stdout.write('bun')"], stdout: "pipe", stderr: "pipe" });
  const proof = await runSharedRuntimeFixture({ filesystem: (await readFile(join(dir, "probe.txt"), "utf8")) === "bun", subprocess: new TextDecoder().decode(processProbe.stdout) === "bun" });
  assertRuntimeConformance(proof, "Bun");
  console.log("Bun runtime conformance passed");
} finally { await rm(dir, { recursive: true, force: true }); }
