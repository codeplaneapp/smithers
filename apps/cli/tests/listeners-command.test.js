import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runCli(root, args, env) {
  const proc = Bun.spawn([process.execPath, "run", CLI_ENTRY, ...args], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("listeners command", () => {
  test("plans by default and mutates only with explicit apply", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-listeners-cli-"));
    roots.push(root);
    mkdirSync(join(root, ".smithers"));
    writeFileSync(
      join(root, ".smithers/listeners.json"),
      JSON.stringify({
        version: 1,
        listeners: [
          {
            id: "issues",
            provider: "github",
            repository: "acme/app",
            events: ["issues"],
            workflow: "issues",
            callbackUrl: "https://gateway.example/webhooks/issues",
            secretEnv: "CLI_WEBHOOK_SECRET",
          },
        ],
      }),
    );
    let hooks = [];
    const methods = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        methods.push(request.method);
        if (request.method === "GET") return Response.json(hooks);
        if (request.method === "POST") {
          const body = await request.json();
          hooks = [{ id: 7, active: body.active, events: body.events, config: { ...body.config, secret: undefined } }];
          return Response.json(hooks[0], { status: 201 });
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
      },
    });
    try {
      const env = {
        SMITHERS_GITHUB_TOKEN: "cli-token",
        SMITHERS_GITHUB_API_BASE_URL: `http://127.0.0.1:${server.port}`,
        CLI_WEBHOOK_SECRET: "cli-secret",
      };
      const planned = await runCli(root, ["listeners", "plan", "--json"], env);
      expect(planned.exitCode).toBe(0);
      expect(JSON.parse(planned.stdout).mode).toBe("plan");
      expect(methods).toEqual(["GET"]);

      const applied = await runCli(root, ["listeners", "apply", "--json"], env);
      expect(applied.exitCode).toBe(0);
      expect(JSON.parse(applied.stdout).applied).toHaveLength(1);
      expect(methods.filter((method) => method === "POST")).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });
});
