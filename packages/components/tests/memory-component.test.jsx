/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import React from "react";
import { z } from "zod";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler";
import { Memory, Task } from "../src/components/index.js";
import { Memory as FacadeMemory } from "smithers-orchestrator";

const output = z.object({ value: z.string() });
const agent = { generate: async () => ({ value: "ok" }) };

describe("Memory component", () => {
    test("is exported from components and the smithers facade", () => {
        expect(typeof Memory).toBe("function");
        expect(FacadeMemory).toBe(Memory);
    });

    test("stamps provider defaults onto descendant task descriptors", async () => {
        const renderer = new SmithersRenderer();
        const graph = await renderer.render(
            <Memory bank="project-demo">
                <Task id="work" output={output} agent={agent}>Do work</Task>
            </Memory>,
        );
        expect(graph.tasks[0].memoryConfig).toEqual({
            bank: "project-demo",
            tags: [],
            recall: "auto",
            budget: "mid",
            maxTokens: 2048,
            primers: [],
            retain: "off",
            tools: false,
        });
    });

    test("emits every configured field and inherits omitted nested fields", async () => {
        const renderer = new SmithersRenderer();
        const graph = await renderer.render(
            <Memory
                banks={["user-1", "project-2"]}
                tags={["scope:main", "branch:feature"]}
                recall="release policy"
                budget="high"
                maxTokens={900}
                primers={["user-primer", "project-primer"]}
                retain="on-complete"
                tools
            >
                <Memory recall={false}>
                    <Task id="nested" output={output} agent={agent}>Investigate</Task>
                </Memory>
            </Memory>,
        );
        expect(graph.tasks[0].memoryConfig).toEqual({
            banks: ["user-1", "project-2"],
            tags: ["scope:main", "branch:feature"],
            recall: false,
            budget: "high",
            maxTokens: 900,
            primers: ["user-primer", "project-primer"],
            retain: "on-complete",
            tools: true,
        });
    });

    test("task memory replaces provider memory", async () => {
        const renderer = new SmithersRenderer();
        const override = { bank: "user-1", recall: false, tools: true };
        const graph = await renderer.render(
            <Memory bank="project-2" retain="on-complete">
                <Task id="private" output={output} agent={agent} memory={override}>Review</Task>
            </Memory>,
        );
        expect(graph.tasks[0].memoryConfig).toBe(override);
    });

    test("rejects missing, conflicting, and malformed bank configuration", async () => {
        const cases = [
            <Memory key="missing"><Task id="a" output={output} agent={agent}>A</Task></Memory>,
            <Memory key="conflicting" bank="one" banks={["two"]}><Task id="b" output={output} agent={agent}>B</Task></Memory>,
            <Memory key="empty" banks={[]}><Task id="c" output={output} agent={agent}>C</Task></Memory>,
            <Memory key="malformed" bank="one" tools={/** @type {any} */ ("yes")}><Task id="d" output={output} agent={agent}>D</Task></Memory>,
        ];
        for (const tree of cases) {
            const renderer = new SmithersRenderer();
            await expect(renderer.render(tree)).rejects.toThrow(/Memory/);
        }
    });
});
