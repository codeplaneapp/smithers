/** @jsxImportSource smthrs */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { z } from "zod";
import { createSmithers, renderFrame, runWorkflow } from "smthrs";
import { SmithersCtx } from "@smthrs/react-reconciler/context";
import { OnPullRequest, OnWebhook } from "../src/github/components/OnWebhook.js";
import { makeTempDirPath } from "../../testing/src/cleanup/tempDir.ts";
import {
  AddLabels,
  Comment,
  CreateIssue,
  CreatePullRequest,
  SetCommitStatus,
  splitRepo,
} from "../src/github/components/outbound.js";

/** Real GitHub-REST-subset fixture recording every request (no mocks). */
function startFixture() {
  /** @type {{ method: string; path: string; headers: Record<string, string>; body: any }[]} */
  const requests = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "GET" ? null : await request.json().catch(() => null);
      /** @type {Record<string, string>} */
      const headers = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      requests.push({ method: request.method, path: url.pathname, headers, body });
      const json = (payload, status = 201) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.pathname.endsWith("/comments"))
        return json({ id: 42, html_url: "https://github.com/acme/app/issues/7#issuecomment-42" });
      if (url.pathname.endsWith("/labels"))
        return json(
          (body?.labels ?? []).map((name) => ({ name })),
          200,
        );
      if (url.pathname.endsWith("/issues"))
        return json({ number: 101, html_url: "https://github.com/acme/app/issues/101" });
      if (url.pathname.endsWith("/pulls")) return json({ number: 55, html_url: "https://github.com/acme/app/pull/55" });
      if (url.pathname.includes("/statuses/"))
        return json({ state: body?.state, url: `https://api.github.com${url.pathname}` });
      return json({ message: "Not Found" }, 404);
    },
  });
  return { server, requests, url: `http://127.0.0.1:${server.port}` };
}

const fixture = startFixture();
afterAll(() => fixture.server.stop(true));

// Allocated once, at module scope. `makeTempDirPath` arms its drain with a
// `bun:test` hook whenever its registry is empty, and bun runs a hook that was
// registered from inside a running test immediately after that test — which
// empties the registry again, so a per-test allocation re-registers a hook
// inside every single test. That mid-test registration is what intermittently
// stalls a test for the full 5s timeout on CI. One module-scope directory arms
// the drain once, during module evaluation, and never again.
const apiRoot = makeTempDirPath("smithers-gh-");
let apiCount = 0;

