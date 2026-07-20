import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const spec = {
    openapi: "3.0.0",
    info: { title: "Pets", version: "1.0.0" },
    servers: [{ url: "https://api.example.test" }],
    paths: {
        "/pets": {
            get: {
                operationId: "listPets",
                summary: "List pets",
                responses: {
                    200: { description: "ok" },
                },
            },
        },
    },
};

describe("smithers openapi generate", () => {
    test("writes an AI SDK tools module using the OpenAPI tool factory", () => {
        const repo = createTempRepo();
        const specPath = repo.write("openapi.json", `${JSON.stringify(spec, null, 2)}\n`);

        const result = runSmithers(["openapi", "generate", specPath, "src/pet-tools.js"], {
            cwd: repo.dir,
            format: null,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Generated 1 OpenAPI tool(s)");
        expect(existsSync(repo.path("src/pet-tools.js"))).toBe(true);

        const generated = readFileSync(repo.path("src/pet-tools.js"), "utf8");
        expect(generated).toContain('new URL("../openapi.json", import.meta.url)');
        expect(generated).toContain('from "smithers-orchestrator/openapi"');
        expect(generated).toContain('export const tools = createOpenApiToolsSync');
        expect(generated).toContain("export default tools;");

        const imported = spawnSync(process.execPath, [
            "--eval",
            'const mod = await import("./src/pet-tools.js"); console.log(JSON.stringify(Object.keys(mod.tools)));',
        ], {
            cwd: repo.dir,
            encoding: "utf8",
        });
        expect(imported.stderr).toBe("");
        expect(imported.status).toBe(0);
        expect(JSON.parse(imported.stdout)).toEqual(["listPets"]);
    });
});
