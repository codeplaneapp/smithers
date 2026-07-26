import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const BUN_FIXTURE = fileURLToPath(new URL("./fixtures/single-runner-close-exit.fixture.mjs", import.meta.url));
const NODE_FIXTURE = fileURLToPath(new URL("./fixtures/single-runner-close-exit-node.fixture.mjs", import.meta.url));

/**
 * #1378. The bug the reporter hit is a process that never exits, so the only
 * honest test is a real child process that has to die on its own. Neither
 * fixture calls process.exit(); remove the `closeSingleRunnerRuntime()` call
 * from either one and it hangs until this timeout kills it.
 *
 * @param {string[]} command
 * @param {number} timeoutMs
 */
async function runFixtureToExit(command, timeoutMs) {
    const proc = Bun.spawn(command, { stderr: "pipe", stdout: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
    }
    finally {
        clearTimeout(timer);
    }
}

describe("closeSingleRunnerRuntime lets a finite process exit", () => {
    test("a bun child that runs a workflow and closes exits without process.exit", async () => {
        const { exitCode, stdout, stderr } = await runFixtureToExit([process.execPath, BUN_FIXTURE], 120_000);
        expect(stdout).toContain("RUN_FINISHED");
        expect(stdout).toContain("RUNTIME_CLOSED");
        if (exitCode !== 0) {
            throw new Error(`bun child did not exit cleanly (exit ${exitCode}):\n${stderr}\n${stdout}`);
        }
    }, 180_000);

    test("a plain node child that dispatches a task and closes exits without process.exit", async () => {
        const node = Bun.which("node");
        if (!node) return; // CI ships node; skip only where genuinely absent.
        const { exitCode, stdout, stderr } = await runFixtureToExit([node, NODE_FIXTURE], 120_000);
        expect(stdout).toContain("DISPATCH_FINISHED");
        expect(stdout).toContain("RUNTIME_CLOSED");
        if (exitCode !== 0) {
            throw new Error(`node child did not exit cleanly (exit ${exitCode}):\n${stderr}\n${stdout}`);
        }
    }, 180_000);
});
