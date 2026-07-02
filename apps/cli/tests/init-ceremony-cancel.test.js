import { expect, test } from "bun:test";
import { runInitCeremony } from "../src/initCeremony.js";

// A cancelled wizard used to `process.exit(0)` silently: the renderer had wiped
// the screen, so the user saw nothing and wrapping scripts read the cancelled
// run as success. It must now print a notice and exit non-zero (130).
test("runInitCeremony exits 130 with a notice when the wizard is cancelled", async () => {
    const errs = [];
    const originalWrite = process.stderr.write;
    const originalExit = process.exit;
    process.stderr.write = (chunk) => {
        errs.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
    };
    let exitCode;
    // @ts-expect-error test stub throws instead of terminating the runner
    process.exit = (code) => {
        exitCode = code;
        throw new Error("__process_exit__");
    };
    try {
        await runInitCeremony({ env: {}, runWizard: async () => null });
        throw new Error("expected runInitCeremony to exit on cancel");
    } catch (err) {
        if (err.message !== "__process_exit__") throw err;
    } finally {
        process.stderr.write = originalWrite;
        process.exit = originalExit;
    }
    expect(exitCode).toBe(130);
    expect(errs.join("")).toContain("init cancelled");
});
