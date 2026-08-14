import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRuntimeConformance } from "@smthrs/testing/runtimeConformance";
import { runSharedRuntimeFixture } from "./fixture.js";

const dir = await mkdtemp(join(tmpdir(), "smithers-runtime-bun-"));
try {
  const probePath = join(dir, "probe.txt");
  await Bun.write(probePath, "bun");
  const fileText = await Bun.file(probePath).text();
  const processProbe = Bun.spawnSync({ cmd: [process.execPath, "-e", "process.stdout.write('bun')"], stdout: "pipe", stderr: "pipe" });
  const proof = await runSharedRuntimeFixture({ filesystem: fileText === "bun", subprocess: new TextDecoder().decode(processProbe.stdout) === "bun" });
  assertRuntimeConformance(proof, "Bun");
  console.log("Bun runtime conformance passed");
} finally { await rm(dir, { recursive: true, force: true }); }
