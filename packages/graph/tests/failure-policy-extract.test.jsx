import { describe, expect, test } from "bun:test";
import { extractGraph } from "../src/extract.js";
import { extractFromHost } from "../src/dom/extract.js";

function hostEl(tag, rawProps = {}, children = []) {
  const props = {};
  for (const [key, value] of Object.entries(rawProps)) {
    if (["string", "number", "boolean"].includes(typeof value)) props[key] = String(value);
  }
  return { kind: "element", tag, props, rawProps, children };
}

function taskEl(id, rawProps = {}) {
  return hostEl("smithers:task", { id, output: "t", ...rawProps });
}

function byId(result) {
  return new Map(result.tasks.map((task) => [task.nodeId, task]));
}

const extractors = [extractGraph, extractFromHost];

describe.each(extractors)("failurePolicy extraction", (extract) => {
  test("leaves the default unstamped and accepts container policies with nearest override", () => {
    const root = hostEl("smithers:workflow", {}, [
      taskEl("outside"),
      hostEl("smithers:parallel", { id: "p", failurePolicy: "quarantine" }, [
        taskEl("parallel-child"),
        hostEl("smithers:merge-queue", { id: "q", failurePolicy: "halt" }, [taskEl("queue-child")]),
        hostEl("smithers:sequence", { failurePolicy: "quarantine" }, [taskEl("sequence-child")]),
      ]),
    ]);
    const tasks = byId(extract(root));
    expect(tasks.get("outside")?.failurePolicy).toBeUndefined();
    expect(tasks.get("parallel-child")?.failurePolicy).toBe("quarantine");
    expect(tasks.get("queue-child")?.failurePolicy).toBe("halt");
    expect(tasks.get("sequence-child")?.failurePolicy).toBe("quarantine");
  });

  test("task-level policy overrides its inherited container policy", () => {
    const root = hostEl("smithers:workflow", {}, [
      hostEl("smithers:parallel", { failurePolicy: "quarantine" }, [
        taskEl("halt-child", { failurePolicy: "halt" }),
        taskEl("inherited-child"),
      ]),
    ]);
    const tasks = byId(extract(root));
    expect(tasks.get("halt-child")?.failurePolicy).toBe("halt");
    expect(tasks.get("inherited-child")?.failurePolicy).toBe("quarantine");
  });

  test("invalid values retain the inherited policy and do not leak arbitrary strings", () => {
    const root = hostEl("smithers:workflow", {}, [
      hostEl("smithers:parallel", { failurePolicy: "quarantine" }, [
        hostEl("smithers:sequence", { failurePolicy: "bogus" }, [taskEl("child")]),
      ]),
    ]);
    expect(byId(extract(root)).get("child")?.failurePolicy).toBe("quarantine");
  });
});
