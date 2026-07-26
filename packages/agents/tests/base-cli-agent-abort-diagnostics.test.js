import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { BaseCliAgent } from "../src/BaseCliAgent/index.js";

class AbortableCodexAgent extends BaseCliAgent {
  async buildCommand() {
    return {
      command: "codex",
      args: [],
    };
  }
}

describe("BaseCliAgent abort diagnostics", () => {
  test("does not attach secondary diagnostic failures after a Codex abort", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "smithers-abort-codex-bin-"));
    const codexHome = mkdtempSync(join(tmpdir(), "smithers-abort-codex-home-"));
    try {
      const codexBin = join(binDir, "codex");
      writeFileSync(codexBin, [`#!${process.execPath}`, "setTimeout(() => {}, 60_000);", ""].join("\n"));
      chmodSync(codexBin, 0o755);

      const controller = new AbortController();
      const agent = new AbortableCodexAgent({
        id: "abort-codex-test",
        inheritEnv: false,
        env: {
          CODEX_HOME: codexHome,
          PATH: `${binDir}:/usr/bin:/bin`,
        },
      });

      let error;
      try {
        await agent.generate({
          prompt: "abort",
          abortSignal: controller.signal,
          onProcess: (event) => {
            if (event.phase === "started") controller.abort();
          },
        });
        expect.unreachable("should have aborted");
      } catch (cause) {
        error = cause;
      }

      expect(error).toBeInstanceOf(SmithersError);
      expect(error.code).toBe("PROCESS_ABORTED");
      expect(error.details?.diagnostics).toBeUndefined();
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
