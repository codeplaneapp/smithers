import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSplit, validateRows } from "./prepare-dataset.mjs";

test("builds Fireworks chat rows from distinct canonical sources", async () => {
  const result = await buildSplit([".smithers/workflows/hello.tsx", ".smithers/workflows/route-task.tsx"], 2, "system");
  assert.equal(result.rows.length, 4);
  assert.deepEqual(
    result.rows[0].messages.map((message) => message.role),
    ["system", "user", "assistant"],
  );
  assert.match(result.rows[0].messages[2].content, /export default/);
  assert.notEqual(result.rows[0].messages[1].content, result.rows[1].messages[1].content);
});

test("rejects malformed or undersized datasets", () => {
  assert.throws(() => validateRows([], "empty"), /at least 3 examples/);
});
