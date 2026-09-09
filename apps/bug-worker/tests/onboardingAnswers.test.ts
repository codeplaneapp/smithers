import { expect, test } from "bun:test";
import { createBugWorker } from "../src/worker.ts";
import { memoryKv } from "./helpers/memoryKv.ts";

test("answers persist privately and retries retain one record", async () => {
  const env = { BUGS: memoryKv(), BUG_ADMIN_TOKEN: "operator" };
  const worker = createBugWorker();
  const url = "https://bug.smithers.sh/api/onboarding-answers";
  const id = crypto.randomUUID();
  const submit = (heard: string) => worker.fetch(new Request(url, { method: "POST", body: JSON.stringify({ id, heard, project: "A garden" }) }), env);
  expect((await submit("A friend")).status).toBe(200);
  expect((await submit("A post")).status).toBe(200);
  expect((await worker.fetch(new Request(url), env)).status).toBe(404);
  const response = await worker.fetch(new Request(url, { headers: { "x-bug-admin": "operator" } }), env);
  const body = await response.json() as { answers: { heard: string }[] };
  expect(body.answers).toHaveLength(1);
  expect(body.answers[0]?.heard).toBe("A post");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await submit("x".repeat(501))).status).toBe(400);
});

test("failed storage never reports success", async () => {
  const kv = memoryKv();
  const env = { BUGS: { ...kv, put: async (key: string, value: string) => { if (key.startsWith("onboarding:")) throw Error("offline"); await kv.put(key, value); } }, BUG_ADMIN_TOKEN: "test" };
  const response = await createBugWorker().fetch(new Request("https://bug.smithers.sh/api/onboarding-answers", { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), heard: "friend", project: "" }) }), env);
  expect(response.status).toBe(503);
});
