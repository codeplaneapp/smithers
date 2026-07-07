import { describe, expect, test } from "bun:test";

const ENGINE_URL = new URL("../src/engine.js", import.meta.url).href;

describe("engine node-load regression", () => {
    // Node lacks bun:sqlite, exactly like a Vercel Node function / Lambda.
    // Before the residual static bun:sqlite chains were de-static-ized (the
    // static `bun:sqlite` / `drizzle-orm/bun-sqlite` imports in
    // effect/builder.js and the static `@effect/sql-sqlite-bun/SqliteClient`
    // import in effect/single-runner.js), importing engine.js under plain Node
    // threw "Received protocol 'bun:'" at load — so the engine could not run
    // on Node serverless hosts at all. This guards that the full transitive
    // import graph of engine.js stays loadable under plain Node.
    test("engine.js imports cleanly under plain node", () => {
        const node = Bun.which("node");
        if (!node) return; // CI clean box ships node; skip only where genuinely absent.
        const code = `
      const m = await import(${JSON.stringify(ENGINE_URL)});
      if (typeof m.runWorkflow !== "function") { console.error("runWorkflow missing:", typeof m.runWorkflow); process.exit(2); }
      console.log("LOADS");
    `;
        const proc = Bun.spawnSync([node, "--input-type=module", "-e", code], { stderr: "pipe", stdout: "pipe" });
        if (proc.exitCode !== 0) {
            throw new Error(`node import of engine.js failed (exit ${proc.exitCode}): ${proc.stderr.toString()}`);
        }
        expect(proc.stdout.toString()).toContain("LOADS");
    });
});
