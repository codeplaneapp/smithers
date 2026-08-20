import { afterEach, describe, expect, test } from "bun:test";
import * as ModelEvent from "@flows/model/ModelEvent";
import { Stream } from "effect";
import { z } from "zod";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIAgent } from "../src/index.js";

const temporary = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const cellEvents = (source) => Stream.fromIterable([
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: `\`\`\`cell\n${source}\n\`\`\`` }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" }),
]);

describe("built-in cell agent acceptance", () => {
  test("edits a file, runs a command, and returns structured output on the cell loop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smithers-cell-"));
    temporary.push(directory);
    const file = join(directory, "result.txt");
    const source = [
      `await ctx.call("write", { path: ${JSON.stringify(file)}, content: "cell loop\\n" })`,
      `const command = await ctx.call("bash", { mode: "unhermetic", command: ${JSON.stringify(`wc -c < ${file}`)}, cwd: ${JSON.stringify(directory)} })`,
      "return { intent: \"complete\", state: { edited: true }, output: JSON.stringify({ edited: true, bytes: Number(command.stdout.trim()) }) }",
    ].join("\n");
    const requests = [];
    const model = { stream(request) { requests.push(request); return cellEvents(source); } };

    const result = await new OpenAIAgent({ model, modelId: "cell-only" }).generate({
      prompt: "Edit the file, run the command, and report the result.",
      outputSchema: z.object({ edited: z.boolean(), bytes: z.number() }),
    });

    expect(result.output).toEqual({ edited: true, bytes: 10 });
    expect(await readFile(file, "utf8")).toBe("cell loop\n");
    expect(result.toolResults.map((entry) => entry.toolName)).toEqual(["write", "bash"]);
    expect(requests).toHaveLength(1);
    expect(requests[0].system.some((part) => part.text.includes("ctx.call"))).toBe(true);
  });
});
