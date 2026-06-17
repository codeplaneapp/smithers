import { afterEach, describe, expect, test } from "bun:test";
import { approve } from "../src/api/approve.js";
import { cancel } from "../src/api/cancel.js";
import { deny } from "../src/api/deny.js";
import { getFrames } from "../src/api/getFrames.js";
import { getStatus } from "../src/api/getStatus.js";
import { listRuns } from "../src/api/listRuns.js";
import { resume } from "../src/api/resume.js";
import { runWorkflow } from "../src/api/runWorkflow.js";
import { SmithersPiHttpClient } from "../src/api/SmithersPiHttpClient.js";
import { streamEvents } from "../src/api/streamEvents.js";

const realFetch = globalThis.fetch;

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

function installJsonFetch(responseBody: unknown = { ok: true }) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      json: async () => responseBody,
    } as Response;
  }) as typeof fetch;
  return calls;
}

function parsedBody(call: FetchCall) {
  return JSON.parse(String(call.init?.body));
}

describe("SmithersPiHttpClient.json", () => {
  test("uses the default base URL and GET without JSON headers or body", async () => {
    const calls = installJsonFetch({ ready: true });

    const result = await new SmithersPiHttpClient().json("/v1/runs");

    expect(result).toEqual({ ready: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:7331/v1/runs");
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.headers).toEqual({});
    expect(calls[0].init?.body).toBeUndefined();
  });

  test("serializes JSON bodies and includes content-type plus bearer auth", async () => {
    const calls = installJsonFetch();

    await new SmithersPiHttpClient({
      baseUrl: "http://pi.local",
      apiKey: "secret-key",
    }).json("/v1/runs", {
      method: "POST",
      body: { workflowPath: "flow.ts", input: { value: 1 } },
    });

    expect(calls[0].url).toBe("http://pi.local/v1/runs");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer secret-key",
    });
    expect(parsedBody(calls[0])).toEqual({
      workflowPath: "flow.ts",
      input: { value: 1 },
    });
  });

  test("throws a SmithersError with HTTP context on non-ok responses", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 418,
      text: async () => "teapot",
    })) as typeof fetch;

    await expect(
      new SmithersPiHttpClient({ baseUrl: "http://pi.local" }).json("/bad"),
    ).rejects.toMatchObject({
      name: "SmithersError",
      code: "PI_HTTP_ERROR",
      summary: "Smithers HTTP 418: teapot",
      details: {
        baseUrl: "http://pi.local",
        path: "/bad",
        status: 418,
      },
    });
  });

  test("omits response text from HTTP errors when reading the body fails", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("unreadable");
      },
    })) as typeof fetch;

    await expect(new SmithersPiHttpClient().json("/broken")).rejects.toMatchObject({
      code: "PI_HTTP_ERROR",
      summary: "Smithers HTTP 500",
    });
  });
});

describe("pi-plugin api wrappers", () => {
  test("approve posts a default iteration and optional note to the node approval endpoint", async () => {
    const calls = installJsonFetch();

    await approve({
      baseUrl: "http://pi.local",
      apiKey: "token",
      runId: "run-1",
      nodeId: "node-a",
      note: "ship it",
    });

    expect(calls[0].url).toBe(
      "http://pi.local/v1/runs/run-1/nodes/node-a/approve",
    );
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer token",
    });
    expect(parsedBody(calls[0])).toEqual({ iteration: 0, note: "ship it" });
  });

  test("deny posts an explicit iteration to the node denial endpoint", async () => {
    const calls = installJsonFetch();

    await deny({
      baseUrl: "http://pi.local",
      runId: "run-1",
      nodeId: "node-a",
      iteration: 3,
    });

    expect(calls[0].url).toBe("http://pi.local/v1/runs/run-1/nodes/node-a/deny");
    expect(calls[0].init?.method).toBe("POST");
    expect(parsedBody(calls[0])).toEqual({ iteration: 3 });
  });

  test("cancel posts an empty JSON object to the run cancel endpoint", async () => {
    const calls = installJsonFetch();

    await cancel({ baseUrl: "http://pi.local", runId: "run-1" });

    expect(calls[0].url).toBe("http://pi.local/v1/runs/run-1/cancel");
    expect(calls[0].init?.method).toBe("POST");
    expect(parsedBody(calls[0])).toEqual({});
  });

  test("getStatus fetches the run status resource", async () => {
    const calls = installJsonFetch({ status: "running" });

    const result = await getStatus({ baseUrl: "http://pi.local", runId: "run-1" });

    expect(result).toEqual({ status: "running" });
    expect(calls[0].url).toBe("http://pi.local/v1/runs/run-1");
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.body).toBeUndefined();
  });

  test("getFrames defaults to a 20-frame tail and honors explicit tail limits", async () => {
    const calls = installJsonFetch();

    await getFrames({ baseUrl: "http://pi.local", runId: "run-1" });
    await getFrames({ baseUrl: "http://pi.local", runId: "run-1", tail: 5 });

    expect(calls.map((call) => call.url)).toEqual([
      "http://pi.local/v1/runs/run-1/frames?limit=20",
      "http://pi.local/v1/runs/run-1/frames?limit=5",
    ]);
  });

  test("listRuns omits an empty query and includes provided limit/status filters", async () => {
    const calls = installJsonFetch();

    await listRuns({ baseUrl: "http://pi.local" });
    await listRuns({ baseUrl: "http://pi.local", limit: 10, status: "waiting" });

    expect(calls.map((call) => call.url)).toEqual([
      "http://pi.local/v1/runs",
      "http://pi.local/v1/runs?limit=10&status=waiting",
    ]);
  });

  test("resume starts a run with resume=true and no input payload", async () => {
    const calls = installJsonFetch();

    await resume({
      baseUrl: "http://pi.local",
      workflowPath: "workflow.ts",
      runId: "run-1",
    });

    expect(calls[0].url).toBe("http://pi.local/v1/runs");
    expect(calls[0].init?.method).toBe("POST");
    expect(parsedBody(calls[0])).toEqual({
      workflowPath: "workflow.ts",
      runId: "run-1",
      resume: true,
    });
  });

  test("runWorkflow starts a new run with input and optional runId", async () => {
    const calls = installJsonFetch();

    await runWorkflow({
      baseUrl: "http://pi.local",
      workflowPath: "workflow.ts",
      input: { answer: 42 },
      runId: "run-1",
    });

    expect(calls[0].url).toBe("http://pi.local/v1/runs");
    expect(calls[0].init?.method).toBe("POST");
    expect(parsedBody(calls[0])).toEqual({
      workflowPath: "workflow.ts",
      input: { answer: 42 },
      runId: "run-1",
    });
  });

  test("streamEvents delegates to the run event stream endpoint", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"kind":"started"}\n\n'));
        controller.close();
      },
    });
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, body: stream } as Response;
    }) as typeof fetch;

    const events: unknown[] = [];
    for await (const event of streamEvents({
      baseUrl: "http://pi.local",
      apiKey: "token",
      runId: "run-1",
    })) {
      events.push(event);
    }

    expect(events).toEqual([{ kind: "started" }]);
    expect(calls[0].url).toBe("http://pi.local/v1/runs/run-1/events");
    expect(calls[0].init?.headers).toEqual({ Authorization: "Bearer token" });
  });
});
