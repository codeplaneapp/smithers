import { expect, test } from "bun:test";
import { createExecutableDir, createTempRepo, prependPath, runSmithers, writeExecutable } from "../../../packages/smithers/tests/e2e-helpers.js";

test("gui reports opened only after macOS open exits successfully", () => {
    const repo = createTempRepo();
    repo.write("workspace/.gitkeep", "\n");
    const binDir = createExecutableDir();
    writeExecutable(binDir, "open", [
        "#!/usr/bin/env node",
        'if (process.argv[2] !== "-b") process.exit(64);',
        'if (process.argv[3] !== "com.smithers.SmithersGUI") process.exit(65);',
        'if (!process.argv[4].endsWith("/workspace")) process.exit(66);',
        "",
    ].join("\n"));

    const result = runSmithers(["gui", "workspace"], {
        cwd: repo.dir,
        format: "json",
        env: prependPath(binDir),
    });

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
        opened: repo.path("workspace"),
        bundleId: "com.smithers.SmithersGUI",
    });
});

test("gui returns GUI_LAUNCH_FAILED when macOS open cannot resolve the bundle id", () => {
    const repo = createTempRepo();
    repo.write("workspace/.gitkeep", "\n");
    const binDir = createExecutableDir();
    writeExecutable(binDir, "open", [
        "#!/usr/bin/env node",
        'process.stderr.write("LSCopyApplicationURLsForBundleIdentifier() failed for com.smithers.SmithersGUI\\n");',
        "process.exit(1);",
        "",
    ].join("\n"));

    const result = runSmithers(["gui", "workspace"], {
        cwd: repo.dir,
        format: "json",
        env: prependPath(binDir),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("Opening ");
    expect(result.json).toMatchObject({
        code: "GUI_LAUNCH_FAILED",
    });
    expect(result.stdout).toContain("not installed or not registered with LaunchServices");
    expect(result.stdout).toContain("--bundle-id <actual.bundle.id>");
});
