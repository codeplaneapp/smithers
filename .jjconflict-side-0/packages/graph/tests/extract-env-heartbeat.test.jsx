import { describe, expect, test } from "bun:test";

const moduleUrl = new URL("../src/extract.js", import.meta.url).href;

/**
 * @param {string | undefined} envValue
 * @param {string} body
 * @returns {number}
 */
function heartbeatFromFreshProcess(envValue, body) {
    const proc = Bun.spawnSync({
        cmd: [process.execPath, "--eval", body],
        env: {
            ...process.env,
            ...(envValue === undefined ? {} : { SMITHERS_TASK_HEARTBEAT_MS: envValue }),
            GRAPH_EXTRACT_MODULE_URL: moduleUrl,
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    return Number(new TextDecoder().decode(proc.stdout).trim());
}

const agentHeartbeatScript = `
const { extractGraph } = await import(process.env.GRAPH_EXTRACT_MODULE_URL);
const task = extractGraph({
  kind: "element",
  tag: "smithers:task",
  props: {},
  rawProps: {
    id: "agent",
    output: "out",
    __smithersKind: "agent",
    agent: { generate: async () => ({}) }
  },
  children: []
}).tasks[0];
console.log(task.heartbeatTimeoutMs);
`;

const sandboxHeartbeatScript = `
const { extractGraph } = await import(process.env.GRAPH_EXTRACT_MODULE_URL);
const task = extractGraph({
  kind: "element",
  tag: "smithers:sandbox",
  props: {},
  rawProps: { id: "sandbox", output: "out" },
  children: []
}).tasks[0];
console.log(task.heartbeatTimeoutMs);
`;

const explicitHeartbeatScript = `
const { extractGraph } = await import(process.env.GRAPH_EXTRACT_MODULE_URL);
const task = extractGraph({
  kind: "element",
  tag: "smithers:task",
  props: {},
  rawProps: {
    id: "agent",
    output: "out",
    __smithersKind: "agent",
    agent: { generate: async () => ({}) },
    heartbeatTimeoutMs: 42.8
  },
  children: []
}).tasks[0];
console.log(task.heartbeatTimeoutMs);
`;

describe("extractGraph heartbeat env defaults", () => {
    test("uses a positive integer SMITHERS_TASK_HEARTBEAT_MS for agent task defaults", async () => {
        expect(heartbeatFromFreshProcess("1234.9", agentHeartbeatScript)).toBe(1234);
    });

    test("falls back to the default heartbeat for empty, non-finite, and non-positive env values", async () => {
        for (const raw of ["", "not-a-number", "Infinity", "0", "-1"]) {
            expect(heartbeatFromFreshProcess(raw, sandboxHeartbeatScript)).toBe(600_000);
        }
    });

    test("explicit heartbeatTimeoutMs overrides the environment default", async () => {
        expect(heartbeatFromFreshProcess("9999", explicitHeartbeatScript)).toBe(42);
    });
});
