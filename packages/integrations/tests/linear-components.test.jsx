/** @jsxImportSource smthrs */
import { afterEach, describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { z } from "zod";
import { Effect } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { runWorkflow } from "smthrs";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { startLinearFixture } from "./linear-fixture.js";
import { configureLinear } from "../src/linear/config.js";
import { linearIssueOutputSchema } from "../src/linear/schemas.js";
import {
  CommentOnIssue,
  CreateIssue,
  OnComment,
  OnIssueCreated,
  OnIssueUpdate,
  UpdateIssue,
} from "../src/linear/components.js";

const API_KEY = "lin_api_component_test";

/** @type {(() => void)[]} */
const cleanups = [];
afterEach(() => {
  configureLinear({});
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

/**
 * @param {() => string} render
 */
function markupOf(render) {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    return render();
  } finally {
    console.error = originalConsoleError;
  }
}

describe("Linear listener components", () => {
  test("OnIssueUpdate renders a WaitForEvent on integration:linear:issue.update with the issue correlation", () => {
    const markup = markupOf(() => renderToStaticMarkup(<OnIssueUpdate id="wait-issue" issueId="ENG-123" />));
    expect(markup).toContain("smithers:wait-for-event");
    expect(markup).toContain("integration:linear:issue.update");
    expect(markup).toContain("ENG-123");
  });
  test("OnIssueUpdate correlates on teamKey when no issueId is given", () => {
    const markup = markupOf(() => renderToStaticMarkup(<OnIssueUpdate id="wait-team" teamKey="ENG" />));
    expect(markup).toContain("integration:linear:issue.update");
    expect(markup).toContain('"ENG"');
  });
  test("OnIssueCreated and OnComment use their event names", () => {
    expect(markupOf(() => renderToStaticMarkup(<OnIssueCreated id="wait-created" teamKey="ENG" />))).toContain(
      "integration:linear:issue.create",
    );
    expect(markupOf(() => renderToStaticMarkup(<OnComment id="wait-comment" issueId="ENG-9" />))).toContain(
      "integration:linear:comment.create",
    );
  });
});

describe("Linear outbound components (compute Tasks)", () => {
  test("CreateIssue executes as a compute task against the real GraphQL fixture", async () => {
    const server = startLinearFixture();
    cleanups.push(() => server.stop());
    const { smithers, Workflow, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
      issue: linearIssueOutputSchema,
    });
    cleanups.push(cleanup);
    const workflow = smithers(() => (
      <Workflow name="linear-create-issue">
        <CreateIssue
          id="create"
          output={outputs.issue}
          config={{ apiKey: API_KEY, apiBaseUrl: server.url }}
          teamKey="ENG"
          title="Component-created issue"
          priority="high"
          stateName="Todo"
        />
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, rootDir: dirname(dbPath) }));
    expect(result.status).toBe("finished");
    const rows = db.select().from(tables.issue).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identifier).toBe("ENG-1");
    const create = server.requests.find((r) => r.operation === "IssueCreate");
    expect(create?.variables["input"]).toMatchObject({
      teamId: "team-eng-id",
      title: "Component-created issue",
      priority: 2,
      stateId: "state-todo",
    });
    expect(create?.authorization).toBe(API_KEY);
  }, 20_000);

  test("deps flow: wrapper resolves deps itself so function children stay compute-kind (Task.js:243-286)", async () => {
    const server = startLinearFixture();
    cleanups.push(() => server.stop());
    const { smithers, Workflow, Task, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
      source: z.object({ title: z.string() }),
      issue: linearIssueOutputSchema,
      comment: z.object({ id: z.string(), body: z.string(), issueId: z.string(), issueIdentifier: z.string() }),
    });
    cleanups.push(cleanup);
    // NOTE: <Task deps> with function children and no agent evaluates
    // children(resolvedDeps) at render time and emits a STATIC task —
    // it would never run our API call. The Linear components therefore
    // resolve deps themselves and hand Task a dep-less function child
    // (compute kind). This test proves that path end-to-end: the
    // upstream output gates the API call, which lands on the fixture.
    const workflow = smithers(() => (
      <Workflow name="linear-deps-flow">
        <Task id="source" output={outputs.source}>
          {{ title: "Issue title from deps" }}
        </Task>
        <CreateIssue
          id="create"
          output={outputs.issue}
          config={{ apiKey: API_KEY, apiBaseUrl: server.url }}
          teamKey="ENG"
          deps={{ source: outputs.source }}
          title={(deps) => deps["source"].title}
        />
        <CommentOnIssue
          id="comment"
          output={outputs.comment}
          config={{ apiKey: API_KEY, apiBaseUrl: server.url }}
          deps={{ issue: outputs.issue }}
          needs={{ issue: "create" }}
          issue={(deps) => deps["issue"].identifier}
          body={(deps) => `Created as ${deps["issue"].identifier}`}
        />
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, rootDir: dirname(dbPath) }));
    expect(result.status).toBe("finished");
    const create = server.requests.find((r) => r.operation === "IssueCreate");
    expect(create?.variables["input"]).toMatchObject({ title: "Issue title from deps" });
    const commentRows = db.select().from(tables.comment).all();
    expect(commentRows[0]?.body).toBe("Created as ENG-1");
    expect(commentRows[0]?.issueIdentifier).toBe("ENG-1");
    const comment = server.requests.find((r) => r.operation === "CommentCreate");
    expect(comment?.variables["input"]?.["body"]).toBe("Created as ENG-1");
  }, 20_000);

  test("UpdateIssue resolves identifiers and state names through the fixture", async () => {
    const server = startLinearFixture();
    cleanups.push(() => server.stop());
    const { smithers, Workflow, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
      issue: linearIssueOutputSchema,
      updated: linearIssueOutputSchema,
    });
    cleanups.push(cleanup);
    configureLinear({ apiKey: API_KEY, apiBaseUrl: server.url });
    const workflow = smithers(() => (
      <Workflow name="linear-update-issue">
        <CreateIssue id="create" output={outputs.issue} teamKey="ENG" title="To be updated" />
        <UpdateIssue
          id="update"
          output={outputs.updated}
          deps={{ issue: outputs.issue }}
          needs={{ issue: "create" }}
          issue={(deps) => deps["issue"].identifier}
          stateName="Done"
        />
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, rootDir: dirname(dbPath) }));
    expect(result.status).toBe("finished");
    const update = server.requests.find((r) => r.operation === "IssueUpdate");
    expect(update?.variables["input"]).toMatchObject({ stateId: "state-done" });
    const rows = db.select().from(tables.updated).all();
    expect(rows[0]?.identifier).toBe("ENG-1");
  }, 20_000);
});