function makeApi(schemas) {
  const dir = join(apiRoot, `api-${(apiCount += 1)}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "db.sqlite");
  return { ...createSmithers(schemas, { dbPath }), dbPath };
}

describe("GitHub listener components", () => {
  test("OnWebhook compiles to a WaitForEvent on the per-action signal + repo#number correlation", async () => {
    // Payload schemas must be registered like any other output schema.
    const prSchema = z.object({ action: z.string() }).passthrough();
    const pushSchema = z.object({ ref: z.string() }).passthrough();
    const { smithers, Workflow } = makeApi({ pr: prSchema, push: pushSchema });
    const workflow = smithers(() => (
      <Workflow name="gh-listen">
        <OnWebhook id="pr-opened" event="pull_request" action="opened" repo="acme/app" number={7} schema={prSchema} />
        <OnPullRequest id="pr-any" repo="acme/app" schema={prSchema} />
        <OnWebhook id="anything" event="push" schema={pushSchema} />
      </Workflow>
    ));
    const frame = await Effect.runPromise(
      renderFrame(
        workflow,
        new SmithersCtx({
          runId: "gh-listen",
          iteration: 0,
          input: {},
          outputs: {},
          zodToKeyName: workflow.zodToKeyName,
        }),
      ),
    );
    const byId = Object.fromEntries(frame.tasks.map((task) => [task.nodeId, task]));
    expect(byId["pr-opened"].meta.__eventName).toBe("integration:github:pull_request.opened");
    expect(byId["pr-opened"].meta.__correlationId).toBe("acme/app#7");
    expect(byId["pr-any"].meta.__eventName).toBe("integration:github:pull_request");
    expect(byId["pr-any"].meta.__correlationId).toBe("acme/app");
    expect(byId["anything"].meta.__eventName).toBe("integration:github:push");
    expect(byId["anything"].meta.__correlationId).toBeUndefined();
  });
  test("number without repo is rejected", async () => {
    const schema = z.object({ action: z.string() }).passthrough();
    const { smithers, Workflow } = makeApi({ pr: schema });
    const workflow = smithers(() => (
      <Workflow name="gh-bad">
        <OnWebhook id="bad" event="pull_request" number={7} schema={schema} />
      </Workflow>
    ));
    await expect(
      Effect.runPromise(
        renderFrame(
          workflow,
          new SmithersCtx({
            runId: "gh-bad",
            iteration: 0,
            input: {},
            outputs: {},
            zodToKeyName: workflow.zodToKeyName,
          }),
        ),
      ),
    ).rejects.toThrow(/requires `repo`/);
  });
});

describe("GitHub outbound components (compute Tasks)", () => {
  test("renders as compute kind (not static): computeFn present, no render-time HTTP", async () => {
    const { smithers, Workflow, outputs } = makeApi({
      comment: z.object({ id: z.number(), url: z.string() }),
    });
    const workflow = smithers(() => (
      <Workflow name="gh-kind">
        <Comment
          id="comment"
          output={outputs.comment}
          repo="acme/app"
          number={7}
          body="hi"
          __config={{ token: "t", apiBaseUrl: fixture.url }}
        />
      </Workflow>
    ));
    const before = fixture.requests.length;
    const frame = await Effect.runPromise(
      renderFrame(
        workflow,
        new SmithersCtx({
          runId: "gh-kind",
          iteration: 0,
          input: {},
          outputs: {},
          zodToKeyName: workflow.zodToKeyName,
        }),
      ),
    );
    const task = frame.tasks.find((t) => t.nodeId === "comment");
    expect(task?.kind).toBe("compute");
    expect(typeof task?.computeFn).toBe("function");
    expect(task?.staticPayload).toBeUndefined();
    // Rendering must not perform the HTTP call — execution does.
    expect(fixture.requests.length).toBe(before);
  });
  test("Comment executes at engine time with deps-derived props and records the output row", async () => {
    const api = makeApi({
      target: z.object({ repo: z.string(), number: z.number() }),
      comment: z.object({ id: z.number(), url: z.string() }),
    });
    const { smithers, Workflow, Task, outputs } = api;
    const workflow = smithers(() => (
      <Workflow name="gh-comment">
        <Task id="target" output={outputs.target}>
          {{ repo: "acme/app", number: 7 }}
        </Task>
        <Comment
          id="comment"
          output={outputs.comment}
          deps={{ target: outputs.target }}
          repo={(d) => d.target.repo}
          number={(d) => d.target.number}
          body={(d) => `Deployed ${d.target.repo}#${d.target.number}`}
          __config={{ token: "wf-token", apiBaseUrl: fixture.url }}
        />
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));
    expect(result.status).toBe("finished");
    const recorded = fixture.requests.find((r) => r.path === "/repos/acme/app/issues/7/comments");
    expect(recorded?.method).toBe("POST");
    expect(recorded?.headers.authorization).toBe("Bearer wf-token");
    expect(recorded?.body).toEqual({ body: "Deployed acme/app#7" });
    const sqlite = new Database(api.dbPath, { readonly: true });
    try {
      const rows = sqlite.query("SELECT * FROM comment").all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 42,
        url: "https://github.com/acme/app/issues/7#issuecomment-42",
      });
    } finally {
      sqlite.close();
    }
  }, 20_000);
  test("CreateIssue / CreatePullRequest / AddLabels / SetCommitStatus hit the real REST endpoints", async () => {
    const { smithers, Workflow, outputs } = makeApi({
      issue: z.object({ number: z.number(), url: z.string() }),
      pr: z.object({ number: z.number(), url: z.string() }),
      labels: z.object({ labels: z.string() }),
      status: z.object({ state: z.string(), url: z.string() }),
    });
    const config = { token: "wf-token", apiBaseUrl: fixture.url };
    const workflow = smithers(() => (
      <Workflow name="gh-outbound">
        <CreateIssue
          id="issue"
          output={outputs.issue}
          repo="acme/app"
          title="Flaky test"
          body="Details"
          labels={["bug"]}
          __config={config}
        />
        <CreatePullRequest
          id="pr"
          output={outputs.pr}
          repo="acme/app"
          title="Fix flake"
          head="fix/flake"
          base="main"
          draft
          __config={config}
        />
        <AddLabels
          id="labels"
          output={outputs.labels}
          repo="acme/app"
          number={7}
          labels={["bug", "ci"]}
          __config={config}
        />
        <SetCommitStatus
          id="status"
          output={outputs.status}
          repo="acme/app"
          sha="0f1e2d3c"
          state="success"
          context="smithers/e2e"
          description="all green"
          targetUrl="https://smithers.sh"
          __config={config}
        />
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 4 }));
    expect(result.status).toBe("finished");
    const paths = fixture.requests.map((r) => r.path);
    expect(paths).toContain("/repos/acme/app/issues");
    expect(paths).toContain("/repos/acme/app/pulls");
    expect(paths).toContain("/repos/acme/app/issues/7/labels");
    expect(paths).toContain("/repos/acme/app/statuses/0f1e2d3c");
    const pr = fixture.requests.find((r) => r.path === "/repos/acme/app/pulls");
    expect(pr?.body).toMatchObject({ title: "Fix flake", head: "fix/flake", base: "main", draft: true });
    const status = fixture.requests.find((r) => r.path === "/repos/acme/app/statuses/0f1e2d3c");
    expect(status?.body).toMatchObject({
      state: "success",
      context: "smithers/e2e",
      target_url: "https://smithers.sh",
    });
  }, 20_000);
});

describe("splitRepo", () => {
  test("splits owner/repo and rejects malformed input", () => {
    expect(splitRepo("acme/app")).toEqual({ owner: "acme", name: "app" });
    expect(() => splitRepo("acme")).toThrow(/owner\/repo/);
    expect(() => splitRepo("a/b/c")).toThrow(/owner\/repo/);
  });
});
